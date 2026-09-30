-- migration_v11: Notas de Inicio — notas ilimitadas con título e imágenes
-- Aplicada directamente contra el proyecto Supabase (cufglaeiqiffdodygqgd)
-- el 2026-09-30 vía MCP. Este archivo documenta lo ya aplicado; no es
-- necesario volver a correrlo salvo para reproducir el esquema en otro
-- proyecto/entorno.
--
-- Alcance: SOLO el módulo de Notas de Inicio (dashboard). Las notas de
-- Presupuesto/Nidito/Negocios/Calendario/Deudas siguen viviendo como una
-- nota única de texto libre en usuarios.external_refs.notas — sin cambios.

create table if not exists public.notas_inicio (
  id uuid primary key default gen_random_uuid(),
  user_phone text not null,
  titulo text default '',
  contenido text default '',
  imagenes jsonb default '[]'::jsonb,
  orden bigint default (extract(epoch from now()) * 1000)::bigint,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);
create index if not exists idx_notas_inicio_phone on public.notas_inicio(user_phone) where deleted_at is null;
alter table public.notas_inicio enable row level security;
create policy service_all_notas_inicio on public.notas_inicio
  for all to public using (true) with check (true);

-- Bucket de almacenamiento para las imágenes adjuntas (privado, URLs firmadas
-- de 10 años igual que nidito-adjuntos — ver /api/notas-inicio/upload-*).
insert into storage.buckets (id, name, public)
values ('notas-adjuntos', 'notas-adjuntos', false)
on conflict (id) do nothing;

-- IMPORTANTE — bug preexistente descubierto y corregido aquí: storage.objects
-- tiene RLS activado desde siempre pero NUNCA tuvo ninguna política, así que
-- CUALQUIER subida de archivo (incluida la de Nidito, nidito-adjuntos, que ya
-- existía antes de esta migración) fallaba con "new row violates row-level
-- security policy". No hay evidencia de que la subida de adjuntos de Nidito
-- se haya probado con éxito antes de este fix.
create policy service_all_app_buckets on storage.objects
  for all to public
  using (bucket_id in ('nidito-adjuntos','notas-adjuntos'))
  with check (bucket_id in ('nidito-adjuntos','notas-adjuntos'));

-- ⚠️ Pendiente, NO aplicado aquí a propósito (requiere que definas políticas
-- antes de activarlo, si no se bloquea todo el acceso a esa tabla):
-- public.despensa tiene RLS DESACTIVADO — expuesta por completo a las claves
-- anon/authenticated. Ver aviso de Supabase Advisors para más detalle.
-- ALTER TABLE "public"."despensa" ENABLE ROW LEVEL SECURITY;
