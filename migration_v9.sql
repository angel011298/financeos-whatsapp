-- FinanceOS Migration v9 — Despensa: nombre_oficial + compra_quincena
-- Ejecutar en: Supabase → tu proyecto → SQL Editor
-- Idempotente: seguro re-ejecutar

ALTER TABLE despensa
  ADD COLUMN IF NOT EXISTS nombre_oficial   text,
  ADD COLUMN IF NOT EXISTS compra_quincena  boolean DEFAULT true;
