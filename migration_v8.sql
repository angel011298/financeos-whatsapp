-- FinanceOS Migration v8 — Nidito Renovado: items, asignaciones, comentarios, dinerito
-- Descripción: Esquema completo de Nidito para metas/proyectos compartidos con asignaciones
--   quinzenales y presupuesto conjunto. Incluye soporte para comentarios y adjuntos.
-- Ejecutar en: Supabase → tu proyecto → SQL Editor
-- Idempotente: seguro re-ejecutar múltiples veces
-- RLS: Todas las tablas usan FOR ALL USING (true) — control de acceso en app layer
-- Storage: Crear bucket 'nidito-adjuntos' (privado) manualmente o via CLI:
--   supabase storage buckets create nidito-adjuntos --public=false

-- ── 1. nidito_items — Metas/proyectos del Nidito (corto/mediano/largo plazo) ────
CREATE TABLE IF NOT EXISTS nidito_items (
  id              uuid default gen_random_uuid() primary key,
  tipo            text not null check (tipo in ('PROYECTO','META_CORTO','META_MEDIANO','META_LARGO')),
  titulo          text not null,
  descripcion     text,
  fecha_inicio    date,
  fecha_fin       date,
  presupuesto_total numeric(12,2) default 0,
  estado          text default 'ACTIVO' check (estado in ('ACTIVO','COMPLETADO','PAUSADO')),
  orden           int default 0,
  deleted_at      timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
ALTER TABLE nidito_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_nidito_items" ON nidito_items;
CREATE POLICY "service_all_nidito_items" ON nidito_items FOR ALL USING (true);

CREATE INDEX IF NOT EXISTS idx_nidito_items_tipo   ON nidito_items(tipo);
CREATE INDEX IF NOT EXISTS idx_nidito_items_estado ON nidito_items(estado);
CREATE INDEX IF NOT EXISTS idx_nidito_items_orden  ON nidito_items(orden);

-- ── 2. nidito_asignaciones — Monto asignado por persona a cada ítem ──────────
CREATE TABLE IF NOT EXISTS nidito_asignaciones (
  id                    uuid default gen_random_uuid() primary key,
  item_id               uuid not null references nidito_items(id) on delete cascade,
  user_phone            text not null,
  monto_total_asignado  numeric(12,2) default 0,
  monto_quincenal       numeric(12,2) default 0,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now(),
  unique(item_id, user_phone)
);
ALTER TABLE nidito_asignaciones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_nidito_asignaciones" ON nidito_asignaciones;
CREATE POLICY "service_all_nidito_asignaciones" ON nidito_asignaciones FOR ALL USING (true);

CREATE INDEX IF NOT EXISTS idx_nidito_asignaciones_item ON nidito_asignaciones(item_id);
CREATE INDEX IF NOT EXISTS idx_nidito_asignaciones_user ON nidito_asignaciones(user_phone);

-- ── 3. nidito_comentarios — Comentarios + adjuntos (URLs) por ítem ───────────
CREATE TABLE IF NOT EXISTS nidito_comentarios (
  id              uuid default gen_random_uuid() primary key,
  item_id         uuid not null references nidito_items(id) on delete cascade,
  user_phone      text not null,
  cuerpo          text not null,
  adjuntos        jsonb default '[]'::jsonb,  -- Array de {url, nombre, tipo}
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
ALTER TABLE nidito_comentarios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_nidito_comentarios" ON nidito_comentarios;
CREATE POLICY "service_all_nidito_comentarios" ON nidito_comentarios FOR ALL USING (true);

CREATE INDEX IF NOT EXISTS idx_nidito_comentarios_item    ON nidito_comentarios(item_id);
CREATE INDEX IF NOT EXISTS idx_nidito_comentarios_user    ON nidito_comentarios(user_phone);
CREATE INDEX IF NOT EXISTS idx_nidito_comentarios_created ON nidito_comentarios(created_at DESC);

-- ── 4. nidito_dinerito — Presupuesto quincenal compartido ────────────────────
CREATE TABLE IF NOT EXISTS nidito_dinerito (
  id              uuid default gen_random_uuid() primary key,
  user_phone      text not null,
  quincena_key    text not null,  -- Formato: 'YYYY-MM-A' (días 10-24) | 'YYYY-MM-B' (días 01-09 o 25-31)
  monto           numeric(12,2) default 0,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique(user_phone, quincena_key)
);
ALTER TABLE nidito_dinerito ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_nidito_dinerito" ON nidito_dinerito;
CREATE POLICY "service_all_nidito_dinerito" ON nidito_dinerito FOR ALL USING (true);

CREATE INDEX IF NOT EXISTS idx_nidito_dinerito_quincena ON nidito_dinerito(quincena_key);
CREATE INDEX IF NOT EXISTS idx_nidito_dinerito_user    ON nidito_dinerito(user_phone);

-- ── NOTA: Storage bucket para adjuntos ──────────────────────────────────────
-- Crear manualmente en Supabase:
--   1. Ir a Storage → Create Bucket
--   2. Nombre: "nidito-adjuntos"
--   3. Privacy: Private
--   4. (Opcional) En Policies, permitir acceso auth si quieren que suban los usuarios
--
-- O via Supabase CLI:
--   supabase storage buckets create nidito-adjuntos --public=false

-- ── NOTA: Tabla nidito existente ────────────────────────────────────────────
-- La tabla 'nidito' (metas tipo_meta='nidito') sigue funcionando en paralelo.
-- Los datos NO se migran automáticamente. Eso es trabajo manual en Fase 2.
