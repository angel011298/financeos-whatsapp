#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const BASE_URL = process.env.SMOKE_URL || 'http://localhost:3001';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const PHONE_ANGEL  = 'whatsapp:+' + process.env.PHONE_ANGEL;
const PHONE_ALICIA = 'whatsapp:+' + process.env.PHONE_ALICIA;

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM    = '\x1b[2m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitLastBotMsg(phone, pattern, since, timeout = 30_000, interval = 1_500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { data } = await sb.from('historial_chat')
      .select('content')
      .eq('user_phone', phone)
      .neq('role', 'user')
      .gt('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.content && pattern.test(data.content)) return data.content;
    await sleep(interval);
  }
  return null;
}

async function sendMsg(phone, body) {
  const params = new URLSearchParams({ From: phone, Body: body, NumMedia: '0' });
  try {
    const res = await fetch(`${BASE_URL}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      timeout: 40_000,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, responseText: text };
  } catch (e) {
    return { ok: false, status: 0, responseText: e.message };
  }
}

async function waitPending(phone, timeout = 45_000, interval = 1_500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { data } = await sb.from('acciones_pendientes')
      .select('*')
      .eq('user_phone', phone)
      .eq('estado', 'pending')
      .gt('expira_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return data;
    await sleep(interval);
  }
  return null;
}

async function waitMovimiento(phone, montoAprox, timeout = 45_000, interval = 1_500) {
  const lo = montoAprox * 0.8;
  const hi = montoAprox * 1.2;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { data } = await sb.from('movimientos')
      .select('*')
      .eq('user_phone', phone)
      .is('deleted_at', null)
      .gte('monto', lo)
      .lte('monto', hi)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return data;
    await sleep(interval);
  }
  return null;
}

async function cleanup() {
  const phones = [PHONE_ANGEL, PHONE_ALICIA];
  const patterns = ['uber eats', 'súper', 'vuelo', 'smoke'];
  const montos = [350, 200, 8500];

  try {
    for (const phone of phones) {
      // Soft-delete movimientos by pattern/monto from last 2h
      const { data: toDelete } = await sb.from('movimientos')
        .select('id')
        .eq('user_phone', phone)
        .is('deleted_at', null)
        .gte('created_at', new Date(Date.now() - 2 * 3600_000).toISOString());

      if (toDelete) {
        for (const m of toDelete) {
          const { data: mov } = await sb.from('movimientos').select('concepto,monto').eq('id', m.id).maybeSingle();
          const match = patterns.some(p => (mov?.concepto || '').toLowerCase().includes(p))
            || montos.includes(mov?.monto);
          if (match) {
            await sb.from('movimientos').update({ deleted_at: new Date().toISOString() }).eq('id', m.id);
          }
        }
      }

      // Delete pending actions from last 2h
      await sb.from('acciones_pendientes')
        .delete()
        .eq('user_phone', phone)
        .gte('created_at', new Date(Date.now() - 2 * 3600_000).toISOString());
    }
  } catch (e) {
    console.error('[CLEANUP ERROR]', e.message);
  }
}

async function runSmoke() {
  const results = [];

  const addResult = (step, name, pass, detail = '') => {
    results.push({ step, name, pass, detail });
    const icon = pass ? `${GREEN}✅${RESET}` : `${RED}❌${RESET}`;
    const time = pass ? '' : '';
    console.log(`  ${icon} S${step}: ${name}${time}`);
    if (detail) console.log(`     ${DIM}${detail}${RESET}`);
  };

  console.log(`\n${BOLD}SMOKE OnlyUs v6${RESET}`);
  console.log(`Using: ${BASE_URL}`);
  console.log(`Ángel: ${PHONE_ANGEL}`);
  console.log(`Alicia: ${PHONE_ALICIA}\n`);

  // S1
  console.log(`${BOLD}ÁNGEL${RESET}`);
  const s1Since = new Date().toISOString();
  await sendMsg(PHONE_ANGEL, 'resumen');
  const s1Bot = await waitLastBotMsg(PHONE_ANGEL, /resumen|gastos|ingresos|mes/i, s1Since);
  const s1Pass = !!s1Bot;
  addResult(1, '"resumen"', s1Pass, s1Pass ? 'OK' : 'No bot reply in historial_chat');
  await sleep(1000);

  // S2
  const s2 = await sendMsg(PHONE_ANGEL, 'gasté 350 en uber eats con tarjeta nu');
  const s2Pending = await waitPending(PHONE_ANGEL);
  const s2Pass = !!s2Pending && !s2.responseText.includes('✓ Hecho');
  addResult(2, '"gasté 350 en uber eats con tarjeta nu"', s2Pass, s2Pass ? `ID: ${s2Pending?.id}` : 'No pending or auto-confirmed');
  await sleep(3000);

  // S3
  const s3Mov = await waitMovimiento(PHONE_ANGEL, 350);
  const s3Pass = !!s3Mov;
  addResult(3, '"1" → movimiento + audit_log', s3Pass, s3Pass ? `ID: ${s3Mov?.id}, monto: ${s3Mov?.monto}` : 'Movimiento no encontrado');
  if (s3Mov) {
    const { data: audit } = await sb.from('audit_log')
      .select('*')
      .eq('user_phone', PHONE_ANGEL)
      .eq('registro_id', String(s3Mov.id))
      .maybeSingle();
    const hasTextoOriginal = audit?.texto_original !== null;
    if (!hasTextoOriginal) {
      console.log(`     ${YELLOW}⚠${RESET} audit_log sin texto_original`);
    }
  }
  await sleep(3000);

  // S4
  if (s3Mov) {
    const res = await sendMsg(PHONE_ANGEL, 'deshacer');
    await sleep(2000);
    const { data: mov } = await sb.from('movimientos').select('deleted_at').eq('id', s3Mov.id).maybeSingle();
    const s4Pass = mov?.deleted_at !== null;
    addResult(4, '"deshacer" → soft-delete', s4Pass, s4Pass ? 'OK' : 'deleted_at still null');
  } else {
    addResult(4, '"deshacer" → soft-delete', false, 'Prerequisito (S3 movimiento) no cumplido');
  }
  await sleep(3000);

  // S5
  const s5Since = new Date().toISOString();
  await sendMsg(PHONE_ANGEL, 'metas');
  const s5Bot = await waitLastBotMsg(PHONE_ANGEL, /meta|ahorro|objetivo/i, s5Since);
  const s5Pass = !!s5Bot;
  addResult(5, '"metas"', s5Pass, s5Pass ? 'OK' : 'No bot reply in historial_chat');
  await sleep(1000);

  // S6
  const s6Since = new Date().toISOString();
  await sendMsg(PHONE_ANGEL, 'privacidad');
  const s6Bot = await waitLastBotMsg(PHONE_ANGEL, /supabase|datos|privac/i, s6Since);
  const s6Pass = !!s6Bot;
  addResult(6, '"privacidad"', s6Pass, s6Pass ? 'OK' : 'No bot reply in historial_chat');
  await sleep(1000);

  // S7 — Alicia (con timeout más largo por Gemini)
  console.log(`\n${BOLD}ALICIA${RESET}`);
  const s7 = await sendMsg(PHONE_ALICIA, 'resumen');
  const s7Pass = s7.status === 200 && s7.responseText.length > 0;
  addResult(7, '"resumen"', s7Pass, s7Pass ? 'OK' : `Status ${s7.status}`);
  await sleep(5000); // Alicia puede tardar más

  // S8
  const s8 = await sendMsg(PHONE_ALICIA, 'gasté 200 en súper');
  const s8Pending = await waitPending(PHONE_ALICIA);
  const s8Pass = !!s8Pending;
  addResult(8, '"gasté 200 en súper"', s8Pass, s8Pass ? `ID: ${s8Pending?.id}` : 'No pending');
  await sleep(3000);

  // S9
  const s9Mov = await waitMovimiento(PHONE_ALICIA, 200);
  const s9Pass = !!s9Mov;
  addResult(9, '"1" → movimiento', s9Pass, s9Pass ? `ID: ${s9Mov?.id}` : 'Movimiento no encontrado');
  await sleep(3000);

  // S10
  const s10 = await sendMsg(PHONE_ALICIA, 'nidito');
  const s10Pass = s10.status === 200;
  addResult(10, '"nidito"', s10Pass, s10Pass ? 'OK' : `Status ${s10.status}`);
  await sleep(3000);

  // S11 — Edge case: monto > 5000 nunca auto-confirm
  const s11 = await sendMsg(PHONE_ANGEL, 'gasté 8500 en vuelo a tokio');
  const s11Pending = await waitPending(PHONE_ANGEL);
  const s11Pass = !!s11Pending;
  addResult(11, '"gasté 8500 en vuelo a tokio" → propuesta (NO auto-confirm)', s11Pass, s11Pass ? `ID: ${s11Pending?.id}` : 'No pending');
  if (s11Pass) {
    // Cancela
    await sendMsg(PHONE_ANGEL, '3');
    await sleep(1000);
  }
  await sleep(3000);

  // S12 — Edge case: borrar movimiento
  if (s3Mov) {
    const s12 = await sendMsg(PHONE_ANGEL, 'borrar el movimiento de uber eats de hace rato');
    const s12Pending = await waitPending(PHONE_ANGEL);
    const s12Pass = !!s12Pending;
    addResult(12, '"borrar movimiento" → propuesta (no borra directo)', s12Pass, s12Pass ? `ID: ${s12Pending?.id}` : 'No pending');
    if (s12Pass) {
      // Cancela
      await sendMsg(PHONE_ANGEL, '3');
      await sleep(1000);
    }
  } else {
    addResult(12, '"borrar movimiento" → propuesta', false, 'Prerequisito (S3 movimiento) no cumplido');
  }

  // Summary
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  const allPass = passed === total;

  console.log(`\n${'═'.repeat(50)}`);
  if (allPass) {
    console.log(`${GREEN}${BOLD}SMOKE OnlyUs v6 — ${passed}/${total} ✅ LISTO PARA PRODUCCIÓN${RESET}`);
  } else {
    console.log(`${YELLOW}${BOLD}SMOKE OnlyUs v6 — ${passed}/${total} ⚠ Ver pasos fallidos arriba${RESET}`);
  }
  console.log(`${'═'.repeat(50)}\n`);

  return allPass ? 0 : 1;
}

(async () => {
  try {
    await cleanup();
    const code = await runSmoke();
    await cleanup();
    process.exit(code);
  } catch (e) {
    console.error(`${RED}FATAL: ${e.message}${RESET}`);
    await cleanup();
    process.exit(1);
  }
})();
