-- FinanceOS Migration v7 — Agregar texto_original a audit_log
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS texto_original text;
