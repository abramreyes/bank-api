alter table public.profiles
  add column if not exists phone_verified_at timestamptz,
  add column if not exists pin_hash text,
  add column if not exists pin_set_at timestamptz,
  add column if not exists biometric_enabled boolean not null default false,
  add column if not exists basic_verification_complete boolean not null default false;

create table if not exists public.onboarding_otps (
  user_id uuid primary key references auth.users (id) on delete cascade,
  otp_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.onboarding_otps enable row level security;

create policy "Users can manage own otp challenge"
on public.onboarding_otps
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
