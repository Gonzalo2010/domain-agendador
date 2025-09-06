import 'dotenv/config';
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
  useMultiFileAuthState,
  Browsers,
  DisconnectReason
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.SESSION_SECRET || 'dev-secret'));

const {
  PORT = 3000,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY,
  SESSION_SECRET,
  // Resend
  RESEND_API_KEY,
  MAIL_FROM_EMAIL,
  MAIL_FROM_NAME = 'Agendador',
  // Defaults
  DEFAULT_CHANNEL = 'whatsapp',
  // Dónde guardar el PNG del QR (por defecto /tmp en Render)
  QR_DIR = '/tmp'
} = process.env;

const SUPABASE_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[BOOT] faltan SUPABASE_URL / KEY');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// =========================
// WhatsApp via Baileys + QR a /qr.png
// =========================
let wa = null;
let waQR = null; // último QR recibido
let waReady = false;

const QR_PATH = path.join(QR_DIR, 'qr.png');

async function ensureQrDir() {
  try { await fsp.mkdir(QR_DIR, { recursive: true }); } catch {}
}

async function writeQrPng(qrString) {
  await ensureQrDir();
  const buf = await qrcode.toBuffer(qrString, { type: 'png', width: 512, errorCorrectionLevel: 'M' });
  await fsp.writeFile(QR_PATH, buf);
  console.log(`[WA] QR actualizado en ${QR_PATH}`);
}

async function deleteQrPng() {
  try { await fsp.unlink(QR_PATH); console.log('[WA] QR eliminado'); } catch {}
}

async function startWhatsApp() {
  const authDir = path.join(__dirname, 'baileys_auth'); // en Render es efímero (OK)
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  wa = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.appropriate('Agendador'),
    syncFullHistory: false,
    defaultQueryTimeoutMs: 30_000
  });

  wa.ev.on('creds.update', saveCreds);

  wa.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      waQR = qr;
      waReady = false;
      writeQrPng(qr).catch(console.error);
    }

    if (connection === 'open') {
      waQR = null;
      waReady = true;
      deleteQrPng().catch(()=>{});
      console.log('[WA] sesión conectada');
    }

    if (connection === 'close') {
      waReady = false;
      const shouldReconnect =
        (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[WA] conexión cerrada. Reintentar:', shouldReconnect);
      if (shouldReconnect) startWhatsApp().catch(console.error);
    }
  });
}

async function sendWhatsAppMessage(phone, text) {
  if (!wa) await startWhatsApp();
  if (!waReady) throw new Error('WhatsApp no está conectado (escanea QR en /whatsapp/qr o abre /qr.png)');
  const digits = phone.replace(/\D/g, '');
  const jid = `${digits}@s.whatsapp.net`;
  await wa.sendMessage(jid, { text });
}

// PNG plano del QR
app.get('/qr.png', async (req, res) => {
  try {
    await ensureQrDir();
    await fsp.access(QR_PATH, fs.constants.R_OK);
    res.type('png');
    res.sendFile(QR_PATH);
  } catch {
    res.status(404).send('QR no disponible todavía');
  }
});

// Página simple de estado/QR (por si prefieres ver el QR en HTML)
app.get('/whatsapp/qr', async (_req, res) => {
  const hint = waReady ? '✅ Conectado' : 'Escanea el QR (o recarga si no aparece aún).';
  res.status(200).send(`
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui">
      <div style="text-align:center">
        <h3>WhatsApp</h3>
        <p>${hint}</p>
        <img src="/qr.png" alt="QR" style="width:300px;height:300px;object-fit:contain;border:1px solid #ccc;border-radius:12px"/>
        <p style="color:#666">Si no se ve el QR, recarga en unos segundos.</p>
        <meta http-equiv="refresh" content="10">
      </div>
    </div>
  `);
});

// =========================
// Helpers generales
// =========================
const reserved = new Set(['www','api','dev','staging']);
const host = (req) => (req.headers.host || '').split(':')[0].toLowerCase();
const sub = (h) => { const p = h.split('.'); return p.length < 3 ? null : p[0]; };
const resolveSlug = (req) => {
  const s = sub(host(req)); if (s && !reserved.has(s)) return s;
  if (req.query?.o) return String(req.query.o).toLowerCase();
  return null;
};
const four = () => String(Math.floor(1000 + Math.random() * 9000));
const ttl = (m) => new Date(Date.now() + m * 60 * 1000);

// =========================
// Multi-tenant
// =========================
app.use(async (req, res, next) => {
  if (['/health', '/whatsapp/qr', '/qr.png'].includes(req.path)) return next();
  const slug = resolveSlug(req);
  if (!slug) return res.send('Landing Agendador');
  const { data: org, error } = await supabase
    .from('organizations')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error) return res.status(500).send('Error organización');
  if (!org)  return res.status(404).send('Org no encontrada');
  req.org = org;
  next();
});

// =========================
// Vistas
// =========================
app.get('/', (req, res) => {
  res.render('tenant', { org: req.org, cdn: '/static' });
});

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// =====================================================
// AUTH: Enviar OTP (WhatsApp o Email vía Resend REST)
// body: { name, phone, email?, channel: 'whatsapp' | 'email' }
// =====================================================
app.post('/auth/send-code', async (req, res) => {
  try {
    let { name, phone, email, channel } = req.body;
    channel = (channel || DEFAULT_CHANNEL).toLowerCase();

    if (channel === 'email' && !email) {
      return res.status(400).json({ ok:false, error:'Falta email' });
    }
    if (channel === 'whatsapp' && !phone) {
      return res.status(400).json({ ok:false, error:'Falta phone' });
    }
    if (!phone && !email) {
      return res.status(400).json({ ok:false, error:'Proporciona phone o email' });
    }

    const code = four();
    const expiresAt = ttl(15);

    // Guarda OTP
    const { error: e1 } = await supabase.from('otp_codes').insert({
      org_id: req.org?.id ?? null,
      phone: phone || null,
      email: email || null,
      code,
      channel,
      expires_at: expiresAt.toISOString(),
      meta: { name }
    });
    if (e1) throw e1;

    // Envía
    if (channel === 'email') {
      if (!RESEND_API_KEY || !MAIL_FROM_EMAIL) {
        return res.status(500).json({ ok:false, error:'Email no configurado' });
      }
      await sendResendEmail({
        apiKey: RESEND_API_KEY,
        from: `${MAIL_FROM_NAME} <${MAIL_FROM_EMAIL}>`,
        to: email,
        subject: `${req.org?.name || 'Agendador'} · Tu código de verificación`,
        html: emailTemplate(req.org?.name || 'Agendador', code)
      });
    } else {
      try {
        await sendWhatsAppMessage(
          phone.startsWith('+') ? phone : `+34${phone}`,
          `Tu código de verificación para ${req.org?.name || 'Agendador'} es: *${code}*. Caduca en 15 minutos.`
        );
      } catch (werr) {
        console.error('[WA] Error enviando:', werr.message);
        return res.status(503).json({ ok:false, error:'WhatsApp no disponible. Escanea QR en /whatsapp/qr o usa canal email.' });
      }
    }

    return res.json({ ok:true, expires_at: expiresAt.toISOString() });
  } catch (err) {
    console.error('[send-code]', err);
    return res.status(500).json({ ok:false, error:'No se pudo enviar el código' });
  }
});

// Helper: enviar email con Resend (REST)
async function sendResendEmail({ apiKey, from, to, subject, html }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to, subject, html })
  });
  const data = await r.json();
  if (!r.ok) {
    const msg = data?.message || JSON.stringify(data);
    throw new Error(`Resend error: ${msg}`);
  }
  return data;
}

function emailTemplate(orgName, code) {
  return `
  <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:auto;padding:16px">
    <h2 style="margin:0 0 12px;">${orgName}</h2>
    <p>Tu código de verificación es:</p>
    <div style="font-size:28px;font-weight:700;letter-spacing:6px;margin:12px 0">${code}</div>
    <p>Este código caduca en <strong>15 minutos</strong>.</p>
    <p style="color:#667085;font-size:12px">Si no has solicitado este código, ignora este mensaje.</p>
  </div>`;
}

// =====================================
// AUTH: Verificar OTP y crear sesión
// body: { phone?, email?, code }
// =====================================
app.post('/auth/verify', async (req, res) => {
  try {
    const { phone, email, code } = req.body;
    if (!code || (!phone && !email)) {
      return res.status(400).json({ ok:false, error:'Faltan datos' });
    }

    let q = supabase.from('otp_codes')
      .select('*')
      .eq('code', code)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1);

    if (email) q = q.eq('email', email);
    else       q = q.eq('phone', phone);

    const { data: rows, error } = await q;
    if (error) return res.status(500).json({ ok:false, error:'DB error' });
    if (!rows || rows.length === 0) return res.status(400).json({ ok:false, error:'Código inválido o caducado' });

    // marca usado
    await supabase.from('otp_codes').update({ used_at: new Date().toISOString() }).eq('id', rows[0].id);

    // sesión persistente
    const token = crypto.randomBytes(24).toString('hex');
    res.cookie('sess', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 120 // ~4 meses
    });

    return res.json({ ok:true });
  } catch (err) {
    console.error('[verify] ', err);
    return res.status(500).json({ ok:false, error:'No se pudo verificar' });
  }
});

// logout
app.post('/auth/logout', (_req, res) => {
  res.clearCookie('sess');
  res.json({ ok:true });
});

// levantar
app.listen(PORT, () => {
  console.log(`Agendador listo en http://localhost:${PORT}`);
  // arranca WA en background
  startWhatsApp().catch(console.error);
});
