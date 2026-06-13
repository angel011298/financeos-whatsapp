#!/usr/bin/env node
'use strict';

// Load env from project root before anything else
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });

const { test }         = require('node:test');
const assert           = require('node:assert/strict');
const { spawn }        = require('node:child_process');
const path             = require('node:path');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase direct (for assertions and fixture management) ───────────────────
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const BASE   = 'http://localhost:3001';
const ANGEL  = 'whatsapp:+52TEST0000001';
const ALICIA = 'whatsapp:+52TEST0000002';

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pollUntil(fn, timeout = 45_000, interval = 1_500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(interval);
  }
  return null;
}

async function wh(phone, body) {
  const params = new URLSearchParams({ From: phone, Body: body });
  return fetch(`${BASE}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}

async function lastPending(phone) {
  const { data } = await sb.from('acciones_pendientes')
    .select('*')
    .eq('user_phone', phone)
    .eq('estado', 'pending')
    .gt('expira_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function lastMovimiento(phone) {
  const { data } = await sb.from('movimientos')
    .select('*')
    .eq('user_phone', phone)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function movimientoById(id) {
  const { data } = await sb.from('movimientos').select('*').eq('id', id).maybeSingle();
  return data || null;
}

async function cleanupPhone(phone) {
  await Promise.allSettled([
    sb.from('movimientos').delete().eq('user_phone', phone),
    sb.from('acciones_pendientes').delete().eq('user_phone', phone),
    sb.from('audit_log').delete().eq('user_phone', phone),
    sb.from('historial_chat').delete().eq('user_phone', phone),
    sb.from('metas').delete().eq('user_phone', phone),
    sb.from('usage_log').delete().eq('user_phone', phone),
    sb.from('patrones_ia').delete().eq('user_phone', phone),
    sb.from('presupuesto').delete().eq('user_phone', phone),
    sb.from('tdc').delete().eq('user_phone', phone),
    sb.from('calendario').delete().eq('user_phone', phone),
  ]);
}

// ── Main test (all subtests run sequentially via await) ───────────────────────
test('FinanceOS Integration Tests', { timeout: 300_000 }, async (t) => {
  let serverProc;
  const state = {
    angelMovId:  null,
    aliciaMovId: null,
  };

  // Track results for final summary
  const summary = { passed: 0, failed: 0, failedNames: [] };
  async function run(name, fn) {
    await t.test(name, async () => {
      try {
        await fn();
        summary.passed++;
      } catch (err) {
        summary.failed++;
        summary.failedNames.push(name);
        throw err;
      }
    });
  }

  try {
    // ── SERVER STARTUP ───────────────────────────────────────────────────────
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd:   path.join(__dirname, '..'),
      env:   { ...process.env, PORT: '3001' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', () => {});
    serverProc.stderr.on('data', () => {});
    serverProc.on('error', err => { throw err; });

    const ready = await pollUntil(async () => {
      try {
        const r = await fetch(`${BASE}/api/health`);
        return r.ok;
      } catch { return false; }
    }, 30_000, 1_000);
    assert.ok(ready, 'Server did not start on port 3001 within 30 s');

    // ── DB FIXTURES ──────────────────────────────────────────────────────────
    await cleanupPhone(ANGEL);
    await cleanupPhone(ALICIA);
    await sb.from('usuarios').delete().in('telefono', [ANGEL, ALICIA]);
    const { error: uErr } = await sb.from('usuarios').insert([
      { telefono: ANGEL,  nombre: 'TestAngel',  role: 'ADMIN_A', ai_preference: 'GEMINI', ai_model: 'gemini-2.5-flash' },
      { telefono: ALICIA, nombre: 'TestAlicia', role: 'USER_B',  ai_preference: 'GEMINI', ai_model: 'gemini-2.5-flash' },
    ]);
    assert.ok(!uErr, `Failed to insert test users: ${uErr?.message}`);

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 1 — Ángel (Claude)
    // ─────────────────────────────────────────────────────────────────────────

    await run('T1 Angel — "gasté 80 en café" crea acción pendiente', async () => {
      const res = await wh(ANGEL, 'gasté 80 en café');
      assert.equal(res.status, 200, 'Webhook no devolvió 200');

      const pending = await pollUntil(() => lastPending(ANGEL));
      assert.ok(pending, 'No se encontró acción pendiente (estado=pending, expira_at>now) en T1');
      assert.equal(pending.estado, 'pending');

      const monto = pending.datos?.datos?.monto;
      assert.equal(monto, 80, `Monto esperado 80, got ${monto}`);
    });

    await run('T2 Angel — "1" confirma y crea movimiento con texto_original en audit_log', async () => {
      const res = await wh(ANGEL, '1');
      assert.equal(res.status, 200);

      // Poll until movimiento appears in DB (monto=80, not deleted)
      const mov = await pollUntil(async () => {
        const m = await lastMovimiento(ANGEL);
        return m && m.monto === 80 && m.deleted_at === null ? m : null;
      });
      assert.ok(mov, 'Movimiento con monto=80 no fue creado en T2');
      assert.strictEqual(mov.monto, 80);
      assert.strictEqual(mov.deleted_at, null);
      state.angelMovId = mov.id;

      // Poll for audit_log entry with texto_original
      const auditRow = await pollUntil(async () => {
        const { data } = await sb.from('audit_log')
          .select('texto_original')
          .eq('user_phone', ANGEL)
          .eq('accion', 'crear')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        return data?.texto_original ? data : null;
      });
      assert.ok(auditRow,              'audit_log no tiene fila accion=crear para ANGEL en T2');
      assert.ok(auditRow.texto_original, 'texto_original es null/vacío en audit_log T2');
    });

    await run('T3 Angel — "deshacer" hace soft-delete del movimiento', async () => {
      assert.ok(state.angelMovId, 'Prerequisito: angelMovId debe estar seteado desde T2');

      const res = await wh(ANGEL, 'deshacer');
      assert.equal(res.status, 200);

      const deleted = await pollUntil(async () => {
        const m = await movimientoById(state.angelMovId);
        return m?.deleted_at ? m : null;
      });
      assert.ok(deleted,          'Movimiento no fue soft-deleted tras "deshacer" en T3');
      assert.ok(deleted.deleted_at, 'deleted_at sigue null tras deshacer T3');
    });

    await run('T4 Angel — "borrar el movimiento X" crea propuesta (no borra directo)', async () => {
      const res = await wh(ANGEL, `borrar el movimiento ${state.angelMovId}`);
      assert.equal(res.status, 200);

      const pending = await pollUntil(() => lastPending(ANGEL));
      assert.ok(pending, 'No se creó propuesta de eliminación en T4');
      assert.equal(pending.estado, 'pending');

      // The proposal should be ELIMINACION, not auto-executed
      const mov = await movimientoById(state.angelMovId);
      assert.ok(mov, 'El movimiento desapareció antes de confirmar en T4');
    });

    await run('T5 Angel — "3" cancela la propuesta', async () => {
      const res = await wh(ANGEL, '3');
      assert.equal(res.status, 200);

      const cancelled = await pollUntil(async () => {
        const { data } = await sb.from('acciones_pendientes')
          .select('id, estado')
          .eq('user_phone', ANGEL)
          .in('estado', ['cancelled', 'cancelada'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        return data || null;
      });
      assert.ok(cancelled, 'Acción pendiente de T4 no fue cancelada en T5');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 2 — Alicia (Gemini) — same 5 scenarios
    // ─────────────────────────────────────────────────────────────────────────

    await run('T6 Alicia — "gasté 90 en farmacia" crea acción pendiente', async () => {
      const res = await wh(ALICIA, 'gasté 90 en farmacia');
      assert.equal(res.status, 200);

      const pending = await pollUntil(() => lastPending(ALICIA));
      assert.ok(pending, 'No se encontró acción pendiente para Alicia en T6');
      assert.equal(pending.estado, 'pending');

      const monto = pending.datos?.datos?.monto;
      assert.equal(monto, 90, `Monto esperado 90, got ${monto}`);
    });

    await run('T7 Alicia — "1" confirma y crea movimiento con texto_original en audit_log', async () => {
      const res = await wh(ALICIA, '1');
      assert.equal(res.status, 200);

      const mov = await pollUntil(async () => {
        const m = await lastMovimiento(ALICIA);
        return m && m.monto === 90 && m.deleted_at === null ? m : null;
      });
      assert.ok(mov, 'Movimiento con monto=90 no fue creado para Alicia en T7');
      assert.strictEqual(mov.monto, 90);
      state.aliciaMovId = mov.id;

      const auditRow = await pollUntil(async () => {
        const { data } = await sb.from('audit_log')
          .select('texto_original')
          .eq('user_phone', ALICIA)
          .eq('accion', 'crear')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        return data?.texto_original ? data : null;
      });
      assert.ok(auditRow,               'audit_log no tiene fila accion=crear para ALICIA en T7');
      assert.ok(auditRow.texto_original, 'texto_original es null en audit_log T7');
    });

    await run('T8 Alicia — "deshacer" hace soft-delete del movimiento', async () => {
      assert.ok(state.aliciaMovId, 'Prerequisito: aliciaMovId debe estar seteado desde T7');

      const res = await wh(ALICIA, 'deshacer');
      assert.equal(res.status, 200);

      const deleted = await pollUntil(async () => {
        const m = await movimientoById(state.aliciaMovId);
        return m?.deleted_at ? m : null;
      });
      assert.ok(deleted, 'Movimiento de Alicia no fue soft-deleted en T8');
    });

    await run('T9 Alicia — propuesta de borrar movimiento por ID', async () => {
      const res = await wh(ALICIA, `borrar el movimiento ${state.aliciaMovId}`);
      assert.equal(res.status, 200);

      const pending = await pollUntil(() => lastPending(ALICIA));
      assert.ok(pending, 'No se creó propuesta de eliminación para Alicia en T9');
      assert.equal(pending.estado, 'pending');
    });

    await run('T10 Alicia — "3" cancela la propuesta', async () => {
      const res = await wh(ALICIA, '3');
      assert.equal(res.status, 200);

      const cancelled = await pollUntil(async () => {
        const { data } = await sb.from('acciones_pendientes')
          .select('id')
          .eq('user_phone', ALICIA)
          .in('estado', ['cancelled', 'cancelada'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        return data || null;
      });
      assert.ok(cancelled, 'Acción pendiente de T9 no fue cancelada en T10');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 3 — PWA endpoints
    // ─────────────────────────────────────────────────────────────────────────

    await run('T11 GET /api/dashboard → 200 + data.movs es array', async () => {
      const phone = encodeURIComponent(ANGEL);
      const res = await fetch(`${BASE}/api/dashboard/${phone}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.success,                 'Dashboard no retornó success=true');
      assert.ok(Array.isArray(body.data?.movs), 'body.data.movs no es array');
      // gastosHoy se computa del lado cliente; verificamos que la raw data permite calcularlo
      const gastosHoy = (body.data.movs || [])
        .filter(m => m.tipo === 'GASTO' && m.fecha === new Date().toISOString().split('T')[0])
        .reduce((a, m) => a + (m.monto || 0), 0);
      assert.ok(gastosHoy >= 0, 'gastosHoy no es >= 0');
    });

    await run('T12 GET /api/rebalanceo → 200 + data.sugerencias es array', async () => {
      const phone = encodeURIComponent(ANGEL);
      const res = await fetch(`${BASE}/api/rebalanceo/${phone}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.success,                          'Rebalanceo no retornó success=true');
      assert.ok(Array.isArray(body.data?.sugerencias), 'body.data.sugerencias no es array');
    });

    await run('T13 GET /api/costos/2026-06 → 200 para ADMIN_A', async () => {
      const phone = encodeURIComponent(ANGEL);
      const res = await fetch(`${BASE}/api/costos/2026-06?phone=${phone}`);
      assert.equal(res.status, 200, 'Costos devolvió status inesperado');
      const body = await res.json();
      assert.ok(body.success, `Costos falló: ${JSON.stringify(body)}`);
      assert.ok(typeof body.data?.totalUSD === 'number', 'totalUSD no es número');
    });

    await run('T14 POST /api/movimientos → success + movimiento creado', async () => {
      const res = await fetch(`${BASE}/api/movimientos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_phone:  ANGEL,
          tipo:        'GASTO',
          monto:       50,
          categoria:   'Comida',
          concepto:    'test-directo',
          fecha:       new Date().toISOString().split('T')[0],
          medio_pago:  'efectivo',
        }),
      });
      assert.ok(res.status < 300, `POST /api/movimientos status inesperado: ${res.status}`);
      const body = await res.json();
      assert.ok(body.success, `POST /api/movimientos falló: ${JSON.stringify(body)}`);
      assert.ok(body.data?.id,  'Movimiento creado no tiene id');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 4 — Edge cases
    // ─────────────────────────────────────────────────────────────────────────

    await run('T15 Monto > 5000 siempre genera propuesta (nunca auto-confirm)', async () => {
      // Cancel any leftover pending for Angel
      await sb.from('acciones_pendientes')
        .update({ estado: 'cancelada' })
        .eq('user_phone', ANGEL)
        .eq('estado', 'pending');

      const res = await wh(ANGEL, 'gasté 9000 en renta con TDC BBVA');
      assert.equal(res.status, 200);

      const pending = await pollUntil(() => lastPending(ANGEL));
      assert.ok(pending, 'No se creó propuesta para monto > 5000 en T15');

      const monto = pending.datos?.datos?.monto;
      assert.ok(monto >= 5000, `Monto esperado >= 5000, got ${monto}`);

      // Cleanup — cancel so it doesn't interfere with T16/T17
      await sb.from('acciones_pendientes')
        .update({ estado: 'cancelada' })
        .eq('id', pending.id);
    });

    await run('T16 Comando "privacidad" → servidor responde 200 y sigue healthy', async () => {
      const res = await wh(ANGEL, 'privacidad');
      assert.equal(res.status, 200, 'Webhook no devolvió 200 para "privacidad"');
      await sleep(2_000); // Brief wait; no DB changes expected
      const health = await fetch(`${BASE}/api/health`);
      assert.ok(health.ok, 'Servidor no healthy tras comando "privacidad"');
      const body = await health.json();
      assert.ok(body.status, 'Health endpoint no retornó status');
    });

    await run('T17 Acción expirada — "1" no la ejecuta ni crea movimiento extra', async () => {
      // Cancel any active pending first
      await sb.from('acciones_pendientes')
        .update({ estado: 'cancelada' })
        .eq('user_phone', ANGEL)
        .eq('estado', 'pending');

      // Insert expired pending action directly to DB
      const pastTs = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
      await sb.from('acciones_pendientes').insert({
        user_phone: ANGEL,
        tipo:       'db_action',
        datos: {
          tabla:  'movimientos',
          accion: 'crear',
          datos: {
            tipo: 'GASTO', categoria: 'OTROS', concepto: 'expirado-test',
            monto: 999, medio_pago: 'efectivo',
            fecha: new Date().toISOString().split('T')[0],
          },
          texto_original: 'expirado-test',
        },
        estado:    'pending',
        expira_at: pastTs,
      });

      // Count movimientos for Angel before sending "1"
      const { count: before } = await sb.from('movimientos')
        .select('id', { count: 'exact', head: true })
        .eq('user_phone', ANGEL);

      await wh(ANGEL, '1');
      await sleep(5_000); // Wait for webhook processing

      // Count movimientos after — should be identical (expired action not executed)
      const { count: after } = await sb.from('movimientos')
        .select('id', { count: 'exact', head: true })
        .eq('user_phone', ANGEL);

      assert.strictEqual(
        after,
        before,
        `Acción expirada fue ejecutada: movimientos antes=${before}, después=${after}`
      );
    });

  } finally {
    // ── CLEANUP ──────────────────────────────────────────────────────────────
    try {
      await cleanupPhone(ANGEL);
      await cleanupPhone(ALICIA);
      await sb.from('usuarios').delete().in('telefono', [ANGEL, ALICIA]);
    } catch (e) {
      console.error('[CLEANUP ERROR]', e.message);
    }
    if (serverProc) {
      serverProc.kill('SIGTERM');
      await sleep(800);
    }
  }

  // ── SUMMARY ──────────────────────────────────────────────────────────────────
  const total = summary.passed + summary.failed;
  console.log(`\n${'─'.repeat(54)}`);
  console.log(`PASSED: ${summary.passed}  FAILED: ${summary.failed}  TOTAL: ${total}`);
  if (summary.failed > 0) {
    console.log('\nFailed tests:');
    summary.failedNames.forEach(n => console.log(`  ✗ ${n}`));
  }
  console.log('─'.repeat(54));
});
