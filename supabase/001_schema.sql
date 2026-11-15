-- =====================================================================
-- BodyEvo — tabelas, RLS e gatilhos
-- Rode no Supabase: SQL Editor › New query › cole este arquivo › Run.
-- Pode rodar de novo sem quebrar nada (usa "if not exists").
--
-- Toda tabela tem user_id com RLS (user_id = auth.uid()): a chave
-- publishable fica pública no GitHub Pages, então só o dono da sessão
-- lê e grava as próprias linhas.
-- =====================================================================

create extension if not exists pgcrypto;

-- updated_at automático em toda alteração
create or replace function public.tocar_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Parâmetros (aba Configuracao) — uma linha por usuário
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  display_name text,
  start_date date not null,
  start_weight_kg numeric(5,2) not null,
  target_weight_kg numeric(5,2) not null,
  gain_min_kg numeric(4,2) not null default 0.10,
  gain_ideal_kg numeric(4,2) not null default 0.25,
  gain_max_kg numeric(4,2) not null default 0.40,
  kcal_adjust int not null default 175,
  skinfold_limit_mm numeric(4,2) not null default 1.0,
  surplus_band_min int not null default 200,
  surplus_band_max int not null default 300,
  summary_time time not null default '22:30',
  weigh_reminder_time time not null default '07:00',
  manual_burn_fallback boolean not null default true,
  remind_weigh boolean not null default true,
  remind_checkin boolean not null default true,
  remind_summary boolean not null default true,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Meta de calorias com histórico
-- ---------------------------------------------------------------------
create table if not exists public.kcal_targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  effective_from date not null,
  kcal int not null,
  reason text,
  updated_at timestamptz not null default now(),
  unique (user_id, effective_from)
);

-- ---------------------------------------------------------------------
-- Metas de macros — regra: min | range | max
-- ---------------------------------------------------------------------
create table if not exists public.macro_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  macro text not null check (macro in ('protein','carb','fat')),
  target_g numeric not null,
  rule text not null check (rule in ('min','range','max')),
  low_g numeric,
  high_g numeric,
  updated_at timestamptz not null default now(),
  unique (user_id, macro)
);

-- ---------------------------------------------------------------------
-- Registro diário. As kcal ingeridas NÃO ficam aqui: são a soma de meal_entries.
-- O app só envia as colunas que ele controla (peso, marcadores, nota, gasto
-- manual, closed_at); a api/ só grava as colunas garmin_* e o gasto quando a
-- fonte não é 'manual'. Assim um nunca apaga o que o outro gravou.
-- ---------------------------------------------------------------------
create table if not exists public.daily_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  date date not null,
  weight_kg numeric(5,2),
  kcal_burned int,
  burned_source text check (burned_source in ('garmin','manual')),
  garmin_active_kcal int,
  garmin_bmr_kcal int,
  garmin_synced_at timestamptz,
  tags text[] not null default '{}',
  note text,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, date)
);

-- ---------------------------------------------------------------------
-- Alimentos (sempre por 100 g)
-- ---------------------------------------------------------------------
create table if not exists public.foods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  kcal_100g numeric,
  protein_100g numeric,
  carb_100g numeric,
  fat_100g numeric,
  label_basis text check (label_basis in ('100g','portion')),
  portion_g numeric,
  unit_g numeric,
  unit_label text,
  last_grams numeric,
  use_count int not null default 0,
  archived boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Refeições configuráveis
-- ---------------------------------------------------------------------
create table if not exists public.meal_types (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  default_time time,
  active boolean not null default true,
  sort int not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Itens comidos (uma linha por alimento pesado).
-- Guarda uma cópia dos valores por 100 g e do nome no momento do registro:
-- editar ou arquivar o alimento depois não reescreve o histórico.
-- Sem FK em food_id/meal_type_id de propósito: a fila do app pode enviar o item
-- antes do alimento, e apagar um alimento não pode apagar o histórico.
-- ---------------------------------------------------------------------
create table if not exists public.meal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  date date not null,
  meal_type_id uuid,
  food_id uuid,
  food_name text,
  grams numeric not null,
  kcal_100g numeric,
  protein_100g numeric,
  carb_100g numeric,
  fat_100g numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists meal_entries_user_date on public.meal_entries (user_id, date);

-- ---------------------------------------------------------------------
-- Check-in semanal (fita + adipômetro)
-- ---------------------------------------------------------------------
create table if not exists public.weekly_checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  week_number int not null,
  date date not null,
  arm_cm numeric, shoulders_cm numeric, chest_cm numeric, abdomen_cm numeric,
  thigh_cm numeric, glutes_cm numeric, calf_cm numeric,
  skinfold_1_mm numeric, skinfold_2_mm numeric, skinfold_3_mm numeric,
  updated_at timestamptz not null default now(),
  unique (user_id, week_number)
);

-- ---------------------------------------------------------------------
-- Inscrições de Web Push (o app grava; a api/ lê com a service-role)
-- ---------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Só para a api/ (service-role): notificações já enviadas e token do Garmin.
-- RLS ligada e sem políticas = invisível para o app.
-- ---------------------------------------------------------------------
create table if not exists public.notifications_sent (
  user_id uuid not null references auth.users on delete cascade,
  kind text not null,
  date date not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, kind, date)
);

create table if not exists public.api_state (
  key text primary key,
  value jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- RLS e gatilhos de updated_at
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['settings','kcal_targets','macro_goals','daily_logs','foods',
                           'meal_types','meal_entries','weekly_checkins','push_subscriptions']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists dono on public.%I', t);
    execute format(
      'create policy dono on public.%I for all to authenticated
         using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('drop trigger if exists tocar on public.%I', t);
    execute format(
      'create trigger tocar before update on public.%I
         for each row execute function public.tocar_updated_at()', t);
  end loop;
end $$;

alter table public.notifications_sent enable row level security;
alter table public.api_state enable row level security;
