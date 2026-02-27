create or replace function public.find_user_id_by_email(p_email text)
returns uuid
language sql
security definer
set search_path = public, auth
as $$
  select u.id
  from auth.users as u
  where lower(u.email) = lower(trim(p_email))
  limit 1;
$$;

grant execute on function public.find_user_id_by_email(text) to authenticated;
