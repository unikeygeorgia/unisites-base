-- What a Supabase project has before its own tables: the roles, auth and storage.
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create schema storage;
create schema extensions;
create table auth.users (
  id uuid primary key, email text, phone text, encrypted_password text,
  email_confirmed_at timestamptz, phone_confirmed_at timestamptz, banned_until timestamptz,
  raw_user_meta_data jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now()
);
create table auth.identities (id uuid primary key, user_id uuid references auth.users(id), provider text, provider_id text);
create table auth.mfa_factors (id uuid primary key, user_id uuid references auth.users(id), factor_type text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role', true) $$;
create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);
alter table storage.objects enable row level security;
create publication supabase_realtime;

insert into auth.users (id, email, phone, encrypted_password, email_confirmed_at, phone_confirmed_at, banned_until, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000001', 'Ana@Example.com', null, '$2a$10$abcdefghijklmnopqrstuv', now(), null, null, '{"full_name": "Ana Beridze"}'),
  ('00000000-0000-0000-0000-000000000002', null, '995555000000', '', null, now(), null, '{}'),
  ('00000000-0000-0000-0000-000000000003', 'gio@example.com', null, '$2a$10$abcdefghijklmnopqrstuv', null, null, now() + interval '1 day', '{"avatar_url": "https://x.test/g.png", "must_change_password": true}');
insert into auth.identities values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'email', 'ana@test'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'phone', '995555000000'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000003', 'google', '1170000000000000000001');
insert into auth.mfa_factors values ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'totp');
insert into storage.buckets values ('avatars', 'avatars', true, 5242880, array['image/png', 'image/jpeg']), ('media', 'media', false, null, null);
insert into storage.objects values ('30000000-0000-0000-0000-000000000001', 'avatars', 'a/1.png', '{"size": 1200}');
create policy avatars_read on storage.objects for select using (bucket_id = 'avatars');

-- A Unichat-shaped project (../unichat.ge/schema.sql, plans_catalog.sql).
create type public.conversation_status as enum ('open', 'pending', 'closed');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  is_platform_admin boolean not null default false,
  created_at timestamptz not null default now()
);
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'start' check (plan = any (array['start'::text, 'pro'::text])),
  custom_price numeric(10, 2),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz default timezone('utc'::text, now())
);
create table public.memberships (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member',
  primary key (tenant_id, user_id)
);
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  status public.conversation_status not null default 'open',
  tags text[] not null default '{}'::text[],
  last_msg_at timestamptz,
  search tsvector,
  updated_at timestamptz default now()
);
create index conversations_tenant_recent on public.conversations using btree (tenant_id, last_msg_at desc);
create index conversations_search on public.conversations using gin (search);
create table public.messages (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  body text check (char_length(body) <= 4000),
  direction text not null check (direction in ('inbound', 'outbound')),
  created_at timestamptz not null default now()
);
create unique index messages_one_per_minute on public.messages (conversation_id, created_at) where direction = 'inbound';
create table public.plans (id text primary key, name text, price_monthly integer, popular boolean default false);
create table public.device_tokens (user_id uuid references auth.users(id), token text primary key);
create table public.open_table (id serial primary key, note text);
create table public.scores (id serial primary key, tenant_id uuid, points integer, label text);

create or replace function public.is_platform_admin() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select is_platform_admin from public.profiles where id = auth.uid()),
    false
  );
$$;
create or replace function public.my_tenant_ids() returns setof uuid language sql stable security definer set search_path = public as $$
  select tenant_id from public.memberships where user_id = auth.uid();
$$;
create or replace function public.is_tenant_owner(t uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid() and tenant_id = t and role = 'owner'
  );
$$;
create or replace function public.dashboard_stats(p_tenant uuid) returns jsonb language plpgsql security definer as $$
begin
  if not (p_tenant in (select public.my_tenant_ids()) or public.is_platform_admin()) then raise exception 'forbidden'; end if;
  return '{}'::jsonb;
end $$;
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
create trigger conversations_touch before update on public.conversations for each row execute function public.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.tenants enable row level security;
alter table public.memberships enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.plans enable row level security;
alter table public.device_tokens enable row level security;
alter table public.scores enable row level security;

create policy profiles_self on public.profiles for select to authenticated using ( id = auth.uid() or public.is_platform_admin() );
create policy profiles_update_self on public.profiles for update to authenticated using ( id = auth.uid() );
create policy tenants_member_read on public.tenants for select to authenticated using ( id in (select public.my_tenant_ids()) or public.is_platform_admin() );
create policy tenants_owner_write on public.tenants for update to authenticated using ( public.is_tenant_owner(id) or public.is_platform_admin() );
create policy memberships_read on public.memberships for select to authenticated using ( tenant_id in (select public.my_tenant_ids()) or public.is_platform_admin() );
create policy memberships_write on public.memberships for all to authenticated
  using ( public.is_tenant_owner(tenant_id) or public.is_platform_admin() )
  with check ( public.is_tenant_owner(tenant_id) or public.is_platform_admin() );
create policy conversations_isolation on public.conversations for all to authenticated
  using ( tenant_id in (select public.my_tenant_ids()) or public.is_platform_admin() )
  with check ( tenant_id in (select public.my_tenant_ids()) or public.is_platform_admin() );
create policy messages_isolation on public.messages for all to authenticated
  using ( tenant_id in (select public.my_tenant_ids()) or public.is_platform_admin() )
  with check ( tenant_id in (select public.my_tenant_ids()) or public.is_platform_admin() );
create policy invoices_like on public.messages for select using (
  exists (select 1 from public.memberships m where m.tenant_id = messages.tenant_id and m.user_id = auth.uid())
);
create policy plans_read on public.plans for select to authenticated using (true);
create policy plans_admin on public.plans for all to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());
create policy device_tokens_own on public.device_tokens for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy scores_regex on public.scores for select using (label ~ '^a');

-- Column grants, as plans_catalog.sql confines them.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
revoke update on public.profiles from authenticated, anon;
grant update (full_name) on public.profiles to authenticated;
revoke select on public.tenants from authenticated, anon;
grant select (id, name, plan, settings, created_at) on public.tenants to authenticated;
revoke update on public.tenants from authenticated, anon;
grant update (name, settings) on public.tenants to authenticated;

alter publication supabase_realtime add table public.messages, public.conversations;
alter table public.messages replica identity full;
