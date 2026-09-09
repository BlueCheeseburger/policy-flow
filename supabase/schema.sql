-- policy-flow — anonymous rooms.
--
-- These tables live alongside Warroom's own on the same Supabase project, so
-- the first design goal is that nothing here can reach team data. Every object
-- is prefixed `pf_`, every policy keys off `auth.uid()` alone, and no policy
-- references teams, team_members, or any other Warroom table.
--
-- Identity: Supabase anonymous sign-in. Every browser gets a durable, nameless
-- auth user on first load. There are no accounts, no email, no password.
--
-- Access: a flow is reachable two ways, and only two.
--   1. You own it — you created it on this browser identity.
--   2. You hold a grant — you opened its share link, and pf_join_flow() traded
--      that link's secret token for a grant row.
-- There is deliberately no "readable by anyone" policy. A bare `using (true)`
-- would let any client list every flow anyone has ever made. The token is the
-- only way in, and it is never selectable by a client — only checkable, inside
-- a SECURITY DEFINER function that returns the flow's id and name and nothing
-- else, so a joiner can't re-share a link that outlives its revocation.

-- ── Flows ────────────────────────────────────────────────────────────────────

create table if not exists pf_flows (
  id           uuid primary key,          -- supplied by the client: the id the
                                          -- flow already has locally, so the
                                          -- storage key, the share link and the
                                          -- realtime channel all name one thing
  owner_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- The secret in a share link. Not the primary key: rotating it has to be able
  -- to revoke old links without changing the flow's identity.
  share_token  text not null unique default encode(gen_random_bytes(24), 'hex'),
  name         text not null default 'Flow',
  content      text,                      -- base64( Y.encodeStateAsUpdate(doc) )
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

-- ── Bounds ───────────────────────────────────────────────────────────────────
-- With no accounts and open sign-up, growth is unbounded by construction. These
-- are a floor, not a complete answer: a row can't be used as blob storage, and
-- one identity can't mint an unlimited number of them.

create or replace function pf_enforce_limits() returns trigger
language plpgsql as $$
declare
  flow_count int;
begin
  -- ~4MB of base64 is far more than a real round's flow, and small enough that
  -- a row can't serve as a file host.
  if octet_length(coalesce(new.content, '')) > 4 * 1024 * 1024 then
    raise exception 'This flow is too large to sync (limit 4MB).';
  end if;

  if tg_op = 'INSERT' then
    select count(*) into flow_count from pf_flows where owner_id = new.owner_id;
    if flow_count >= 500 then
      raise exception 'This browser has reached the limit of 500 flows.';
    end if;
  else
    -- Ownership is pinned. Anyone in a room may save the shared snapshot —
    -- that is the point of a room — but nobody can quietly reassign the flow
    -- to themselves, and the client's upsert payload carries an owner_id it
    -- has no business setting on an existing row.
    new.owner_id := old.owner_id;
    new.share_token := old.share_token;
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

-- Own it, or hold a grant for it. The grants lookup is a plain EXISTS against a
-- DIFFERENT table, so there is no policy recursion and no SECURITY DEFINER
-- helper to reason about.
drop policy if exists "pf_read_own_or_granted" on pf_flows;
create policy "pf_read_own_or_granted" on pf_flows
  for select using (
    owner_id = auth.uid()
    or exists (select 1 from pf_flow_grants g where g.flow_id = pf_flows.id and g.user_id = auth.uid())
  );

-- You may only create a flow owned by yourself.
drop policy if exists "pf_insert_own" on pf_flows;
create policy "pf_insert_own" on pf_flows
  for insert with check (owner_id = auth.uid());

-- Anyone with the link can edit — that is the stated sharing model. The trigger
-- above is what keeps ownership and the share token out of an editor's reach.
drop policy if exists "pf_update_own_or_granted" on pf_flows;
create policy "pf_update_own_or_granted" on pf_flows
  for update using (
    owner_id = auth.uid()
    or exists (select 1 from pf_flow_grants g where g.flow_id = pf_flows.id and g.user_id = auth.uid())
  );

-- Only the owner can delete. Someone leaving a room must not be able to destroy
-- everyone else's copy; they drop their own grant instead.
drop policy if exists "pf_delete_own" on pf_flows;
create policy "pf_delete_own" on pf_flows
  for delete using (owner_id = auth.uid());

-- Grants are readable and revocable by the person they belong to — that is how
-- "remove this shared flow from my list" works. They are never insertable
-- directly: pf_join_flow is the only way one is created, and it demands the
-- token.
drop policy if exists "pf_grants_read_own" on pf_flow_grants;
create policy "pf_grants_read_own" on pf_flow_grants
  for select using (user_id = auth.uid());

drop policy if exists "pf_grants_delete_own" on pf_flow_grants;
create policy "pf_grants_delete_own" on pf_flow_grants
  for delete using (user_id = auth.uid());

-- ── Joining by share link ────────────────────────────────────────────────────

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

create table if not exists pf_transfers (
  code       text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '30 minutes',
  created_at timestamptz not null default now()
);

-- RLS on with NO policies at all: the table is unreachable by any client, and
-- only the two SECURITY DEFINER functions below can touch it.
alter table pf_transfers enable row level security;

create or replace function pf_create_transfer()
returns text
language plpgsql security definer set search_path = public as $$
declare
  new_code text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  -- One live code per identity, and expired ones are swept on the way past.
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

  -- Move the old identity's grants over, minus any the claimer already holds
  -- (the primary key would reject those) and any that are now self-grants on a
  -- flow they just inherited.
  delete from pf_flow_grants g
   where g.user_id = t.user_id
     and (exists (select 1 from pf_flow_grants mine
                   where mine.flow_id = g.flow_id and mine.user_id = auth.uid())
          or exists (select 1 from pf_flows f
                      where f.id = g.flow_id and f.owner_id = auth.uid()));
  update pf_flow_grants set user_id = auth.uid() where user_id = t.user_id;

  delete from pf_transfers where pf_transfers.code = t.code;
  return moved;
end $$;

revoke all on function pf_create_transfer() from public;
revoke all on function pf_claim_transfer(text) from public;
grant execute on function pf_create_transfer() to authenticated;
grant execute on function pf_claim_transfer(text) to authenticated;

-- Supabase grants EXECUTE on new public functions to `anon` and `authenticated`
-- by default, and `revoke ... from public` does NOT remove a grant held by a
-- named role. All three functions already raise on a null auth.uid(), so this
-- was never reachable — but a not-signed-in caller should be turned away by the
-- grant, not by a check inside the function body.
revoke execute on function pf_join_flow(text) from anon;
revoke execute on function pf_create_transfer() from anon;
revoke execute on function pf_claim_transfer(text) from anon;
