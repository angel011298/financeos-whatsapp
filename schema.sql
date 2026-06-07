-- FinanceOS WhatsApp — Supabase Schema
-- Ejecuta esto en: supabase.com → tu proyecto → SQL Editor

-- ── MOVIMIENTOS (gastos e ingresos) ─────────────────────────────────────────
create table if not exists movimientos (
  id          bigint generated always as identity primary key,
  tipo        text not null check (tipo in ('GASTO','INGRESO')),
  categoria   text not null default 'OTROS',
  descripcion text not null default '',
  monto       numeric(12,2) not null default 0,
  fecha       date not null default current_date,
  created_at  timestamptz default now()
);

create index if not exists idx_movimientos_fecha on movimientos(fecha desc);
create index if not exists idx_movimientos_tipo  on movimientos(tipo);

-- ── TDC (deudas de tarjetas de crédito) ─────────────────────────────────────
create table if not exists tdc (
  id               bigint generated always as identity primary key,
  nombre           text not null unique,
  deuda_original   numeric(12,2) default 0,
  a_pagar          numeric(12,2) default 0,
  pagado           numeric(12,2) default 0,
  estado           text default 'activo' check (estado in ('urgente','activo','paralelo','negociar','liquidada')),
  mes_objetivo     text default '—',
  prioridad        int default 99,
  notas            text default '',
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- ── METAS (ahorro y compras) ─────────────────────────────────────────────────
create table if not exists metas (
  id         bigint generated always as identity primary key,
  nombre     text not null unique,
  tipo       text default 'ahorro' check (tipo in ('ahorro','compra')),
  meta       numeric(12,2) not null default 0,
  actual     numeric(12,2) default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── SEED TDC (tus deudas actuales) ──────────────────────────────────────────
insert into tdc (nombre, deuda_original, a_pagar, pagado, estado, mes_objetivo, prioridad) values
  ('BBVA',        54000,    2700,   0, 'urgente',  'Jun 2026',     1),
  ('HEY Banco',   25000,    10751,  0, 'activo',   'Jul 2026',     2),
  ('Liverpool',   30414,    16096,  0, 'activo',   'Ago 2026',     3),
  ('AMEX',        54249.85, 21699,  0, 'paralelo', 'Jun-May 2027', 4),
  ('NU',          21141.11, 10570,  0, 'negociar', 'Sep-Oct 2026', 5),
  ('Rappi Card',  24508.95, 12254,  0, 'negociar', 'Nov-Dic 2026', 6),
  ('Palacio',     41395.13, 20697,  0, 'negociar', 'Ene-Feb 2027', 7)
on conflict (nombre) do nothing;

-- ── ROW LEVEL SECURITY (básico, ajustar si se comparte) ─────────────────────
alter table movimientos enable row level security;
alter table tdc          enable row level security;
alter table metas        enable row level security;

-- Política permisiva para la service key (el servidor la usa)
create policy "service_all_movimientos" on movimientos for all using (true);
create policy "service_all_tdc"         on tdc         for all using (true);
create policy "service_all_metas"       on metas       for all using (true);