-- FinanceOS Migration v4 — acciones_pendientes + audit_log + soft-delete
-- Ejecutar en: Supabase → tu proyecto → SQL Editor

-- 1. Soft-delete en tablas operativas (IA ya no borra físicamente)
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE metas       ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE calendario  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE nidito      ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_movs_deleted    ON movimientos(user_phone, deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_metas_deleted   ON metas(user_phone, deleted_at)      WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cal_deleted     ON calendario(user_phone, deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_nidito_deleted  ON nidito(deleted_at)                 WHERE deleted_at IS NULL;

-- 2. Acciones pendientes (confirmaciones diferidas del asistente de IA)
CREATE TABLE IF NOT EXISTS acciones_pendientes (
  id          bigint generated always as identity primary key,
  user_phone  text not null,
  tipo        text not null check (tipo in ('db_action','confirmacion','recordatorio')),
  datos       jsonb not null default '{}'::jsonb,
  estado      text not null default 'pending' check (estado in ('pending','done','expired','cancelled')),
  expira_at   timestamptz not null default (now() + interval '24 hours'),
  created_at  timestamptz default now()
);
ALTER TABLE acciones_pendientes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_acciones" ON acciones_pendientes;
CREATE POLICY "service_all_acciones" ON acciones_pendientes FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_acciones_user_estado_expira
  ON acciones_pendientes(user_phone, estado, expira_at);

-- 2. Audit log (trazabilidad de todas las modificaciones de IA sobre la DB)
CREATE TABLE IF NOT EXISTS audit_log (
  id            bigint generated always as identity primary key,
  user_phone    text not null,
  tabla         text not null,
  accion        text not null check (accion in ('crear','editar','eliminar')),
  registro_id   text,
  datos_antes   jsonb,
  datos_despues jsonb,
  origen        text default 'whatsapp' check (origen in ('whatsapp','web','api','cron')),
  created_at    timestamptz default now()
);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_audit" ON audit_log;
CREATE POLICY "service_all_audit" ON audit_log FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_audit_user_created
  ON audit_log(user_phone, created_at DESC);
