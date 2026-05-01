-- Run this in your Supabase project: Dashboard → SQL Editor → New query

create table if not exists daily_stats (
  date          date primary key,
  hrv_ms        integer,
  resting_hr    integer,
  recovery_score integer,       -- 0–100 (Oura readiness or WHOOP recovery)
  sleep_hours   numeric(4,2),
  vo2max        numeric(5,2),
  body_battery  integer,        -- Garmin Body Battery 0–100
  source        text,           -- 'garmin' | 'oura' | 'whoop'
  raw           jsonb,          -- full payload for debugging
  updated_at    timestamptz default now()
);

create table if not exists athlete_profile (
  id               integer primary key default 1,
  garmin_connected boolean default false,
  oura_connected   boolean default false,
  whoop_connected  boolean default false,
  updated_at       timestamptz default now()
);

-- Allow the frontend (anon key) to read both tables
alter table daily_stats   enable row level security;
alter table athlete_profile enable row level security;

create policy "Public read daily_stats"
  on daily_stats for select using (true);

create policy "Public read athlete_profile"
  on athlete_profile for select using (true);

-- Seed the athlete_profile row so it always exists
insert into athlete_profile (id) values (1) on conflict do nothing;
