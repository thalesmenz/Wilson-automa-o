create extension if not exists pgcrypto;

create table if not exists public.whatsapp_appointments (
  id uuid primary key default gen_random_uuid(),
  jid text not null,
  contact_name text,
  lead_type text not null default 'unknown' check (lead_type in ('low_ticket', 'high_ticket', 'unknown')),
  event_id text not null unique,
  calendar_id text,
  title text,
  start_datetime timestamptz not null,
  meet_link text,
  calendar_link text,
  attendee_email text,
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled', 'done')),
  day_reminder_sent_at timestamptz,
  thirty_min_reminder_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists whatsapp_appointments_start_idx
  on public.whatsapp_appointments (start_datetime);

create index if not exists whatsapp_appointments_status_start_idx
  on public.whatsapp_appointments (status, start_datetime);

create table if not exists public.whatsapp_conversations (
  jid text primary key,
  contact_name text,
  lead jsonb not null default '{}'::jsonb,
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists whatsapp_conversations_updated_idx
  on public.whatsapp_conversations (updated_at desc);

create table if not exists public.whatsapp_events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  jid text,
  contact_name text,
  lead_type text,
  lead_status text,
  route text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_events_created_idx
  on public.whatsapp_events (created_at desc);

create index if not exists whatsapp_events_type_created_idx
  on public.whatsapp_events (type, created_at desc);

alter table public.whatsapp_appointments enable row level security;
alter table public.whatsapp_conversations enable row level security;
alter table public.whatsapp_events enable row level security;

grant all on public.whatsapp_appointments to service_role;
grant all on public.whatsapp_conversations to service_role;
grant all on public.whatsapp_events to service_role;
