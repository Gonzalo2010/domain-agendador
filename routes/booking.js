// routes/booking.js
import express from 'express';
import { createClient } from '@supabase/supabase-js';

// ---- Config ----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const router = express.Router();

// Utilidades tiempo
function toDateInTZ(dateStr, tz) {
  // Creamos Date UTC de 00:00 en tz dado
  const d = new Date(`${dateStr}T00:00:00`);
  // A efectos prácticos en ES, tratamos como local y usamos intervalos [startOfDay, endOfDay)
  return d;
}
function startOfDay(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`);
}
function endOfDay(dateStr) {
  return new Date(`${dateStr}T23:59:59.999Z`);
}
function addMinutes(d, m){ return new Date(d.getTime() + m*60000); }
function sameHalfHour(d){
  // Redondea “h:mm” a “h:00” o “h:30” hacia arriba si venía algo raro
  const dt = new Date(d);
  const mins = dt.getUTCMinutes();
  const rounded = mins < 30 ? 0 : 30;
  dt.setUTCMinutes(rounded, 0, 0);
  return dt;
}
function* halfHourSteps(start, end){
  let t = new Date(start);
  t = sameHalfHour(t);
  while (t < end) {
    yield new Date(t);
    t = addMinutes(t, 30);
  }
}
function overlaps(aStart, aEnd, bStart, bEnd){
  return aStart < bEnd && aEnd > bStart;
}

// Lee duración servicio y lista de empleados asociados
async function getServiceAndEmployees(serviceId){
  const { data: service, error: es } = await sb.from('services').select('id, org_id, name, duration_min').eq('id', serviceId).single();
  if (es) throw es;
  const { data: links, error: el } = await sb.from('employee_services').select('employee_id').eq('service_id', serviceId);
  if (el) throw el;
  const empIds = links.map(l => l.employee_id);
  const { data: employees, error: ee } = await sb.from('employees')
    .select('id, org_id, location_id, name, color_hex, active')
    .in('id', empIds).eq('active', true);
  if (ee) throw ee;
  return { service, employees };
}

// Horario negocio por día (location_id requerido idealmente; hacemos “best effort”)
async function getBusinessWindow(org_id, location_id, dateStr){
  const d = new Date(dateStr + 'T12:00:00Z');
  const weekday = (d.getUTCDay()+6)%7; // 0 lunes ... 6 domingo
  let open = null, close = null;

  if (location_id){
    const { data: bh } = await sb.from('business_hours')
      .select('open_time, close_time, active')
      .eq('org_id', org_id).eq('location_id', location_id).eq('weekday', weekday).eq('active', true).maybeSingle();
    if (bh){
      open = new Date(`${dateStr}T${bh.open_time}Z`);
      close = new Date(`${dateStr}T${bh.close_time}Z`);
    }
  }
  if (!open || !close){
    // Fallback: 09:00-21:00
    open = new Date(`${dateStr}T09:00:00Z`);
    close = new Date(`${dateStr}T21:00:00Z`);
  }
  return { open, close };
}

// Disponibilidad de empleado ese día (staff_availability)
async function getEmployeeDailySchedule(emp, dateStr, bizOpen, bizClose){
  const d = new Date(dateStr + 'T12:00:00Z');
  const weekday = (d.getUTCDay()+6)%7;

  const { data: rows } = await sb.from('staff_availability')
    .select('start_time, end_time, active')
    .eq('org_id', emp.org_id).eq('employee_id', emp.id).eq('weekday', weekday).eq('active', true);

  // Intersección con business hours
  const spans = (rows||[]).map(r => {
    const s = new Date(`${dateStr}T${r.start_time}Z`);
    const e = new Date(`${dateStr}T${r.end_time}Z`);
    return { start_at: (s>bizOpen?s:bizOpen), end_at: (e<bizClose?e:bizClose) };
  }).filter(r => r.end_at > r.start_at);

  return spans;
}

// Citas, bloques y ausencias del empleado en ese día
async function getBusyForEmployee(emp, dateStr){
  const dayStart = startOfDay(dateStr), dayEnd = endOfDay(dateStr);

  const { data: appts } = await sb.from('appointments')
    .select('start_at, end_at, status, employee_id')
    .eq('employee_id', emp.id)
    .gte('start_at', dayStart.toISOString())
    .lte('start_at', dayEnd.toISOString())
    .in('status', ['booked','confirmed']);

  const { data: offs } = await sb.from('staff_time_off')
    .select('starts_at, ends_at')
    .eq('employee_id', emp.id)
    .lte('starts_at', dayEnd.toISOString())
    .gte('ends_at', dayStart.toISOString());

  const { data: blocks } = await sb.from('blocks')
    .select('starts_at, ends_at, employee_id')
    .eq('org_id', emp.org_id)
    .eq('location_id', emp.location_id)
    .or(`employee_id.is.null,employee_id.eq.${emp.id}`)
    .lte('starts_at', dayEnd.toISOString())
    .gte('ends_at', dayStart.toISOString());

  const busy = [];
  (appts||[]).forEach(a => busy.push({ start_at:new Date(a.start_at), end_at:new Date(a.end_at), type:'appt' }));
  (offs||[]).forEach(o => busy.push({ start_at:new Date(o.starts_at), end_at:new Date(o.ends_at), type:'off' }));
  (blocks||[]).forEach(b => busy.push({ start_at:new Date(b.starts_at), end_at:new Date(b.ends_at), type:'block' }));
  return { appts: appts||[], busy };
}

// Genera huecos para un empleado concreto a intervalos de 30 min
function buildSlotsForEmployee(emp, scheduleSpans, busy, dateStr, durationMin, labelName){
  const slots = [];
  for (const span of scheduleSpans){
    for (const t of halfHourSteps(span.start_at, span.end_at)){
      const start = t;
      const end = addMinutes(start, durationMin);
      if (end > span.end_at) continue;

      // choque con busy?
      const conflict = busy.some(b => overlaps(start, end, b.start_at, b.end_at));
      if (conflict) continue;

      slots.push({
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        employee_id: emp.id,
        employee_name: labelName || emp.name,
        any: false,
        free_employees: 1
      });
    }
  }
  return slots;
}

// Unión de huecos "sin preferencia": para cada hh:00/hh:30, si hay al menos 1 libre, lo devolvemos con un empleado sugerido
function buildAnySlots(allEmpSlots, durationMin){
  // Indexamos por start_at ISO
  const map = new Map();
  for (const s of allEmpSlots){
    const key = s.start_at;
    const curr = map.get(key);
    if (!curr) {
      map.set(key, { ...s, any:true, free_employees:1 });
    } else {
      curr.free_employees += 1;
      // Mantenemos el primero como sugerido
    }
  }
  return Array.from(map.values()).sort((a,b)=>a.start_at.localeCompare(b.start_at));
}

// ---------------- API ----------------
router.get('/api/slots', async (req, res)=>{
  try {
    const { serviceId, employeeId='any', date, tz='Europe/Madrid' } = req.query;
    if (!serviceId || !date) return res.status(400).json({ ok:false, error:'Faltan parámetros' });

    const { service, employees } = await getServiceAndEmployees(serviceId);
    if (!employees.length) return res.json({ ok:true, slots:[], schedule:[], appointments:[], meta:{ employees:[], free_employees:0 } });

    // Usamos la primera location de los empleados para business hours (si están mezclados, es un edge)
    const firstLoc = employees.find(e=>e.location_id)?.location_id || null;
    const { open: bizOpen, close: bizClose } = await getBusinessWindow(service.org_id, firstLoc, date);

    // Específico
    if (employeeId !== 'any'){
      const emp = employees.find(e => e.id === employeeId);
      if (!emp) return res.json({ ok:true, slots:[], schedule:[], appointments:[], meta:{ employees:employees.map(e=>e.id), free_employees:0 } });

      const schedule = await getEmployeeDailySchedule(emp, date, bizOpen, bizClose);
      const { appts, busy } = await getBusyForEmployee(emp, date);
      const slots = buildSlotsForEmployee(emp, schedule, busy, date, service.duration_min, emp.name);

      return res.json({
        ok:true,
        slots,
        schedule: schedule.map(s=>({ start_at:s.start_at.toISOString(), end_at:s.end_at.toISOString() })),
        appointments: appts.map(a=>({ start_at:a.start_at, end_at:a.end_at })),
        meta:{ employees: employees.map(e=>({id:e.id,name:e.name})), free_employees:1 }
      });
    }

    // Sin preferencia: generamos para todos y hacemos unión
    const allSlots = [];
    for (const emp of employees){
      const schedule = await getEmployeeDailySchedule(emp, date, bizOpen, bizClose);
      const { busy } = await getBusyForEmployee(emp, date);
      const slots = buildSlotsForEmployee(emp, schedule, busy, date, service.duration_min, emp.name);
      allSlots.push(...slots);
    }
    const anySlots = buildAnySlots(allSlots, service.duration_min);

    return res.json({
      ok:true,
      slots: anySlots,
      schedule: [], // no aplica a “any”
      appointments: [],
      meta:{ employees: employees.map(e=>({id:e.id,name:e.name})), free_employees: employees.length }
    });
  } catch (e){
    console.error(e);
    res.status(500).json({ ok:false, error: e.message || 'Error interno' });
  }
});

export default router;
