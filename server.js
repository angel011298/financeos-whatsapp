// FinanceOS WhatsApp — server.js
// Stack: Express + Twilio + Claude + Supabase
// Deploy: Railway (railway.app) — free tier

require('dotenv').config();
const express  = require('express');
const twilio   = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const Anthropic = require('@anthropic-ai/sdk');
const axios    = require('axios');

const app  = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── CLIENTS ────────────────────────────────────────────────────────────────
const sb  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  realtime: { transport: WebSocket },
});
const ai  = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
const twl = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const WA_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. whatsapp:+14155238886

// ── CONVERSATION MEMORY ────────────────────────────────────────────────────
// Simple in-memory store; resets on redeploy (acceptable for personal use)
const history = {};

// ── SYSTEM PROMPT ──────────────────────────────────────────────────────────
async function buildSystemPrompt() {
  // Pull live data from Supabase
  const [{ data: movs }, { data: tdcs }, { data: metas }] = await Promise.all([
    sb.from('movimientos').select('*').order('fecha', { ascending: false }).limit(30),
    sb.from('tdc').select('*').order('prioridad'),
    sb.from('metas').select('*'),
  ]);

  const gastosMes = (movs || [])
    .filter(m => m.tipo === 'GASTO')
    .reduce((a, m) => a + (m.monto || 0), 0);
  const ingresosMes = (movs || [])
    .filter(m => m.tipo === 'INGRESO')
    .reduce((a, m) => a + (m.monto || 0), 0);

  return `Eres el asesor financiero personal de Ángel Alberto Ortiz Sánchez (Ciudad de México).
Hablas por WhatsApp. Eres directo, empático y muy específico con números. Respondes en español.
Respuestas cortas para WhatsApp (máx 3 párrafos o una lista corta).

CONTEXTO FINANCIERO EN TIEMPO REAL:
- Ingreso base mensual: $31,898 MXN (sueldo $27,407 + WFH $425 + vales $3,566 + beca $500)
- Egresos fijos: ~$9,172/mes
- Disponible para TDC: ~$22,726/mes
- Inicio empleo: 26 mayo 2026 | Meta: DEUDA CERO febrero 2027

DEUDAS TDC (actualizado):
${(tdcs || []).map(t =>
  `• ${t.nombre}: orig $${t.deuda_original?.toLocaleString()} → a pagar $${t.a_pagar?.toLocaleString()} | pagado: $${t.pagado?.toLocaleString() || 0} | ${t.estado}`
).join('\n')}

MOVIMIENTOS RECIENTES (últimos 30):
${(movs || []).slice(0, 10).map(m =>
  `• ${m.fecha} | ${m.tipo} | ${m.categoria} | ${m.descripcion} | $${m.monto?.toLocaleString()}`
).join('\n')}

GASTOS DEL MES ACTUAL: $${gastosMes.toLocaleString()}
INGRESOS DEL MES ACTUAL: $${ingresosMes.toLocaleString()}

METAS DE AHORRO:
${(metas || []).map(m =>
  `• ${m.nombre}: $${m.actual?.toLocaleString() || 0} / $${m.meta?.toLocaleString()} (${Math.round(((m.actual || 0) / m.meta) * 100)}%)`
).join('\n') || '• Sin metas registradas aún'}

CAPACIDADES:
- Registrar gastos e ingresos cuando te los mencione
- Crear/actualizar metas de ahorro
- Analizar estados de cuenta (imágenes o PDFs)
- Responder dudas sobre finanzas, negociación de deudas, buró de crédito, etc.
- Dar recomendaciones específicas basadas en sus datos reales

CUANDO REGISTRES UN MOVIMIENTO incluye al FINAL de tu respuesta una línea así (invisible para el usuario):
SAVE:{"tipo":"GASTO","categoria":"COMIDA","descripcion":"tacos","monto":150}
o
SAVE:{"tipo":"INGRESO","categoria":"SUELDO","descripcion":"Quincena 1 junio","monto":13703}
o
META:{"accion":"crear","nombre":"Fondo emergencia","meta":10000}
o
META:{"accion":"abonar","nombre":"Fondo emergencia","monto":500}

Si el usuario NO está registrando un movimiento, NO incluyas SAVE ni META.`;
}

// ── HELPERS ────────────────────────────────────────────────────────────────
async function saveMovimiento(data) {
  const fecha = new Date().toISOString().split('T')[0];
  await sb.from('movimientos').insert({
    tipo: data.tipo || 'GASTO',
    categoria: data.categoria || 'OTROS',
    descripcion: data.descripcion || '',
    monto: parseFloat(data.monto) || 0,
    fecha,
  });
}

async function handleMeta(data) {
  if (data.accion === 'crear') {
    await sb.from('metas').upsert(
      { nombre: data.nombre, meta: parseFloat(data.meta), actual: 0 },
      { onConflict: 'nombre' }
    );
  } else if (data.accion === 'abonar') {
    const { data: existing } = await sb.from('metas').select('actual').eq('nombre', data.nombre).single();
    if (existing) {
      await sb.from('metas').update({ actual: (existing.actual || 0) + parseFloat(data.monto) }).eq('nombre', data.nombre);
    }
  }
}

function extractAndStrip(text) {
  // Extract SAVE/META commands from Claude response, return cleaned text + commands
  const saveMatch = text.match(/SAVE:(\{.*?\})/);
  const metaMatch = text.match(/META:(\{.*?\})/);
  const cleanText = text.replace(/SAVE:\{.*?\}/g, '').replace(/META:\{.*?\}/g, '').trim();
  return {
    cleanText,
    saveData: saveMatch ? JSON.parse(saveMatch[1]) : null,
    metaData: metaMatch ? JSON.parse(metaMatch[1]) : null,
  };
}

function fmt(n) {
  return '$' + Math.round(n || 0).toLocaleString('es-MX');
}

// ── QUICK COMMANDS ──────────────────────────────────────────────────────────
async function cmdResumen() {
  const hoy = new Date().toISOString().split('T')[0];
  const mesInicio = hoy.substring(0, 7) + '-01';

  const [{ data: movHoy }, { data: movMes }, { data: tdcs }] = await Promise.all([
    sb.from('movimientos').select('*').eq('fecha', hoy),
    sb.from('movimientos').select('*').gte('fecha', mesInicio),
    sb.from('tdc').select('*').order('prioridad'),
  ]);

  const gastoHoy  = (movHoy  || []).filter(m => m.tipo === 'GASTO' ).reduce((a, m) => a + m.monto, 0);
  const ingrHoy   = (movHoy  || []).filter(m => m.tipo === 'INGRESO').reduce((a, m) => a + m.monto, 0);
  const gastoMes  = (movMes  || []).filter(m => m.tipo === 'GASTO' ).reduce((a, m) => a + m.monto, 0);
  const ingrMes   = (movMes  || []).filter(m => m.tipo === 'INGRESO').reduce((a, m) => a + m.monto, 0);
  const tdcPend   = (tdcs    || []).reduce((a, t) => a + Math.max(0, (t.a_pagar || 0) - (t.pagado || 0)), 0);

  const ultMovs = (movHoy || []).slice(0, 5).map(m =>
    `  ${m.tipo === 'GASTO' ? '💸' : '💰'} ${m.categoria}: ${m.descripcion} ${fmt(m.monto)}`
  ).join('\n');

  return `📊 *RESUMEN FINANCIERO*\n📅 ${hoy}\n\n` +
    `*HOY*\n💸 Gasto: ${fmt(gastoHoy)}\n💵 Ingreso: ${fmt(ingrHoy)}\n\n` +
    `*ESTE MES*\n💸 Gastos: ${fmt(gastoMes)}\n💵 Ingresos: ${fmt(ingrMes)}\n📈 Neto: ${fmt(ingrMes - gastoMes)}\n\n` +
    `*TDC PENDIENTE*\n💳 ${fmt(tdcPend)} total\n\n` +
    (ultMovs ? `*Movimientos de hoy*\n${ultMovs}\n\n` : '') +
    `🎯 Meta: Deuda cero Feb 2027`;
}

async function cmdDeudas() {
  const { data: tdcs } = await sb.from('tdc').select('*').order('prioridad');
  if (!tdcs || !tdcs.length) return '💳 No tienes deudas registradas aún.';

  const rows = tdcs.map(t => {
    const saldo = Math.max(0, (t.a_pagar || 0) - (t.pagado || 0));
    const pct   = t.deuda_original > 0 ? Math.round((1 - t.a_pagar / t.deuda_original) * 100) : 0;
    const bar   = '█'.repeat(Math.round((t.pagado || 0) / (t.a_pagar || 1) * 5)).padEnd(5, '░');
    return `*${t.nombre}* ${t.estado.toUpperCase()}\n  ${bar} Saldo: ${fmt(saldo)} (desc. ${pct}%)\n  Mes objetivo: ${t.mes_objetivo || '—'}`;
  }).join('\n\n');

  const totalSaldo = tdcs.reduce((a, t) => a + Math.max(0, (t.a_pagar || 0) - (t.pagado || 0)), 0);
  return `💳 *DEUDAS TDC*\n\n${rows}\n\n📌 Total pendiente: *${fmt(totalSaldo)}*\n🎯 Meta: deuda cero Feb 2027`;
}

async function cmdMetas() {
  const { data: metas } = await sb.from('metas').select('*');
  if (!metas || !metas.length) return '🎯 Sin metas de ahorro aún. Escríbeme algo como "quiero ahorrar $10,000 para un fondo de emergencia".';

  const rows = metas.map(m => {
    const pct = m.meta > 0 ? Math.min(100, Math.round((m.actual || 0) / m.meta * 100)) : 0;
    const bar = '█'.repeat(Math.round(pct / 20)).padEnd(5, '░');
    return `*${m.nombre}*\n  ${bar} ${fmt(m.actual)} / ${fmt(m.meta)} (${pct}%)`;
  }).join('\n\n');

  return `🎯 *METAS DE AHORRO*\n\n${rows}`;
}

function cmdAyuda() {
  return `🤖 *FinanceOS — Comandos*\n\n` +
    `📊 *resumen* — resumen del día\n` +
    `💳 *deudas* — estado de tus TDC\n` +
    `🎯 *metas* — metas de ahorro\n` +
    `📋 *historial* — últimos 10 movimientos\n\n` +
    `*Para registrar (lenguaje natural):*\n` +
    `💸 "gasté 200 en el super"\n` +
    `💰 "me depositaron 13703 de quincena"\n` +
    `🎯 "quiero ahorrar 5000 para vacaciones"\n` +
    `📄 Envía foto/PDF de estado de cuenta\n\n` +
    `También puedes preguntarme cualquier duda financiera 💬`;
}

async function cmdHistorial() {
  const { data: movs } = await sb.from('movimientos').select('*').order('fecha', { ascending: false }).limit(10);
  if (!movs || !movs.length) return '📋 Sin movimientos registrados aún.';

  const rows = movs.map(m =>
    `${m.tipo === 'GASTO' ? '💸' : '💰'} ${m.fecha} | ${m.categoria} | ${m.descripcion} | ${fmt(m.monto)}`
  ).join('\n');

  return `📋 *ÚLTIMOS MOVIMIENTOS*\n\n${rows}`;
}

// ── ANALYZE BANK STATEMENT ──────────────────────────────────────────────────
async function analyzeBankStatement(mediaUrl, mediaType, phone) {
  // Download the media from Twilio (requires auth)
  const response = await axios.get(mediaUrl, {
    auth: { username: process.env.TWILIO_SID, password: process.env.TWILIO_TOKEN },
    responseType: 'arraybuffer',
  });
  const b64 = Buffer.from(response.data).toString('base64');

  const sysPrompt = await buildSystemPrompt();
  const isImage   = (mediaType || '').startsWith('image/');
  const isPDF     = mediaType === 'application/pdf';

  const contentParts = [];
  if (isImage) {
    contentParts.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } });
  } else if (isPDF) {
    contentParts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
  } else {
    return '⚠️ Formato no soportado. Envía el estado de cuenta como imagen JPG/PNG o PDF.';
  }

  contentParts.push({
    type: 'text',
    text: 'Analiza este estado de cuenta. Proporciona: banco y período, saldo e intereses cobrados, top 5 cargos, si hay algo disputable, y la acción recomendada esta semana para esta tarjeta según mi plan de liquidación.',
  });

  const apiOptions = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: sysPrompt,
    messages: [{ role: 'user', content: contentParts }],
  };
  if (isPDF) apiOptions.betas = ['pdfs-2024-09-25'];

  const result = await ai.messages.create(apiOptions);
  return result.content[0].text;
}

// ── MAIN WEBHOOK ────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Always respond 200 immediately so Twilio doesn't retry
  res.status(200).send('OK');

  const { Body, From, MediaUrl0, MediaContentType0, NumMedia } = req.body;
  const phone = From || 'unknown';

  let reply = '';

  try {
    const text    = (Body || '').trim();
    const lower   = text.toLowerCase();
    const hasMedia = parseInt(NumMedia || 0) > 0;

    if (hasMedia && MediaUrl0) {
      reply = await analyzeBankStatement(MediaUrl0, MediaContentType0, phone);
    } else if (lower === 'resumen' || lower === 'ver resumen') {
      reply = await cmdResumen();
    } else if (lower === 'deudas' || lower === 'ver deudas') {
      reply = await cmdDeudas();
    } else if (lower === 'metas' || lower === 'ver metas') {
      reply = await cmdMetas();
    } else if (lower === 'historial') {
      reply = await cmdHistorial();
    } else if (lower === 'ayuda' || lower === 'help' || lower === 'menu') {
      reply = cmdAyuda();
    } else {
      // Claude handles everything else (natural language)
      if (!history[phone]) history[phone] = [];

      const sysPrompt = await buildSystemPrompt();
      history[phone].push({ role: 'user', content: text });

      // Keep last 20 messages
      if (history[phone].length > 20) history[phone].splice(0, 2);

      const result = await ai.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: sysPrompt,
        messages: history[phone],
      });

      const rawReply = result.content[0].text;
      const { cleanText, saveData, metaData } = extractAndStrip(rawReply);

      history[phone].push({ role: 'assistant', content: cleanText });

      // Save financial data if Claude detected it
      if (saveData) {
        await saveMovimiento(saveData);
        reply = cleanText + '\n\n✅ _Guardado en tu registro_';
      } else if (metaData) {
        await handleMeta(metaData);
        reply = cleanText + '\n\n🎯 _Meta actualizada_';
      } else {
        reply = cleanText;
      }
    }
  } catch (err) {
    console.error('Webhook error:', err);
    reply = '❌ Hubo un error. Intenta de nuevo o escribe *ayuda*.';
  }

  // Send reply via Twilio
  if (reply && From) {
    await twl.messages.create({ from: WA_FROM, to: From, body: reply });
  }
});

// ── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'FinanceOS WhatsApp running ✅' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FinanceOS WhatsApp listening on port ${PORT}`));
