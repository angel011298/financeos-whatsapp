-- FinanceOS Migration v6 — usage_log (tokens + costo estimado por llamada IA)
-- Ejecutar en: Supabase → tu proyecto → SQL Editor

CREATE TABLE IF NOT EXISTS usage_log (
  id                bigint generated always as identity primary key,
  user_phone        text not null,
  modelo            text not null,
  input_tokens      integer not null default 0,
  output_tokens     integer not null default 0,
  cache_read_tokens integer not null default 0,
  etapa             text not null check (etapa in ('extractor','conversador','vision')),
  created_at        timestamptz default now()
);

ALTER TABLE usage_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_all_usage_log" ON usage_log;
CREATE POLICY "service_all_usage_log" ON usage_log FOR ALL USING (true);

CREATE INDEX IF NOT EXISTS idx_usage_log_phone_created ON usage_log(user_phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_log_created       ON usage_log(created_at DESC);
