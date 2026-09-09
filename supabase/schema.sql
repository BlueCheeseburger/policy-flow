-- policy-flow — anonymous rooms.
--
-- These tables live alongside Warroom's own on the same Supabase project, so
-- the first design goal is that nothing here can reach team data. Every object
-- is prefixed `pf_`, every policy keys off `auth.uid()` only, and no policy
-- references teams, team_members, or any Warroom table.
--
-- Identity: Supabase anonymous sign-in. Every browser gets a durable, nameless
-- auth user on first load. There are no accounts, no email, no password.
--
-- Access model: a flow is reachable two ways.
--   1. You own it — you created it on this browser identity.
--   2. You were granted it — you opened its share link, which carries a secret
--      token, and pf_join_flow() traded that token for a grant row.
-- There is deliberately no "readable by anyone" policy: a bare `using (true)`
-- would let any client list every flow anyone has ever made. The token is the
-- only way in, and it is never selectable — only checkable, inside a
-- SECURITY DEFINER function.

-- ── Flows ────────────────────────────────────────────────────────────────────

create table if not exists pf_flows (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- The secret in a share link. Not the primary key: rotating it must be able
  -- to revoke old links without breaking the flow's identity.
  share_token  text not null unique default encode(gen_random_bytes(24), 'hex'),
  name         text not null default 'Flow',
  content      text,                     -- base64( Y.encodeStateAsUpdate(doc) )
  event        text not null default 'policy',
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists pf_flows_owner_updated_idx on pf_flows (owner_id, updated_at desc);

-- ── Grants (who has opened which share link) ─────────────────────────────────

create table if not exists pf_flow_grants (
  flow_id    uuid not null references pf_flows(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (flow_id, user_id)
);

create index if not exists pf_flow_grants_user_idx on pf_flow_grants (user_id, created_at desc);

-- ── Abuse bounds ─────────────────────────────────────────────────────────────
-- With no accounts and open sign-up, growth is unbounded by construction. These
-- are the floor, not a complete answer: a flow can't be used as blob storage,
-- and one identity can't create an unlimited number of them.

create or replace function pf_enforce_limits() returns trigger
language plpgsql as $$
declare
  flow_count int;
begin
  -- ~4MB of base64 is far more than a real round's flow and still small enough
  -- that a single row can't be abused as a file host.
  if octet_length(coalesce(new.content, '')) > 4 * 1024 * 1024 then
    raise exception 'This flow is too large to sync (limit 4MB).';
  end if;

  if tg_op = 'INSERT' then
    select count(*) into flow_count from pf_flows where owner_id = new.owner_id;
    if flow_count >= 500 then
      raise exception 'This browser has reached the limit of 500 flows.';
    end if;
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists pf_flows_limits on pf_flows;
create trigger pf_flows_limits before insert or update on pf_flows
  for each row execute function pf_enforce_limits();

-- ── Row-level security ───────────────────────────────────────────────────────

alter table pf_flows enable row level security;
alter table pf_flow_grants enable row level security;

-- A flow is visible to its owner, or to anyone holding a grant for it.
create or replace function pf_can_access(f uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from pf_flows where id = f and owner_id = auth.uid())
      or exists (select 1 from pf_flow_grants where flow_id = f and user_id = auth.uid());
$$;

drop policy if exists "pf_read_own_or_granted" on pf_flows;
create policy "pf_read_own_or_granted" on pf_flows
  for select using (owner_id = auth.uid() or pf_can_access(id));

-- You may only create a flow owned by yourself.
drop policy if exists "pf_insert_own" on pf_flows;
create policy "pf_insert_own" on pf_flows
  for insert with check (owner_id = auth.uid());

-- Anyone with the link can edit — that is the stated sharing model. Ownership
-- itself is pinned: an editor cannot reassign the flow to themselves.
drop policy if exists "pf_update_own_or_granted" on pf_flows;
create policy "pf_update_own_or_granted" on pf_flows
  for update using (owner_id = auth.uid() or pf_can_access(id))
  with check (owner_id = (select owner_id from pf_flows f where f.id = pf_flows.id));

-- Only the owner can delete. A shared editor leaving the room must not be able
-- to destroy everyone else's copy.
drop policy if exists "pf_delete_own" on pf_flows;
create policy "pf_delete_own" on pf_flows
  for delete using (owner_id = auth.uid());

-- Grants are readable and revocable by the person they belong to (that is how
-- "remove this shared flow from my list" works). They are never insertable
-- directly — pf_join_flow is the only way one is created, and it demands the
-- token.
drop policy if exists "pf_grants_read_own" on pf_flow_grants;
create policy "pf_grants_read_own" on pf_flow_grants
  for select using (user_id = auth.uid());

drop policy if exists "pf_grants_delete_own" on pf_flow_grants;
create policy "pf_grants_delete_own" on pf_flow_grants
  for delete using (user_id = auth.uid());

-- ── Joining by share link ────────────────────────────────────────────────────
-- Trades a share token for a grant. SECURITY DEFINER so it can read the token
-- column that no policy exposes; it returns only the flow's id and name, never
-- the token itself, so a joiner can't re-share a link that outlives revocation.

create or replace function pf_join_flow(token text)
returns table (id uuid, name text)
language plpgsql security definer set search_path = public as $$
declare
  f record;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;

  select pf_flows.id, pf_flows.name into f from pf_flows where share_token = token;
  if not found then
    raise exception 'That link is not valid any more.';
  end if;

  insert into pf_flow_grants (flow_id, user_id) values (f.id, auth.uid())
    on conflict do nothing;

  return query select f.id, f.name;
end $$;

revoke all on function pf_join_flow(text) from public;
grant execute on function pf_join_flow(text) to authenticated;

-- ── Moving to another device ─────────────────────────────────────────────────
-- There are no accounts, so a browser identity is all a person has. A transfer
-- code is the one way to carry their flows to another browser: device A mints a
-- short-lived code, device B redeems it, and every flow A owned becomes B's.
-- A only keeps what it has stored locally.

create table if not exists pf_transfers (
  code       text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '30 minutes',
  created_at timestamptz not null default now()
);

alter table pf_transfers enable row level security;
-- No policies at all: the table is reachable only through the two functions
-- below, both SECURITY DEFINER.

create or replace function pf_create_transfer()
returns text
language plpgsql security definer set search_path = public as $$
declare
  new_code text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  delete from pf_transfers where user_id = auth.uid() or expires_at < now();
  new_code := upper(encode(gen_random_bytes(5), 'hex'));
  insert into pf_transfers (code, user_id) values (new_code, auth.uid());
  return new_code;
end $$;

create or replace function pf_claim_transfer(code text)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  t record;
  moved int;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;

  select * into t from pf_transfers where pf_transfers.code = upper(pf_claim_transfer.code);
  if not found or t.expires_at < now() then
    raise exception 'That transfer code is not valid any more.';
  end if;
  if t.user_id = auth.uid() then
    raise exception 'That code was made on this same browser.';
  end if;

  update pf_flows set owner_id = auth.uid() where owner_id = t.user_id;
  get diagnostics moved = row_count;

  update pf_flow_grants set user_id = auth.uid() where user_id = t.user_id
    and flow_id not in (select id from pf_flows where owner_id = auth.uid());
  delete from pf_flow_grants where user_id = t.user_id;
  delete from pf_transfers where pf_transfers.code = t.code;

  return moved;
end $$;

revoke all on function pf_create_transfer() from public;
revoke all on function pf_claim_transfer(text) from public;
grant execute on function pf_create_transfer() to authenticated;
grant execute on function pf_claim_transfer(text) to authenticated;
