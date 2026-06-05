// FinanceOS WhatsApp — server.js v3 (Arquitectura Dual IA + Function Calling + Modo Fantasma)
// Stack: Express + Twilio + Claude 3.5 / Gemini 1.5 + Supabase
// Deploy: Railway.app

require('dotenv').config();
const express   = require('express');
const path      = require('path');
const twilio    = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios     = require('axios');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, 'public')));

// ── CLIENTS ────────────────────────────────────────────────────────────────
const sb  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  realtime: { transport: WebSocket },
});
const ai  = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const twl = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const WA_FROM = process.env.TWILIO_WHATSAPP_FROM;

// ── CONVERSATION MEMORY ────────────────────────────────────────────────────
const history = {};

// ── HELPERS ────────────────────────────────────────────────────────────────
function fmt(n) { return '$' + Math.round(n || 0).toLocaleString('es-MX'); }
function hoy() { return new Date().toISOString().split('T')[0]; }
function mesActual() { return hoy().substring(0, 7) + '-01'; }

// ── USER MANAGEMENT ────────────────────────────────────────────────────────
async function getOrCreateUser(phone) {
  let { data: user } = await sb.from('usuarios').select('*').eq('telefono', phone).single();
  if (!user) {
    // Si no existe, lo creamos como usuario B con Claude por defecto
    const { data: newUser } = await sb.from('usuarios').insert([{ 
      telefono: phone, role: 'USER_B', ai_preference: 'CLAUDE' 
    }]).select().single();
    user = newUser;
  }
  return user;
}

// ── FUNCTION CALLING: EJECUTOR DE BASE DE DATOS ────────────────────────────
async function executeDbAction(phone, arg) {
  const { tabla, accion, id, datos } = arg;
  try {
    if (accion === 'crear') {
      await sb.from(tabla).insert({ ...datos, user_phone: phone });
      return `✅ Registro creado exitosamente en ${tabla}.`;
    } else if (accion === 'editar') {
      await sb.from(tabla).update(datos).eq('id', id).eq('user_phone', phone);
      return `✅ Registro ${id} editado correctamente en ${tabla}.`;
    } else if (accion === 'eliminar') {
      await sb.from(tabla).delete().eq('id', id).eq('user_phone', phone);
      return `🗑️ Registro ${id} eliminado de ${tabla}.`;
    }
  } catch (error) {
    return `❌ Error en DB al ${accion} en ${tabla}: ${error.message}`;
  }
}

// ── SYSTEM PROMPT (Modo Fantasma + Aislamiento) ────────────────────────────
async function buildSystemPrompt(user) {
  const today = hoy();
  const phone = user.telefono;

  // Consultas aisladas por el usuario actual
  const [tdcRes, movsRes, metasRes, calRes] = await Promise.all([
    sb.from('tdc').select('*').eq('user_phone', phone).order('prioridad'),
    sb.from('movimientos').select('*').eq('user_phone', phone).order('created_at', { ascending: false }).limit(50),
    sb.from('metas').select('*').eq('user_phone', phone),
    sb.from('calendario').select('*').eq('user_phone', phone).gte('fecha', today).order('fecha').limit(15),
  ]);

  const tdcs    = tdcRes.data  || [];
  const movs    = movsRes.data || [];
  const metas   = metasRes.data || [];
  const eventos = calRes.data   || [];

  const gastosMes   = movs.filter(m => m.tipo === 'GASTO').reduce((a, m) => a + (m.monto || 0), 0);
  const ingresosMes = movs.filter(m => m.tipo === 'INGRESO').reduce((a, m) => a + (m.monto || 0), 0);

  // MODO FANTASMA: Si es ADMIN_A, extraemos los datos de la plataforma en general
  let ghostModeData = "";
  if (user.role === 'ADMIN_A') {
    const { data: otrosMovs } = await sb.from('movimientos')
      .select('*').neq('user_phone', phone).order('created_at', { ascending: false }).limit(20);
    ghostModeData = `
════════════════════════════════
[MODO FANTASMA - DATOS PLATAFORMA SUJETO B]
════════════════════════════════
Eres el Admin Maestro de FinanceOS. Abajo están los últimos movimientos del Sujeto B:
${JSON.stringify(otrosMovs)}
ATENCIÓN: Separa ESTRICTAMENTE tus respuestas. Si te hablo en primera persona, fíjate solo en MIS datos. Usa el contexto Fantasma SOLO si te pregunto sobre el Sujeto B o la plataforma global.
`;
  }

  return `Eres el asesor financiero personal experto de FinanceOS.
Fecha hoy: ${today}

PERSONALIDAD Y REGLAS:
- Eres analítico, empático y proactivo.
- TIENES PODER DE ACCIÓN: Tienes acceso a la herramienta 'modificar_plataforma'. Úsala autónomamente para crear, editar o eliminar registros cuando el usuario te lo pida.
- Respuestas cortas para WhatsApp (máx 3 párrafos).
- Siempre da el número exacto de saldo disponible.

════════════════════════════════
TUS DATOS FINANCIEROS (Sujeto ${user.role === 'ADMIN_A' ? 'A' : 'B'})
════════════════════════════════
DEUDAS TDC:
${tdcs.map(t => `• [ID:${t.id}] ${t.nombre} — pagar ${fmt(t.a_pagar)} | SALDO ${fmt(Math.max(0, t.a_pagar - t.pagado))}`).join('\n')}

ACTIVIDAD (últimos 50): Gastos: ${fmt(gastosMes)} | Ingresos: ${fmt(ingresosMes)}

ÚLTIMOS MOVIMIENTOS (Usa el ID para editar o eliminar):
${movs.slice(0, 10).map(m => `• [ID: ${m.id}] ${m.fecha} | ${m.tipo} | ${m.categoria} | ${fmt(m.monto)} | ${m.medio_pago}`).join('\n')}

METAS DE AHORRO:
${metas.map(m => `• [ID:${m.id}] ${m.nombre}: ${fmt(m.actual)} / ${fmt(m.meta)}`).join('\n') || '• Sin metas aún'}
${ghostModeData}`;
}

// ── QUICK COMMANDS (AISLADOS POR USER_PHONE) ───────────────────────────────
async function cmdResumen(phone) {
  const today = hoy();
  const mesStart = mesActual();

  const [{ data: movHoy }, { data: movMes }, { data: tdcs }] = await Promise.all([
    sb.from('movimientos').select('*').eq('user_phone', phone).eq('fecha', today),
    sb.from('movimientos').select('*').eq('user_phone', phone).gte('fecha', mesStart),
    sb.from('tdc').select('*').eq('user_phone', phone).order('prioridad'),
  ]);

  const gastoHoy = (movHoy || []).filter(m => m.tipo === 'GASTO').reduce((a, m) => a + m.monto, 0);
  const ingrHoy  = (movHoy || []).filter(m => m.tipo === 'INGRESO').reduce((a, m) => a + m.monto, 0);
  const gastoMes = (movMes || []).filter(m => m.tipo === 'GASTO').reduce((a, m) => a + m.monto, 0);
  const ingrMes  = (movMes || []).filter(m => m.tipo === 'INGRESO').reduce((a, m) => a + m.monto, 0);
  const tdcPend  = (tdcs || []).reduce((a, t) => a + Math.max(0, (t.a_pagar || 0) - (t.pagado || 0)), 0);

  return `📊 *RESUMEN FINANCIERO*\n📅 ${today}\n\n*HOY*\n💸 Gasto: ${fmt(gastoHoy)}\n💵 Ingreso: ${fmt(ingrHoy)}\n\n*ESTE MES*\n💸 Gastos: ${fmt(gastoMes)}\n💵 Ingresos: ${fmt(ingrMes)}\n📈 Neto: ${fmt(ingrMes - gastoMes)}\n\n*TDC PENDIENTE*\n💳 ${fmt(tdcPend)} total`;
}

async function cmdDeudas(phone) {
  const { data: tdcs } = await sb.from('tdc').select('*').eq('user_phone', phone).order('prioridad');
  if (!tdcs?.length) return '💳 No tienes deudas registradas aún.';
  const rows = tdcs.map(t => `*${t.nombre}* \nSaldo: ${fmt(Math.max(0, (t.a_pagar || 0) - (t.pagado || 0)))}`).join('\n\n');
  return `💳 *DEUDAS TDC*\n\n${rows}`;
}

async function cmdHistorial(phone) {
  const { data: movs } = await sb.from('movimientos').select('*').eq('user_phone', phone).order('created_at', { ascending: false }).limit(10);
  if (!movs?.length) return '📋 Sin movimientos registrados aún.';
  const rows = movs.map(m => `${m.tipo === 'GASTO' ? '💸' : '💰'} ${m.fecha} | ${m.categoria} | ${fmt(m.monto)}`).join('\n');
  return `📋 *ÚLTIMOS MOVIMIENTOS*\n\n${rows}`;
}

// ── LLM ENGINE CON FUNCTION CALLING (CLAUDE Y GEMINI) ──────────────────────
const toolsSchema = {
  name: "modificar_plataforma",
  description: "Crea, edita o elimina registros en las tablas: movimientos, metas, calendario, tdc.",
  input_schema: { // Claude Format
    type: "object",
    properties: {
      tabla: { type: "string", enum: ["movimientos", "metas", "calendario", "tdc"] },
      accion: { type: "string", enum: ["crear", "editar", "eliminar"] },
      id: { type: "string", description: "ID del registro a editar o eliminar" },
      datos: { type: "object", description: "Diccionario clave-valor con los datos a insertar o actualizar." }
    },
    required: ["tabla", "accion"]
  }
};

const geminiToolsSchema = [{ // Gemini Format
  functionDeclarations: [{
    name: "modificar_plataforma",
    description: "Crea, edita o elimina registros en la plataforma financiera.",
    parameters: {
      type: "OBJECT",
      properties: {
        tabla: { type: "STRING" }, accion: { type: "STRING" }, id: { type: "STRING" }, datos: { type: "OBJECT" }
      },
      required: ["tabla", "accion"]
    }
  }]
}];

async function callIA(user, sysPrompt, textInput, phone) {
  if (!history[phone]) history[phone] = [];
  history[phone].push({ role: 'user', content: textInput });
  if (history[phone].length > 15) history[phone].splice(0, 2);

  if (user.ai_preference === 'GEMINI') {
    // Motor Gemini con Herramientas
    const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro', tools: geminiToolsSchema });
    const geminiHistory = history[phone].map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    
    const chat = geminiModel.startChat({ history: geminiHistory.slice(0, -1), systemInstruction: sysPrompt });
    const result = await chat.sendMessage(textInput);
    const call = result.response.functionCalls();

    if (call && call.length > 0) {
      const dbResult = await executeDbAction(phone, call[0].args);
      const secondResult = await chat.sendMessage([{ functionResponse: { name: "modificar_plataforma", response: { result: dbResult } } }]);
      const finalReply = secondResult.response.text();
      history[phone].push({ role: 'assistant', content: finalReply });
      return finalReply;
    }
    
    history[phone].push({ role: 'assistant', content: result.response.text() });
    return result.response.text();

  } else {
    // Motor Claude con Herramientas
    const msg = await ai.messages.create({
      model: 'claude-3-5-sonnet-20240620',
      max_tokens: 1000,
      system: sysPrompt,
      tools: [toolsSchema],
      messages: history[phone]
    });

    if (msg.stop_reason === 'tool_use') {
      const toolCall = msg.content.find(c => c.type === 'tool_use');
      const textBlock = msg.content.find(c => c.type === 'text')?.text || '';
      
      const dbResult = await executeDbAction(phone, toolCall.input);
      
      // Llamada de retorno para confirmar la acción natural
      history[phone].push({ role: 'assistant', content: msg.content });
      history[phone].push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: dbResult }] });
      
      const finalMsg = await ai.messages.create({
        model: 'claude-3-5-sonnet-20240620', max_tokens: 1000, system: sysPrompt, tools: [toolsSchema], messages: history[phone]
      });
      
      const finalReply = finalMsg.content[0].text;
      history[phone].push({ role: 'assistant', content: finalReply });
      return textBlock + '\n' + finalReply;
    }

    const reply = msg.content[0].text;
    history[phone].push({ role: 'assistant', content: reply });
    return reply;
  }
}

// ── API REST PARA EL DASHBOARD WEB ─────────────────────────────────────────

// Endpoint para obtener toda la data de un usuario específico
app.get('/api/dashboard/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const [tdc, movs, metas, user] = await Promise.all([
      sb.from('tdc').select('*').eq('user_phone', phone).order('prioridad'),
      sb.from('movimientos').select('*').eq('user_phone', phone).order('created_at', { ascending: false }).limit(100),
      sb.from('metas').select('*').eq('user_phone', phone),
      sb.from('usuarios').select('*').eq('telefono', phone).single()
    ]);
    res.json({ success: true, data: { tdc: tdc.data, movs: movs.data, metas: metas.data, user: user.data } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para que el usuario cambie su IA desde la Web
app.post('/api/preferencia', async (req, res) => {
  try {
    const { phone, ai_preference } = req.body;
    await sb.from('usuarios').update({ ai_preference }).eq('telefono', phone);
    res.json({ success: true, message: `Preferencia actualizada a ${ai_preference}` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── MAIN WEBHOOK ────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK'); 

  const { Body, From, MediaUrl0 } = req.body;
  const phone = From || 'unknown';
  let reply = '';

  try {
    const text = (Body || '').trim();
    const lower = text.toLowerCase().trim();
    const user = await getOrCreateUser(phone);

    if (['resumen', 'summary'].includes(lower)) {
      reply = await cmdResumen(phone);
    } else if (['deudas', 'tdc'].includes(lower)) {
      reply = await cmdDeudas(phone);
    } else if (['historial', 'movimientos'].includes(lower)) {
      reply = await cmdHistorial(phone);
    } else if (['ayuda', 'hola'].includes(lower)) {
      reply = `🤖 *FinanceOS v3* (${user.ai_preference})\nComandos: resumen, deudas, historial, ayuda.\nO solo háblame en lenguaje natural (ej. "Borra el último gasto de comida" o "Añade 500 de pasajes").`;
    } else {
      const sysPrompt = await buildSystemPrompt(user);
      reply = await callIA(user, sysPrompt, text + (MediaUrl0 ? `\n[Imagen/Doc adjunto: ${MediaUrl0}]` : ''), phone);
    }
  } catch (err) {
    console.error('Webhook error:', err);
    reply = '❌ Algo salió mal procesando tu petición.';
  }

  if (reply && From) {
    try {
      await twl.messages.create({ from: WA_FROM, to: From, body: reply });
    } catch (err) {
      console.error('Twilio send error:', err);
    }
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'FinanceOS v3 Dual AI ✅' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FinanceOS WhatsApp v3 — puerto ${PORT}`));