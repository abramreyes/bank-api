-- Restrict direct client writes so onboarding state can only be set by trusted backend logic.
-- Supabase service_role keeps full access and is used by this API.

-- 1) Prevent direct client mutation of onboarding-sensitive profile fields.
revoke update on table public.profiles from anon, authenticated;

-- Keep optional self-service profile edits limited to non-sensitive fields.
grant update (full_name) on table public.profiles to authenticated;

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile basic fields"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- 2) Prevent client-side exposure of pin hash while keeping normal profile reads.
revoke select on table public.profiles from anon, authenticated;
grant select (id, full_name, phone, phone_verified_at, pin_set_at, biometric_enabled, basic_verification_complete, created_at)
on table public.profiles
to authenticated;

-- 3) OTP challenge rows must never be directly written by client apps.
revoke insert, update, delete on table public.onboarding_otps from anon, authenticated;
