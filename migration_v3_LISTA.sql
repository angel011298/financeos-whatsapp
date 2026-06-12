-- FinanceOS Migration v3 — VERSIÓN LISTA CON NÚMEROS REALES
-- Ejecutar en: Supabase → tu proyecto → SQL Editor

-- 1. Historial de conversaciones (reemplaza history en memoria del server)
CREATE TABLE IF NOT EXISTS historial_chat (
  id          bigint generated always as identity primary key,
  user_phone  text not null,
  role        text not null check (role in ('user','assistant')),
  content     text not null,
  created_at  timestamptz default now()
);
CREATE INDEX IF NOT EXISTS idx_chat_phone_time ON historial_chat(user_phone, created_at DESC);
ALTER TABLE historial_chat ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_chat" ON historial_chat;
CREATE POLICY "service_all_chat" ON historial_chat FOR ALL USING (true);

-- 2. Columna tipo_meta en metas (individual vs nidito/pareja)
ALTER TABLE metas ADD COLUMN IF NOT EXISTS tipo_meta text DEFAULT 'individual'
  CHECK (tipo_meta IN ('individual','nidito'));
CREATE INDEX IF NOT EXISTS idx_metas_tipo ON metas(tipo_meta);

-- 3. Modelo de IA específico por usuario
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ai_model text DEFAULT 'claude-sonnet-4-6';

-- 4. Log de notificaciones enviadas (evitar duplicados)
CREATE TABLE IF NOT EXISTS notificaciones_log (
  id          bigint generated always as identity primary key,
  user_phone  text not null,
  tipo        text not null,
  referencia  text,
  enviado_at  timestamptz default now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_unique ON notificaciones_log(user_phone, referencia);
ALTER TABLE notificaciones_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_notif" ON notificaciones_log;
CREATE POLICY "service_all_notif" ON notificaciones_log FOR ALL USING (true);

-- 5. Historial de análisis de estados de cuenta
CREATE TABLE IF NOT EXISTS analisis_estados (
  id          bigint generated always as identity primary key,
  user_phone  text not null,
  banco       text,
  periodo     text,
  resumen     text,
  accion_rec  text,
  created_at  timestamptz default now()
);
ALTER TABLE analisis_estados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_analisis" ON analisis_estados;
CREATE POLICY "service_all_analisis" ON analisis_estados FOR ALL USING (true);

-- 6. Usuarios base con números REALES de Angel y Alicia
INSERT INTO usuarios (telefono, nombre, role, ai_preference, ai_model) VALUES
  ('whatsapp:+525532005195', 'Angel',  'ADMIN_A', 'CLAUDE', 'claude-sonnet-4-6'),
  ('whatsapp:+525524959599', 'Alicia', 'USER_B',  'GEMINI', 'gemini-2.5-flash')
ON CONFLICT (telefono) DO UPDATE SET
  ai_model = EXCLUDED.ai_model;

-- (Opcional) Si hay registros antiguos con user_phone vacío, migrar a Angel:
-- UPDATE tdc        SET user_phone = 'whatsapp:+525532005195' WHERE user_phone = '' OR user_phone IS NULL;
-- UPDATE metas      SET user_phone = 'whatsapp:+525532005195' WHERE user_phone = '' OR user_phone IS NULL;
-- UPDATE movimientos SET user_phone = 'whatsapp:+525532005195' WHERE user_phone = '' OR user_phone IS NULL;
