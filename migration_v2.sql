-- FinanceOS Migration v2 — Ejecuta en Supabase SQL Editor

-- 1. Tabla usuarios
CREATE TABLE IF NOT EXISTS usuarios (
  id            bigint generated always as identity primary key,
  telefono      text not null unique,
  nombre        text default '',
  role          text default 'USER_B' check (role in ('ADMIN_A','USER_B')),
  ai_preference text default 'CLAUDE' check (ai_preference in ('CLAUDE','GEMINI')),
  created_at    timestamptz default now()
);
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_usuarios" ON usuarios;
CREATE POLICY "service_all_usuarios" ON usuarios FOR ALL USING (true);

-- 2. Columnas nuevas en movimientos
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS user_phone  text NOT NULL DEFAULT '';
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS concepto    text DEFAULT '';
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS comentarios text DEFAULT '';
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS medio_pago  text DEFAULT 'efectivo';

-- 3. user_phone en tdc y metas
ALTER TABLE tdc   ADD COLUMN IF NOT EXISTS user_phone text NOT NULL DEFAULT '';
ALTER TABLE metas ADD COLUMN IF NOT EXISTS user_phone text NOT NULL DEFAULT '';

-- 4. Tabla calendario
CREATE TABLE IF NOT EXISTS calendario (
  id          bigint generated always as identity primary key,
  user_phone  text not null,
  titulo      text not null,
  fecha       date not null,
  hora        time,
  descripcion text default '',
  tipo        text default 'evento' check (tipo in ('evento','recordatorio','cumpleaños','cita','tarea','otro')),
  recurrente  text default 'no' check (recurrente in ('no','diario','semanal','mensual','anual')),
  notificado  boolean default false,
  created_at  timestamptz default now()
);
ALTER TABLE calendario ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_calendario" ON calendario;
CREATE POLICY "service_all_calendario" ON calendario FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_cal_phone_fecha ON calendario(user_phone, fecha);

-- 5. Tabla patrones_ia (aprendizaje automático)
CREATE TABLE IF NOT EXISTS patrones_ia (
  id               bigint generated always as identity primary key,
  user_phone       text not null,
  concepto_clave   text not null,
  categoria        text,
  medio_pago_usual text,
  monto_promedio   numeric(12,2),
  contador         int default 1,
  ultima_vez       date,
  sugerencias      text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  UNIQUE(user_phone, concepto_clave)
);
ALTER TABLE patrones_ia ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_patrones" ON patrones_ia;
CREATE POLICY "service_all_patrones" ON patrones_ia FOR ALL USING (true);

-- 6. Tabla presupuesto mensual
CREATE TABLE IF NOT EXISTS presupuesto (
  id          bigint generated always as identity primary key,
  user_phone  text not null,
  categoria   text not null,
  mes         text not null,
  limite      numeric(12,2) default 0,
  created_at  timestamptz default now(),
  UNIQUE(user_phone, categoria, mes)
);
ALTER TABLE presupuesto ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_presupuesto" ON presupuesto;
CREATE POLICY "service_all_presupuesto" ON presupuesto FOR ALL USING (true);

-- 7. Índices
CREATE INDEX IF NOT EXISTS idx_movs_user_phone ON movimientos(user_phone);
CREATE INDEX IF NOT EXISTS idx_movs_fecha      ON movimientos(user_phone, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_tdc_user_phone  ON tdc(user_phone);
CREATE INDEX IF NOT EXISTS idx_metas_user      ON metas(user_phone);

-- 8. IMPORTANTE: actualiza tus TDC existentes con tu número real de WhatsApp
-- Reemplaza 521XXXXXXXXXX con tu número (sin +, sin espacios):
-- UPDATE tdc   SET user_phone = 'whatsapp:+521XXXXXXXXXX' WHERE user_phone = '';
-- UPDATE metas SET user_phone = 'whatsapp:+521XXXXXXXXXX' WHERE user_phone = '';

-- 9. Perfil personal — info quincenal y gastos fijos (migration v3)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS external_refs jsonb DEFAULT '{}'::jsonb;
-- Almacena: { ingreso_quincenal, dias_pago, gastos_fijos: { categoria: monto } }
