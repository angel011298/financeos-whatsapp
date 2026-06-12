-- FinanceOS Migration v5 — campo revisado en movimientos
-- Ejecutar en: Supabase → tu proyecto → SQL Editor

ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS revisado boolean DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_movs_revisado ON movimientos(user_phone, revisado) WHERE revisado = false;
