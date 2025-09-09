// index.mjs — multi-tenant con slug por defecto (sin landing)

// --- IMPORTS ---
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import fsp from 'fs/promises';

// WhatsApp (Baileys)
import makeWASocket, {
  useMultiFileAuthState, Browsers, DisconnectReason
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode';

// --- CONFIG EN TEXTO CLARO (ajusta a lo tuyo) ---
const CONFIG = {
  PORT: 80,

  // Supabase
  SUPABASE_URL: 'https://qjyowonpjkhsxnktzimq.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFqeW93b25wamtoc3hua3R6aW1xIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NzAwMTUxOSwiZXhwIjoyMDcyNTc3NTE5fQ.JgXme8pZ8uXtJ51rdNShD4cDyN6CPC4cqhhzMr1PyHA', // <-- asegúrate de poner la tuya
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFqeW93b25wamtoc3hua3R6aW1xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcwMDE1MTksImV4cCI6MjA3MjU3NzUxOX0.3S37zQaSqgBBa80U_J4lxtqBe1ihlvIeBwaGYfxfnS0',                 // (usaremos service role si está)

  // Email (Resend)
  RESEND_API_KEY: 're_BqqPZu9L_5sijn76uvP872TpYVnfWq6EM',
  MAIL_FROM_EMAIL: 'notifications@mail.agendador.es',
  MAIL_FROM_NAME: 'Agendador',

  // Seguridad de cookies
  SESSION_SECRET: 'cambia_esto_por_un_secreto_serio',

  // WhatsApp / QR
  QR_DIR: '/tmp',

  // OTP
  OTP_LENGTH: 6,

  // Org por defecto (para root domain, api.*, etc.)
  DEFAULT_ORG_SLUG: 'agendador',
};

// --- RUNTIME BASICS ---
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // detrás de Cloudflare/Nginx
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(CONFIG.SESSION_SECRET || 'dev-secret'));

// === Supabase ===
const SUPABASE_KEY = CONFIG.SUPABASE_SERVICE_ROLE_KEY || CONFIG.SUPABASE_ANON_KEY;
if (!CONFIG.SUPABASE_URL || !SUPABASE_KEY) { 
  console.error('Faltan SUPABASE_URL o KEY en CONFIG'); 
  process.exit(1); 
}
const supabase = createClient(CONFIG.SUPABASE_URL, SUPABASE_KEY);

// === WhatsApp + QR ===
let wa = null; let waReady = false; let waQR = null;
const QR_PATH = path.join(CONFIG.QR_DIR, 'qr.png');

async function ensureQrDir(){ try{ await fsp.mkdir(CONFIG.QR_DIR,{recursive:true}); }catch{} }
async function writeQrPng(qr){
  await ensureQrDir();
  const buf = await qrcode.toBuffer(qr, { type:'png', width:512, errorCorrectionLevel:'M' });
  await fsp.writeFile(QR_PATH, buf);
  console.log('[WA] QR actualizado:', QR_PATH);
}
async function deleteQrPng(){ try{ await fsp.unlink(QR_PATH); }catch{} }

async function startWhatsApp(){
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname,'baileys_auth'));
  wa = makeWASocket({ auth: state, printQRInTerminal:false, browser: Browsers.appropriate('Agendador') });
  wa.ev.on('creds.update', saveCreds);
  wa.ev.on('connection.update', (u)=>{
    const { connection, lastDisconnect, qr } = u;
    if (qr) { waQR=qr; waReady=false; writeQrPng(qr).catch(console.error); }
    if (connection==='open'){ waReady=true; waQR=null; deleteQrPng().catch(()=>{}); console.log('[WA] Conectado'); }
    if (connection==='close'){
      waReady=false;
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[WA] Cerrado. Reintentar:', shouldReconnect);
      if (shouldReconnect) startWhatsApp().catch(console.error);
    }
  });
}
async function sendWhatsAppMessage(phone, text){
  if (!wa) await startWhatsApp();
  if (!waReady) throw new Error('WhatsApp no conectado. Abre /whatsapp/qr o /qr.png');
  const digits = String(phone).replace(/\D/g,'');
  await wa.sendMessage(`${digits}@s.whatsapp.net`, { text });
}

// === HELPERS ===
const reserved = new Set(['www']); // <- Ojo: ya NO metemos 'api' aquí
const host = req => (req.headers.host||'').split(':')[0].toLowerCase();
const sub  = h => { const p=h.split('.'); return p.length<3?null:p[0]; };

// Fallback sólido: slug por defecto cuando no hay subdominio o es reservado
function resolveSlug(req){
  const h = host(req);
  const s = sub(h); // primera etiqueta si hay 3+ niveles
  if (s && !reserved.has(s)) return s;

  // Si no hay subdominio (agendador.es) o es reservado (p. ej. www),
  // intentamos query ?o=..., y si no, usamos la org por defecto
  const q = req.query?.o ? String(req.query.o).toLowerCase() : null;
  return q || CONFIG.DEFAULT_ORG_SLUG;
}

const ttl = m => new Date(Date.now() + m*60*1000);
const minutes = t => { const [H,M]=t.split(':').map(Number); return H*60+(M||0); };
const overlaps = (a0,a1,b0,b1)=> a0<b1 && b0<a1;

function maskIdentity(id){
  if (!id) return '';
  if (String(id).includes('@')) { const [u,d]=String(id).split('@'); const uu = (u.length<=2?u[0]+'***':u.slice(0,2)+'***'); return uu+'@'+d; }
  const digits = String(id).replace(/\D/g,''); return '••• •• '+digits.slice(-2);
}
const randomDigits = n => Array.from({length:n},()=>Math.floor(Math.random()*10)).join('');

function selectedLoc(req){ return req.cookies?.loc || null; }

// === DEBUG RÁPIDO (temporal) ===
app.get('/__debug', (req,res)=>{
  res.json({ host: host(req), slug: resolveSlug(req), headers: req.headers });
});

// === QR/WA utilidades públicas ===
app.get('/whatsapp/qr', (_req,res)=>{
  const hint = waReady ? '✅ Conectado' : 'Escanea el QR y refresca';
  res.send(`<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui">
    <div style="text-align:center">
      <h3>WhatsApp</h3><p>${hint}</p>
      <img src="/qr.png" alt="QR" style="width:320px;height:320px;object-fit:contain;border:1px solid #ddd;border-radius:12px"/>
      <meta http-equiv="refresh" content="10">
    </div></div>`);
});
app.get('/qr.png', async (_req,res)=>{
  try{ await ensureQrDir(); await fsp.access(QR_PATH, fs.constants.R_OK); res.type('png').sendFile(QR_PATH); }
  catch{ res.status(404).send('QR no disponible'); }
});
app.get('/whatsapp/status', (_req,res)=> res.json({ ready: waReady }));
app.get('/health', (_req,res)=> res.json({ ok:true }));

// === MULTI-TENANT (carga org SIEMPRE; no mostramos "Landing") ===
app.use(async (req,res,next)=>{
  if (['/health','/whatsapp/qr','/qr.png','/whatsapp/status','/__debug'].includes(req.path)) return next();
  const slug = resolveSlug(req);

  try{
    const { data: org, error } = await supabase
      .from('organizations')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();

    if (error) {
      console.error('[org-load] error:', error);
      return res.status(500).send('Error organización (consulta)');
    }
    if (!org) {
      console.warn('[org-load] no existe org con slug:', slug);
      return res.status(404).send('Organización no encontrada');
    }

    req.org = org;
    next();
  }catch(e){
    console.error('[org-load] excepción:', e);
    res.status(500).send('Error organización (excepción)');
  }
});

// === SESIÓN UBICACIÓN ===
app.post('/session/location', (req,res)=>{
  const { location_id } = req.body || {};
  if (!location_id) return res.status(400).json({ ok:false, error:'Falta location_id' });
  res.cookie('loc', location_id, { httpOnly:false, sameSite:'lax', secure:true, maxAge:1000*60*60*24*180 });
  res.json({ ok:true });
});

// === HOME (catálogo) ===
app.get('/', async (req,res)=>{
  try{
    const org = req.org;
    const locId = selectedLoc(req);

    const { data: locations, error: eL } = await supabase
      .from('locations').select('id,name,address,city,tz').eq('org_id', org.id).order('created_at');
    if (eL) throw eL;

    const { data: categories, error: eC } = await supabase
      .from('service_categories').select('id,name').eq('org_id', org.id).order('name');
    if (eC) throw eC;

    const { data: svcLinks, error: eCL } = await supabase
      .from('service_category_links').select('service_id,category_id');
    if (eCL) throw eCL;

    const { data: services, error: eS } = await supabase
      .from('services').select('id,name,duration_min,price_cents,active').eq('org_id', org.id).eq('active', true).order('name');
    if (eS) throw eS;

    const cats = (categories||[]).map(c=>({ ...c, services:[] }));
    const catMap = new Map(cats.map(c=>[c.id,c]));
    const svcMap = new Map((services||[]).map(s=>[s.id,s]));
    for (const l of (svcLinks||[])){ const c=catMap.get(l.category_id); const s=svcMap.get(l.service_id); if (c&&s) c.services.push(s); }

    res.render('tenant', { org, cdn:'/static', locations: locations||[], catalog: cats, selectedLocationId: locId });
  }catch(e){ console.error('[home]', e); res.status(500).send('Error cargando catálogo'); }
});

// === EMPLEADOS + slots ===
app.get('/book/:serviceId', async (req,res)=>{
  try{
    const org = req.org;
    const serviceId = req.params.serviceId;
    const locId = selectedLoc(req);
    if (!locId) return res.status(400).send('Selecciona ubicación primero');

    const { data: empLinks } = await supabase.from('employee_services').select('employee_id').eq('service_id', serviceId);
    const ids = (empLinks||[]).map(e=>e.employee_id);
    if (!ids.length) return res.status(404).send('Sin profesionales para este servicio');

    const { data: employees } = await supabase
      .from('employees')
      .select('id,name,color_hex,active,location_id')
      .in('id', ids).eq('active', true)
      .or(`location_id.eq.${locId},location_id.is.null`)
      .order('name');

    res.render('book_employees', { org, cdn:'/static', serviceId, employees: employees||[] });
  }catch(e){ console.error('[book:list]', e); res.status(500).send('Error cargando profesionales'); }
});

// === API slots (YYYY-MM-DD) ===
app.get('/api/slots', async (req,res)=>{
  try{
    const org = req.org;
    const locId = selectedLoc(req);
    const { serviceId, employeeId, date } = req.query;
    if (!locId) return res.status(400).json({ ok:false, error:'Sin ubicación' });
    if (!serviceId || !date) return res.status(400).json({ ok:false, error:'Faltan datos' });

    const { data: svc } = await supabase.from('services').select('duration_min').eq('id', serviceId).maybeSingle();
    if (!svc) return res.status(404).json({ ok:false, error:'Servicio no existe' });

    const weekday = new Date(date+'T00:00:00').getDay();
    const { data: bh } = await supabase.from('business_hours')
      .select('open_time,close_time').eq('org_id', org.id).eq('location_id', locId)
      .eq('weekday', weekday).eq('active', true).maybeSingle();
    if (!bh) return res.json({ ok:true, slots: [] });

    let empIds = [];
    if (employeeId) empIds = [employeeId];
    else {
      const { data: empLinks } = await supabase.from('employee_services').select('employee_id').eq('service_id', serviceId);
      empIds = (empLinks||[]).map(e=>e.employee_id);
    }
    if (!empIds.length) return res.json({ ok:true, slots: [] });

    const { data: avail } = await supabase.from('staff_availability')
      .select('employee_id,start_time,end_time,active')
      .eq('org_id', org.id).in('employee_id', empIds).eq('weekday', weekday).eq('active', true);

    const dayStart = new Date(date+'T00:00:00+02:00');
    const dayEnd   = new Date(date+'T23:59:59+02:00');

    const { data: blocks } = await supabase.from('blocks')
      .select('employee_id,starts_at,ends_at')
      .eq('org_id', org.id).eq('location_id', locId)
      .or(empIds.map(id=>`employee_id.eq.${id}`).concat('employee_id.is.null').join(','))
      .lte('starts_at', dayEnd.toISOString()).gte('ends_at', dayStart.toISOString());

    const { data: offs } = await supabase.from('staff_time_off')
      .select('employee_id,starts_at,ends_at')
      .eq('org_id', org.id).in('employee_id', empIds)
      .lte('starts_at', dayEnd.toISOString()).gte('ends_at', dayStart.toISOString());

    const { data: existing } = await supabase.from('appointments')
      .select('employee_id,start_at,end_at,status')
      .eq('org_id', org.id).eq('location_id', locId)
      .in('employee_id', empIds)
      .lte('start_at', dayEnd.toISOString()).gte('end_at', dayStart.toISOString())
      .neq('status','cancelled');

    const stepMin = 15, dur = svc.duration_min;
    const openMin = minutes(bh.open_time), closeMin = minutes(bh.close_time);
    const toMin = (dt)=> Math.max(0, Math.floor((new Date(dt) - dayStart)/60000));
    const busyBy = new Map();
    const addBusy=(emp,s,e)=>{ if(!busyBy.has(emp)) busyBy.set(emp,[]); busyBy.get(emp).push([s,e]); };

    (blocks||[]).forEach(b=> addBusy(b.employee_id||'__ALL__', toMin(b.starts_at), toMin(b.ends_at)));
    (offs||[]).forEach(t => addBusy(t.employee_id, toMin(t.starts_at), toMin(t.ends_at)));
    (existing||[]).forEach(a=> addBusy(a.employee_id, toMin(a.start_at), toMin(a.end_at)));

    const results=[];
    const rangesByEmp = new Map();
    (avail||[]).forEach(a=>{
      const s=Math.max(openMin, minutes(a.start_time)), e=Math.min(closeMin, minutes(a.end_time));
      if(e-s>=dur){ if(!rangesByEmp.has(a.employee_id)) rangesByEmp.set(a.employee_id,[]); rangesByEmp.get(a.employee_id).push([s,e]); }
    });

    for (const [emp, rs] of rangesByEmp.entries()){
      const busy = (busyBy.get(emp)||[]).concat(busyBy.get('__ALL__')||[]);
      for (const [s,e] of rs){
        for (let t=s; t+dur<=e; t+=stepMin){
          const conflict = busy.some(([bs,be])=> overlaps(t, t+dur, bs, be));
          if (!conflict){
            const start_at = new Date(dayStart.getTime()+t*60000).toISOString();
            const end_at   = new Date(dayStart.getTime()+(t+dur)*60000).toISOString();
            results.push({ employee_id: emp, start_at, end_at });
          }
        }
      }
    }
    results.sort((a,b)=> a.start_at.localeCompare(b.start_at));
    res.json({ ok:true, slots: results });
  }catch(e){ console.error('[slots]', e); res.status(500).json({ ok:false, error:'No se pudieron calcular slots' }); }
});

// === Confirmar reserva ===
app.post('/book/confirm', async (req,res)=>{
  try{
    if (!req.cookies?.sess) return res.status(401).json({ ok:false, error:'No autenticado' });
    const org = req.org;
    const locId = selectedLoc(req);
    const { service_id, employee_id, start_at, client } = req.body || {};
    if (!locId || !service_id || !employee_id || !start_at) return res.status(400).json({ ok:false, error:'Datos incompletos' });

    const { data: svc } = await supabase.from('services').select('duration_min').eq('id', service_id).maybeSingle();
    if (!svc) return res.status(404).json({ ok:false, error:'Servicio no existe' });

    const start = new Date(start_at);
    const end   = new Date(start.getTime() + svc.duration_min*60000);

    // cliente (buscar por phone/email, crear si no existe)
    let clientId = null;
    if (client?.phone){
      const { data:c } = await supabase.from('clients').select('id').eq('org_id', org.id).eq('phone', client.phone).maybeSingle();
      if (c) clientId=c.id;
    }
    if (!clientId && client?.email){
      const { data:c2 } = await supabase.from('clients').select('id').eq('org_id', org.id).eq('email', client.email).maybeSingle();
      if (c2) clientId=c2.id;
    }
    if (!clientId){
      const { data:created, error:ec } = await supabase.from('clients').insert({
        org_id: org.id, name: client?.name || 'Cliente', phone: client?.phone || null, email: client?.email || null
      }).select('id').single();
      if (ec) throw ec;
      clientId = created.id;
    }

    // colisión rápida
    const { data: clash } = await supabase.from('appointments').select('id')
      .eq('org_id', org.id).eq('location_id', locId).eq('employee_id', employee_id)
      .lt('start_at', end.toISOString()).gt('end_at', start.toISOString())
      .neq('status','cancelled').limit(1);
    if (clash?.length) return res.status(409).json({ ok:false, error:'Slot no disponible' });

    const { data: appt, error: ea } = await supabase.from('appointments').insert({
      org_id: org.id, location_id: locId, employee_id, client_id: clientId, service_id,
      start_at: start.toISOString(), end_at: end.toISOString(), status: 'booked'
    }).select('id,start_at,end_at').single();
    if (ea) throw ea;

    res.json({ ok:true, appointment: appt });
  }catch(e){ console.error('[confirm]', e); res.status(500).json({ ok:false, error:'No se pudo crear la cita' }); }
});

// === Verificación ===
app.get('/verify', (req,res)=>{
  const channel = (req.query.channel||'whatsapp').toLowerCase()==='email' ? 'email' : 'whatsapp';
  const identityRaw = (req.query.identity||'').trim();
  if (!identityRaw) return res.status(400).send('Falta identity');

  res.render('verify', {
    org: req.org, cdn:'/static', channel, identityRaw,
    identityMasked: maskIdentity(identityRaw), OTP_LENGTH: CONFIG.OTP_LENGTH
  });
});

// === Enviar OTP ===
app.post('/auth/send-code', async (req,res)=>{
  try{
    let { name, phone, email, channel } = req.body;
    channel = (channel||'whatsapp').toLowerCase();

    if (channel==='email' && !email) return res.status(400).json({ ok:false, error:'Falta email' });
    if (channel==='whatsapp' && !phone) return res.status(400).json({ ok:false, error:'Falta phone' });
    if (!phone && !email) return res.status(400).json({ ok:false, error:'Falta identidad' });

    const code = randomDigits(CONFIG.OTP_LENGTH);
    const expiresAt = ttl(15);

    const { error:e1 } = await supabase.from('otp_codes').insert({
      org_id: req.org?.id ?? null, phone: phone||null, email: email||null,
      code, channel, expires_at: expiresAt.toISOString(), meta:{ name }
    });
    if (e1) throw e1;

    if (channel==='email'){
      if (!CONFIG.RESEND_API_KEY || !CONFIG.MAIL_FROM_EMAIL) return res.status(500).json({ ok:false, error:'Email no configurado' });
      await fetch('https://api.resend.com/emails', {
        method:'POST',
        headers:{ 'Authorization':`Bearer ${CONFIG.RESEND_API_KEY}`, 'Content-Type':'application/json' },
        body: JSON.stringify({
          from: `${CONFIG.MAIL_FROM_NAME} <${CONFIG.MAIL_FROM_EMAIL}>`,
          to: email,
          subject: `${req.org?.name || 'Agendador'} · Tu código de verificación`,
          html: `<div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:auto;padding:16px">
            <h2 style="margin:0 0 12px;">${req.org?.name || 'Agendador'}</h2>
            <p>Tu código es:</p>
            <div style="font-size:28px;font-weight:700;letter-spacing:6px;margin:12px 0">${code}</div>
            <p>Caduca en <strong>15 minutos</strong>.</p></div>`
        })
      });
    } else {
      try{
        await sendWhatsAppMessage(phone.startsWith('+')?phone:`+34${phone}`, `Tu código para ${req.org?.name || 'Agendador'} es: *${code}*. Caduca en 15 minutos.`);
      }catch(werr){
        console.error('[WA] error', werr.message);
        return res.status(503).json({ ok:false, error:'WhatsApp no disponible. Abre /whatsapp/qr o usa email.' });
      }
    }

    const identity = email || phone;
    res.json({ ok:true, verify_url: `/verify?channel=${channel}&identity=${encodeURIComponent(identity)}`, expires_at: expiresAt.toISOString() });
  }catch(e){ console.error('[send-code]', e); res.status(500).json({ ok:false, error:'No se pudo enviar el código' }); }
});

// === Verificar OTP ===
app.post('/auth/verify', async (req,res)=>{
  try{
    const { phone, email, code } = req.body;
    if (!code || (!phone && !email)) return res.status(400).json({ ok:false, error:'Faltan datos' });

    let q = supabase.from('otp_codes').select('id').eq('code', code).is('used_at', null).gt('expires_at', new Date().toISOString()).limit(1).order('created_at', { ascending:false });
    if (email) q = q.eq('email', email); else q = q.eq('phone', phone);

    const { data: rows, error } = await q;
    if (error) return res.status(500).json({ ok:false, error:'DB error' });
    if (!rows?.length) return res.status(400).json({ ok:false, error:'Código inválido o caducado' });

    await supabase.from('otp_codes').update({ used_at: new Date().toISOString() }).eq('id', rows[0].id);

    const token = crypto.randomBytes(24).toString('hex');
    res.cookie('sess', token, { httpOnly:true, secure:true, sameSite:'lax', maxAge:1000*60*60*24*120 });
    res.json({ ok:true });
  }catch(e){ console.error('[verify]', e); res.status(500).json({ ok:false, error:'No se pudo verificar' }); }
});
app.post('/auth/logout', (_req,res)=>{ res.clearCookie('sess'); res.json({ ok:true }); });

// === Mis citas ===
app.get('/me/appointments', async (req,res)=>{
  try{
    if (!req.cookies?.sess) return res.status(401).send('No autenticado');
    const org = req.org;
    const { identity, channel } = req.query;
    if (!identity || !channel) return res.status(400).send('Falta identidad');

    let cli=null;
    if (channel==='email'){
      const { data } = await supabase.from('clients').select('id,name').eq('org_id', org.id).eq('email', identity).maybeSingle(); cli=data;
    }else{
      const { data } = await supabase.from('clients').select('id,name').eq('org_id', org.id).eq('phone', identity).maybeSingle(); cli=data;
    }
    if (!cli) return res.status(404).send('Cliente no encontrado');

    const { data: appts } = await supabase.from('appointments')
      .select('id,start_at,end_at,status,employees(name),services(name)')
      .eq('org_id', org.id).eq('client_id', cli.id)
      .gte('start_at', new Date().toISOString()).order('start_at');

    res.render('me_appointments', { org, cdn:'/static', appts: appts||[], clientName: cli.name });
  }catch(e){ console.error('[me/appointments]', e); res.status(500).send('Error listando citas'); }
});

// --- START ---
app.listen(CONFIG.PORT, ()=>{
  console.log('Agendador en http://localhost:'+CONFIG.PORT);
  startWhatsApp().catch(console.error);
});
