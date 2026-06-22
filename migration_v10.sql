-- FinanceOS Migration v10 — Módulo Negocios y Proyectos
-- Ejecutar en: Supabase → tu proyecto → SQL Editor
-- Idempotente: seguro re-ejecutar

CREATE TABLE IF NOT EXISTS neg_proyectos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_phone         text REFERENCES usuarios(telefono) ON DELETE SET NULL,
  nombre             text NOT NULL,
  descripcion        text,
  tipo               text NOT NULL DEFAULT 'NEGOCIO'
                     CHECK (tipo IN ('NEGOCIO','EMPRENDIMIENTO','PROYECTO','INVERSION','FREELANCE')),
  estado             text NOT NULL DEFAULT 'ACTIVO'
                     CHECK (estado IN ('ACTIVO','PAUSADO','CERRADO')),
  fecha_inicio       date,
  fecha_vencimiento  date,
  monto_meta         numeric(14,2) DEFAULT 0,
  capital_inicial    numeric(14,2) DEFAULT 0,
  color              text,
  icono              text,
  orden              int DEFAULT 0,
  deleted_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_negp_phone  ON neg_proyectos(user_phone);
CREATE INDEX IF NOT EXISTS idx_negp_estado ON neg_proyectos(estado);

CREATE TABLE IF NOT EXISTS neg_transacciones (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id        uuid NOT NULL REFERENCES neg_proyectos(id) ON DELETE CASCADE,
  tipo               text NOT NULL CHECK (tipo IN ('INGRESO','GASTO','INVERSION')),
  concepto           text,
  monto              numeric(14,2) NOT NULL,
  categoria          text,
  fecha              date NOT NULL,
  quincena_key       text,
  metodo_pago        text,
  comentarios        text,
  reflejo_personal   text CHECK (reflejo_personal IN ('RETIRO','APORTE')),
  reflejo_user_phone text REFERENCES usuarios(telefono) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_negt_proyecto ON neg_transacciones(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_negt_quincena ON neg_transacciones(quincena_key);
CREATE INDEX IF NOT EXISTS idx_negt_reflejo  ON neg_transacciones(reflejo_personal, reflejo_user_phone);

CREATE TABLE IF NOT EXISTS neg_deudores (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id        uuid NOT NULL REFERENCES neg_proyectos(id) ON DELETE CASCADE,
  nombre             text NOT NULL,
  contacto           text,
  monto_original     numeric(14,2) NOT NULL,
  monto_pagado       numeric(14,2) NOT NULL DEFAULT 0,
  fecha_origen       date,
  fecha_vencimiento  date,
  estado             text NOT NULL DEFAULT 'PENDIENTE'
                     CHECK (estado IN ('PENDIENTE','PARCIAL','PAGADO','INCOBRABLE')),
  notas              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_negd_proyecto ON neg_deudores(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_negd_venc     ON neg_deudores(fecha_vencimiento);

CREATE TABLE IF NOT EXISTS neg_acreedores (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id        uuid NOT NULL REFERENCES neg_proyectos(id) ON DELETE CASCADE,
  nombre             text NOT NULL,
  contacto           text,
  monto_original     numeric(14,2) NOT NULL,
  monto_pagado       numeric(14,2) NOT NULL DEFAULT 0,
  fecha_origen       date,
  fecha_vencimiento  date,
  estado             text NOT NULL DEFAULT 'PENDIENTE'
                     CHECK (estado IN ('PENDIENTE','PARCIAL','PAGADO','INCOBRABLE')),
  notas              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nega_proyecto ON neg_acreedores(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_nega_venc     ON neg_acreedores(fecha_vencimiento);

CREATE TABLE IF NOT EXISTS neg_inversiones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id     uuid NOT NULL REFERENCES neg_proyectos(id) ON DELETE CASCADE,
  nombre          text NOT NULL,
  categoria       text CHECK (categoria IN ('MATERIAL','PRODUCTO','EQUIPO','MARKETING','OTRO')),
  monto_estimado  numeric(14,2) DEFAULT 0,
  fecha_objetivo  date,
  prioridad       text DEFAULT 'MEDIA' CHECK (prioridad IN ('ALTA','MEDIA','BAJA')),
  estado          text DEFAULT 'PLANEADA' CHECK (estado IN ('PLANEADA','EN_CURSO','COMPLETADA','CANCELADA')),
  notas           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_negi_proyecto  ON neg_inversiones(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_negi_objetivo  ON neg_inversiones(fecha_objetivo);

CREATE TABLE IF NOT EXISTS neg_bloques (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id uuid NOT NULL REFERENCES neg_proyectos(id) ON DELETE CASCADE,
  tipo        text NOT NULL CHECK (tipo IN ('TABLA','NOTA','LISTA','RECORDATORIO','GRAFICA')),
  titulo      text,
  contenido   jsonb NOT NULL DEFAULT '{}'::jsonb,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  orden       int DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_negb_proyecto ON neg_bloques(proyecto_id);

ALTER TABLE neg_proyectos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE neg_transacciones  ENABLE ROW LEVEL SECURITY;
ALTER TABLE neg_deudores       ENABLE ROW LEVEL SECURITY;
ALTER TABLE neg_acreedores     ENABLE ROW LEVEL SECURITY;
ALTER TABLE neg_inversiones    ENABLE ROW LEVEL SECURITY;
ALTER TABLE neg_bloques        ENABLE ROW LEVEL SECURITY;

CREATE POLICY neg_proyectos_all     ON neg_proyectos     FOR ALL USING (true);
CREATE POLICY neg_transacciones_all ON neg_transacciones FOR ALL USING (true);
CREATE POLICY neg_deudores_all      ON neg_deudores      FOR ALL USING (true);
CREATE POLICY neg_acreedores_all    ON neg_acreedores    FOR ALL USING (true);
CREATE POLICY neg_inversiones_all   ON neg_inversiones   FOR ALL USING (true);
CREATE POLICY neg_bloques_all       ON neg_bloques       FOR ALL USING (true);
