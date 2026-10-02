-- ============================================================
-- FXBG LADDER — COMPLETE DATABASE SCHEMA
-- ------------------------------------------------------------
-- Source of truth, generated from the LIVE database 2026-08-04.
-- Replaces the stale pre-launch schema.sql, which was missing
-- admin_record_match, admin_edit_score, admin_force_score,
-- admin_temp_drop, admin_delete_match, recount_player_stats,
-- legacy_matches, the rank-snapshot trigger, and — critically —
-- still contained the OLD two-phase report_score. This file
-- matches what is actually deployed.
--
-- Safe to re-run top to bottom: create-or-replace and
-- if-not-exists throughout. Run on a fresh Supabase project to
-- rebuild the entire backend; run on the live project and it's
-- a no-op.
-- ============================================================

-- ---------- EXTENSIONS ----------
-- (pg_stat_statements and supabase_vault are platform-managed
-- by Supabase and always present; not listed here.)
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

-- ---------- TABLES ----------

create table if not exists players (
  id uuid not null default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  rank integer not null,
  wins integer not null default 0,
  losses integer not null default 0,
  streak integer not null default 0,
  rank_change integer not null default 0,
  last_activity timestamp with time zone not null default now(),
  is_admin boolean not null default false,
  active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  dropped boolean not null default false,
  daily_emails boolean not null default true,
  email_token uuid not null default gen_random_uuid(),
  UNIQUE (email),
  PRIMARY KEY (id)
);

create table if not exists challenges (
  id uuid not null default gen_random_uuid(),
  challenger_id uuid not null,
  opponent_id uuid not null,
  status text not null default 'pending'::text,
  created_at timestamp with time zone not null default now(),
  accept_by timestamp with time zone not null,
  play_by timestamp with time zone,
  winner_id uuid,
  score text,
  reported_at timestamp with time zone,
  confirm_by timestamp with time zone,
  challenger_rank integer,
  opponent_rank integer,
  PRIMARY KEY (id)
);

create table if not exists settings (
  id integer not null default 1,
  challenge_range integer not null default 5,
  max_active_challenges integer not null default 2,
  accept_days integer not null default 3,
  play_days integer not null default 10,
  confirm_hours integer not null default 48,
  decay_enabled boolean not null default true,
  decay_days integer not null default 30,
  rematch_days integer not null default 7,
  max_incoming_challenges integer not null default 1,
  PRIMARY KEY (id)
);

create table if not exists legacy_matches (
  id uuid not null default gen_random_uuid(),
  player_name text not null,
  opponent_name text not null,
  player_won boolean not null,
  score text not null default ''::text,
  player_rank integer,
  played_on date not null,
  source text not null default 'tennisrungs'::text,
  created_at timestamp with time zone not null default now(),
  PRIMARY KEY (id)
);

-- Belt-and-suspenders for databases created from an older version
-- of this file (create table if not exists skips existing tables,
-- so post-launch columns are re-asserted here):
alter table players    add column if not exists dropped boolean not null default false;
alter table players    add column if not exists daily_emails boolean not null default true;
alter table players    add column if not exists email_token uuid not null default gen_random_uuid();
alter table challenges add column if not exists challenger_rank integer;
alter table challenges add column if not exists opponent_rank integer;
alter table settings   add column if not exists max_incoming_challenges integer not null default 1;
alter table challenges add column if not exists is_wildcard boolean not null default false;
alter table challenges add column if not exists play_reminder_sent_at timestamp with time zone;

-- Speeds up the daily "expires tomorrow" reminder scan in api/tick.js.
create index if not exists challenges_play_reminder_idx
  on challenges (play_by)
  where status = 'accepted' and play_reminder_sent_at is null;

-- Settings singleton
insert into settings (id) values (1) on conflict do nothing;

create table if not exists join_requests (
  id uuid not null default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  note text,
  status text not null default 'pending'::text,
  created_at timestamp with time zone not null default now(),
  handled_at timestamp with time zone,
  handled_by uuid,
  PRIMARY KEY (id)
);

-- ---------- FOREIGN KEYS ----------

alter table challenges drop constraint if exists challenges_challenger_id_fkey;
alter table challenges add constraint challenges_challenger_id_fkey FOREIGN KEY (challenger_id) REFERENCES players(id);

alter table challenges drop constraint if exists challenges_opponent_id_fkey;
alter table challenges add constraint challenges_opponent_id_fkey FOREIGN KEY (opponent_id) REFERENCES players(id);

alter table challenges drop constraint if exists challenges_winner_id_fkey;
alter table challenges add constraint challenges_winner_id_fkey FOREIGN KEY (winner_id) REFERENCES players(id);

-- ---------- INDEXES ----------

create unique index if not exists legacy_matches_dedup
  on public.legacy_matches using btree (player_name, opponent_name, played_on, score);

-- One open match per pair of players, in either direction, wildcards included.
-- Backstop for the double-tap race in issue_challenge (count-then-insert).
create unique index if not exists challenges_one_open_per_pair
  on public.challenges (least(challenger_id, opponent_id), greatest(challenger_id, opponent_id))
  where status in ('pending', 'accepted', 'reported');

-- One pending application per email address. api/join.js relies on the 23505
-- this throws to tell an applicant they've already applied.
create unique index if not exists join_requests_pending_email
  on public.join_requests using btree (lower(email)) where (status = 'pending');

-- ---------- ROW LEVEL SECURITY ----------

alter table players enable row level security;
alter table challenges enable row level security;
alter table settings enable row level security;
alter table legacy_matches enable row level security;

drop policy if exists players_read on players;
create policy players_read on players
  as permissive for select to public
  using (true);

drop policy if exists challenges_read on challenges;
create policy challenges_read on challenges
  as permissive for select to public
  using (true);

drop policy if exists settings_read on settings;
create policy settings_read on settings
  as permissive for select to public
  using (true);

drop policy if exists "legacy read" on legacy_matches;
create policy "legacy read" on legacy_matches
  as permissive for select to public
  using (true);

-- join_requests deliberately has RLS ON and NO policies. Applicant names,
-- emails and phone numbers must never be publicly readable. Everything that
-- touches this table goes through either a SECURITY DEFINER RPC that calls
-- assert_admin() (list/approve/deny) or the service key in api/join.js.
-- Do not add a permissive read policy here.
alter table join_requests enable row level security;

-- ---------- HELPERS ----------

CREATE OR REPLACE FUNCTION public.me()
 RETURNS players
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select * from players where lower(email) = lower(auth.jwt() ->> 'email') limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.assert_admin()
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
begin
  if not coalesce((me()).is_admin, false) then
    raise exception 'Admins only';
  end if;
end $function$
;

-- ---------- PLAYER ACTIONS ----------

CREATE OR REPLACE FUNCTION public.issue_challenge(p_opponent uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare c players; o players; s settings; cid uuid; n int;
begin
  c := me(); s := (select settings from settings where id = 1);
  if c.id is null then raise exception 'You are not on the ladder'; end if;
  select * into o from players where id = p_opponent and active;
  if o.id is null then raise exception 'Player not found'; end if;
  if o.id = c.id then raise exception 'You cannot challenge yourself'; end if;
  if o.rank >= c.rank then raise exception 'You can only challenge players ranked above you'; end if;
  if c.rank - o.rank > s.challenge_range then
    raise exception 'You can only challenge players within % spots above you', s.challenge_range;
  end if;
  select count(*) into n from challenges
    where challenger_id = c.id and status in ('pending','accepted','reported');
  if n >= s.max_active_challenges then
    raise exception 'You already have % active challenges', s.max_active_challenges;
  end if;
  select count(*) into n from challenges
    where status in ('pending','accepted','reported')
      and ((challenger_id = c.id and opponent_id = o.id) or (challenger_id = o.id and opponent_id = c.id));
  if n > 0 then raise exception 'There is already an open challenge between you two'; end if;
  -- NEW: incoming limit — how many people can have an open challenge against this player.
  -- Unlocks as soon as a score is reported (scores are final immediately).
  select count(*) into n from challenges
    where opponent_id = o.id and status in ('pending','accepted');
  if n >= coalesce(s.max_incoming_challenges, 1) then
    raise exception '% already has an open challenge — wait until it wraps up', o.name;
  end if;
  begin
    insert into challenges (challenger_id, opponent_id, accept_by)
      values (c.id, o.id, now() + make_interval(days => s.accept_days))
      returning id into cid;
  exception when unique_violation then
    -- challenges_one_open_per_pair caught a simultaneous duplicate (double-tap)
    raise exception 'There is already an open challenge between you two';
  end;
  update players set last_activity = now() where id = c.id;
  return cid;
end $function$
;

CREATE OR REPLACE FUNCTION public.accept_challenge(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare c players; ch challenges; s settings;
begin
  c := me(); s := (select settings from settings where id = 1);
  if c.id is null or not c.active then raise exception 'You are not on the ladder'; end if;
  select * into ch from challenges where id = p_id;
  if ch.opponent_id is distinct from c.id then raise exception 'This challenge is not addressed to you'; end if;
  if ch.status <> 'pending' then raise exception 'This challenge is no longer pending'; end if;
  update challenges set status = 'accepted', play_by = now() + make_interval(days => s.play_days) where id = p_id;
  update players set last_activity = now() where id = c.id;
end $function$
;

CREATE OR REPLACE FUNCTION public.decline_challenge(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare c players; ch challenges;
begin
  c := me();
  select * into ch from challenges where id = p_id;
  if ch.opponent_id is distinct from c.id then raise exception 'This challenge is not addressed to you'; end if;
  if ch.status <> 'pending' then raise exception 'This challenge is no longer pending'; end if;
  update challenges set status = 'declined' where id = p_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.cancel_challenge(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare c players; ch challenges;
begin
  c := me();
  select * into ch from challenges where id = p_id;
  if ch.challenger_id is distinct from c.id and not coalesce(c.is_admin,false) then
    raise exception 'Only the challenger or an admin can cancel';
  end if;
  if ch.status not in ('pending','accepted') then raise exception 'This challenge cannot be cancelled now'; end if;
  update challenges set status = 'cancelled' where id = p_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.temp_drop()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare c players; old int; n int;
begin
  c := me();
  if c.id is null or not c.active then raise exception 'You are not on the ladder'; end if;
  select count(*) into n from challenges
    where status in ('accepted','reported') and (challenger_id = c.id or opponent_id = c.id);
  if n > 0 then
    raise exception 'You have a match in progress. Finish it (or ask an admin to cancel it) before temp dropping';
  end if;
  update challenges set status = 'declined' where status = 'pending' and opponent_id = c.id;
  update challenges set status = 'cancelled' where status = 'pending' and challenger_id = c.id;
  old := c.rank;
  update players set active = false, dropped = true, rank = 9999, rank_change = 0 where id = c.id;
  update players set rank = rank - 1 where active and rank > old;
end $function$
;

-- ---------- SCORING ----------

CREATE OR REPLACE FUNCTION public.report_score(p_id uuid, p_winner uuid, p_score text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare c players; ch challenges;
begin
  c := me();
  if c.id is null or (not c.active and not coalesce(c.is_admin,false)) then
    raise exception 'You are not on the ladder';
  end if;
  select * into ch from challenges where id = p_id;
  if c.id not in (ch.challenger_id, ch.opponent_id) and not coalesce(c.is_admin,false) then
    raise exception 'Only the two players or an admin can report this score';
  end if;
  if ch.status <> 'accepted' then raise exception 'Scores can only be reported on accepted challenges'; end if;
  if p_winner not in (ch.challenger_id, ch.opponent_id) then raise exception 'Winner must be one of the two players'; end if;
  update challenges
     set status = 'reported', winner_id = p_winner, score = p_score,
         reported_at = now(), confirm_by = now()
   where id = p_id;
  -- apply immediately: bump ranks, update W/L and streaks, mark completed
  perform apply_result(p_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.apply_result(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare ch challenges; w players; l players; loser uuid;
begin
  select * into ch from challenges where id = p_id;
  if ch.status <> 'reported' then raise exception 'No reported score to confirm'; end if;
  loser := case when ch.winner_id = ch.challenger_id then ch.opponent_id else ch.challenger_id end;
  select * into w from players where id = ch.winner_id;
  select * into l from players where id = loser;
  update players set rank_change = 0 where rank_change <> 0;  -- arrows show most recent move only
  if w.rank > l.rank then
    -- lower-ranked player won: bump
    update players set rank = rank + 1, rank_change = -1
      where rank >= l.rank and rank < w.rank and active;
    update players set rank = l.rank, rank_change = (w.rank - l.rank) where id = w.id;
  end if;
  update players set wins = wins + 1, streak = case when streak > 0 then streak + 1 else 1 end,
    last_activity = now() where id = w.id;
  update players set losses = losses + 1, streak = case when streak < 0 then streak - 1 else -1 end,
    last_activity = now() where id = l.id;
  update challenges set status = 'completed' where id = p_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.confirm_score(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare c players; ch challenges;
begin
  c := me();
  if c.id is null or (not c.active and not coalesce(c.is_admin,false)) then
    raise exception 'You are not on the ladder';
  end if;
  select * into ch from challenges where id = p_id;
  if ch.status <> 'reported' then raise exception 'No reported score to confirm'; end if;
  if c.id = ch.winner_id and not coalesce(c.is_admin,false) then
    raise exception 'The other player (or an admin) confirms the score';
  end if;
  if c.id not in (ch.challenger_id, ch.opponent_id) and not coalesce(c.is_admin,false) then
    raise exception 'Only the two players or an admin can confirm';
  end if;
  perform apply_result(p_id);
end $function$
;

-- Stamps both players' ranks onto the challenge row the moment a
-- result is recorded (winner_id set), BEFORE apply_result moves
-- ranks. Never re-stamps — score corrections change the winner,
-- not the ranks the match was played at. Rally Report reads these
-- for match-time rank context.
CREATE OR REPLACE FUNCTION public.snapshot_match_ranks()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if new.winner_id is not null
     and (tg_op = 'INSERT' or old.winner_id is null) then
    if new.challenger_rank is null then
      select rank into new.challenger_rank from players where id = new.challenger_id;
    end if;
    if new.opponent_rank is null then
      select rank into new.opponent_rank from players where id = new.opponent_id;
    end if;
  end if;
  return new;
end $function$
;

drop trigger if exists trg_snapshot_match_ranks on challenges;
CREATE TRIGGER trg_snapshot_match_ranks BEFORE INSERT OR UPDATE ON public.challenges FOR EACH ROW EXECUTE FUNCTION snapshot_match_ranks();

-- Rebuilds a player's lifetime W/L and current streak from BOTH
-- eras: completed challenges + the legacy_matches archive.
CREATE OR REPLACE FUNCTION public.recount_player_stats(p_player uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare pname text; w int; l int; lw int; ll int; st int := 0; r record;
begin
  select name into pname from players where id = p_player;
  if pname is null then return; end if;

  select count(*) filter (where winner_id = p_player),
         count(*) filter (where winner_id <> p_player)
    into w, l
    from challenges
    where status = 'completed'
      and (challenger_id = p_player or opponent_id = p_player);

  select count(*) filter (where player_won),
         count(*) filter (where not player_won)
    into lw, ll
    from legacy_matches
    where player_name = pname;

  for r in
    select won from (
      select (winner_id = p_player) as won,
             coalesce(reported_at, created_at)::timestamp as played
        from challenges
        where status = 'completed'
          and (challenger_id = p_player or opponent_id = p_player)
      union all
      select player_won as won,
             (played_on::timestamp + interval '12 hours') as played
        from legacy_matches
        where player_name = pname
    ) t
    order by played desc
  loop
    if st = 0 then
      st := case when r.won then 1 else -1 end;
    elsif st > 0 and r.won then
      st := st + 1;
    elsif st < 0 and not r.won then
      st := st - 1;
    else
      exit;
    end if;
  end loop;

  update players
    set wins   = coalesce(w, 0) + coalesce(lw, 0),
        losses = coalesce(l, 0) + coalesce(ll, 0),
        streak = st
    where id = p_player;
end $function$
;

-- ---------- HOUSEKEEPING ----------

CREATE OR REPLACE FUNCTION public.tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare s settings; r record;
begin
  s := (select settings from settings where id = 1);
  update challenges set status = 'expired' where status = 'pending' and accept_by < now();
  update challenges set status = 'expired' where status = 'accepted' and play_by < now();
  for r in select id from challenges where status = 'reported' and confirm_by < now() loop
    perform apply_result(r.id);
  end loop;
  if s.decay_enabled then
    for r in
      select p.id, p.rank from players p
      where p.active and p.last_activity < now() - make_interval(days => s.decay_days)
        and p.rank < (select max(rank) from players where active)
      order by p.rank desc
    loop
      update players set rank = rank - 1, rank_change = 1 where active and rank = r.rank + 1;
      update players set rank = r.rank + 1, rank_change = -1, last_activity = now() where id = r.id;
    end loop;
  end if;
end $function$
;

-- ---------- ADMIN ----------

-- Admin-arranged match between any two active players. Ignores challenge
-- range, slot limits and the rematch cooldown; goes straight to 'accepted'
-- with no accept step. The lower-ranked player is stored as challenger so
-- apply_result's normal bump logic works unchanged.
CREATE OR REPLACE FUNCTION public.admin_create_wildcard(p_a uuid, p_b uuid, p_play_days integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare s settings; a players; b players; lo players; hi players; cid uuid; d int;
begin
  perform assert_admin();
  s := (select settings from settings where id = 1);

  if p_a = p_b then raise exception 'Pick two different players'; end if;

  select * into a from players where id = p_a and active;
  if not found then raise exception 'Both players must be active on the ladder'; end if;

  select * into b from players where id = p_b and active;
  if not found then raise exception 'Both players must be active on the ladder'; end if;

  -- lower-ranked player (bigger rank number) is the challenger
  if a.rank > b.rank then lo := a; hi := b; else lo := b; hi := a; end if;

  -- one open match per pair at a time (wildcard OR regular challenge)
  if exists (
    select 1 from challenges
    where status in ('pending', 'accepted', 'reported')
      and ((challenger_id = lo.id and opponent_id = hi.id)
        or (challenger_id = hi.id and opponent_id = lo.id))
  ) then
    raise exception 'These two already have an open match';
  end if;

  d := greatest(1, coalesce(p_play_days, s.play_days));

  begin
    insert into challenges (challenger_id, opponent_id, status, accept_by, play_by, is_wildcard)
      values (lo.id, hi.id, 'accepted', now(), now() + make_interval(days => d), true)
      returning id into cid;
  exception when unique_violation then
    raise exception 'These two already have an open match';
  end;

  update players set last_activity = now() where id in (lo.id, hi.id);

  return cid;
end $function$
;

-- ---------- JOIN REQUESTS ----------
-- Public applications land in join_requests via api/join.js using the service
-- key (the table has RLS on with no public policies). Admins triage them here.

CREATE OR REPLACE FUNCTION public.list_join_requests()
 RETURNS SETOF join_requests
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
begin
  perform assert_admin();
  return query
    select * from join_requests
    where status = 'pending'
    order by created_at asc;
end $function$
;

CREATE OR REPLACE FUNCTION public.approve_join_request(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare r join_requests;
begin
  perform assert_admin();
  select * into r from join_requests where id = p_id;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'pending' then raise exception 'Request already handled'; end if;
  -- Adds at bottom rank; reactivates a previously-removed player if
  -- the email matches an inactive row. Same path as the Roster card.
  perform admin_upsert_player(r.name, r.email, r.phone);
  update join_requests
    set status = 'approved', handled_at = now(), handled_by = (me()).id
    where id = p_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.deny_join_request(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare r join_requests;
begin
  perform assert_admin();
  select * into r from join_requests where id = p_id;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'pending' then raise exception 'Request already handled'; end if;
  update join_requests
    set status = 'denied', handled_at = now(), handled_by = (me()).id
    where id = p_id;
end $function$
;


CREATE OR REPLACE FUNCTION public.admin_set_rank(p_player uuid, p_rank integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare old int; maxr int;
begin
  perform assert_admin();
  select rank into old from players where id = p_player and active;
  if old is null then raise exception 'Player is not on the active ladder'; end if;
  select max(rank) into maxr from players where active;
  if p_rank < 1 or p_rank > maxr then
    raise exception 'Rank must be between 1 and %', maxr;
  end if;
  if p_rank < old then
    update players set rank = rank + 1 where active and rank >= p_rank and rank < old;
  elsif p_rank > old then
    update players set rank = rank - 1 where active and rank <= p_rank and rank > old;
  end if;
  update players set rank = p_rank where id = p_player;
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_upsert_player(p_name text, p_email text, p_phone text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  perform assert_admin();
  if coalesce(trim(p_email), '') = '' then
    raise exception 'Email is required — players sign in with their email';
  end if;
  insert into players (name, email, phone, rank)
  values (trim(p_name), lower(trim(p_email)), nullif(trim(p_phone), ''),
          coalesce((select max(rank) from players where active), 0) + 1)
  on conflict (email) do update
    set name = excluded.name, phone = coalesce(excluded.phone, players.phone);
  update players set active = true, dropped = false, last_activity = now(),
      rank = coalesce((select max(rank) from players where active), 0) + 1
    where lower(email) = lower(trim(p_email)) and not active;
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_import_players(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare r jsonb; n int := 0;
begin
  perform assert_admin();
  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(r->>'email','') <> '' and not exists
       (select 1 from players where lower(email) = lower(r->>'email')) then
      perform admin_upsert_player(r->>'name', r->>'email', r->>'phone');
      n := n + 1;
    end if;
  end loop;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_reinstate_player(p_player uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  perform assert_admin();
  update players set active = true, dropped = false, last_activity = now(), rank_change = 0,
      rank = coalesce((select max(rank) from players where active), 0) + 1
    where id = p_player and not active;
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_remove_player(p_player uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare old int;
begin
  perform assert_admin();
  select rank into old from players where id = p_player;
  -- close out anything open involving them so no ghost matches remain
  update challenges set status = 'declined'
    where status = 'pending' and opponent_id = p_player;
  update challenges set status = 'cancelled'
    where status in ('pending','accepted','reported')
      and (challenger_id = p_player or opponent_id = p_player);
  -- dropped = false matters: without it, removing someone who is on a temp
  -- drop leaves dropped = true and they stay on the Temp drops list forever
  -- with no way to clear them.
  update players set active = false, dropped = false, rank = 9999, rank_change = 0
    where id = p_player;
  update players set rank = rank - 1 where active and rank > old;
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_temp_drop(p_player uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare t players; old int;
begin
  perform assert_admin();
  select * into t from players where id = p_player and active;
  if t.id is null then raise exception 'Player not found or already off the ladder'; end if;

  -- Clean up their in-flight challenges (admin action overrides in-progress
  -- matches; if a score was mid-report, the players can redo it on return).
  update challenges set status = 'declined'
    where status = 'pending' and opponent_id = t.id;
  update challenges set status = 'cancelled'
    where status in ('pending','accepted','reported') and challenger_id = t.id;
  update challenges set status = 'cancelled'
    where status in ('accepted','reported') and opponent_id = t.id;

  old := t.rank;
  update players set active = false, dropped = true, rank = 9999, rank_change = 0
    where id = t.id;
  update players set rank = rank - 1 where active and rank > old;
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_record_match(p_winner uuid, p_loser uuid, p_score text, p_bump boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare cid uuid; w players; l players;
begin
  perform assert_admin();

  if p_winner = p_loser then
    raise exception 'Pick two different players';
  end if;

  select * into w from players where id = p_winner and active;
  if not found then raise exception 'Winner must be an active player'; end if;

  select * into l from players where id = p_loser and active;
  if not found then raise exception 'Loser must be an active player'; end if;

  insert into challenges (challenger_id, opponent_id, status, accept_by, play_by,
                          winner_id, score, reported_at)
    values (p_winner, p_loser, 'reported', now(), now(),
            p_winner, coalesce(nullif(trim(p_score), ''), 'n/a'), now())
    returning id into cid;

  if p_bump then
    perform apply_result(cid);
  else
    update players set wins = wins + 1,
      streak = case when streak > 0 then streak + 1 else 1 end,
      last_activity = now()
      where id = p_winner;
    update players set losses = losses + 1,
      streak = case when streak < 0 then streak - 1 else -1 end,
      last_activity = now()
      where id = p_loser;
    update challenges set status = 'completed' where id = cid;
  end if;

  return cid;
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_force_score(p_id uuid, p_winner uuid, p_score text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare ch challenges;
begin
  perform assert_admin();
  select * into ch from challenges where id = p_id;
  if ch.id is null then raise exception 'Challenge not found'; end if;
  if ch.status not in ('pending','accepted') then
    raise exception 'Only open challenges can be scored this way';
  end if;
  if p_winner not in (ch.challenger_id, ch.opponent_id) then
    raise exception 'Winner must be one of the two players';
  end if;
  update challenges set status = 'reported', winner_id = p_winner,
    score = coalesce(nullif(trim(p_score), ''), 'n/a'), reported_at = now()
    where id = p_id;
  perform apply_result(p_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_edit_score(p_id uuid, p_winner uuid, p_score text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare ch challenges; old_winner uuid; old_loser uuid; new_loser uuid;
begin
  perform assert_admin();
  select * into ch from challenges where id = p_id;
  if ch.id is null then raise exception 'Challenge not found'; end if;
  if ch.status <> 'completed' then raise exception 'Only completed matches can be edited'; end if;
  if p_winner not in (ch.challenger_id, ch.opponent_id) then
    raise exception 'Winner must be one of the two players';
  end if;

  old_winner := ch.winner_id;
  if p_winner is distinct from old_winner then
    old_loser := case when old_winner = ch.challenger_id then ch.opponent_id else ch.challenger_id end;
    new_loser := old_winner;
    -- undo the old credit, apply the new one
    update players set wins = greatest(wins - 1, 0), losses = losses + 1 where id = new_loser;
    update players set losses = greatest(losses - 1, 0), wins = wins + 1 where id = p_winner;
  end if;

  update challenges set winner_id = p_winner,
    score = coalesce(nullif(trim(p_score), ''), 'n/a')
    where id = p_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_delete_match(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare ch challenges;
begin
  perform assert_admin();

  select * into ch from challenges where id = p_id;
  if not found then raise exception 'Match not found'; end if;
  if ch.status not in ('completed', 'reported') then
    raise exception 'Only completed matches can be deleted';
  end if;

  delete from challenges where id = p_id;

  perform recount_player_stats(ch.challenger_id);
  perform recount_player_stats(ch.opponent_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_update_settings(p jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  perform assert_admin();
  update settings set
    challenge_range = coalesce((p->>'challenge_range')::int, challenge_range),
    max_active_challenges = coalesce((p->>'max_active_challenges')::int, max_active_challenges),
    max_incoming_challenges = coalesce((p->>'max_incoming_challenges')::int, max_incoming_challenges),
    accept_days = coalesce((p->>'accept_days')::int, accept_days),
    play_days = coalesce((p->>'play_days')::int, play_days),
    confirm_hours = coalesce((p->>'confirm_hours')::int, confirm_hours),
    rematch_days = coalesce((p->>'rematch_days')::int, rematch_days),
    decay_enabled = coalesce((p->>'decay_enabled')::boolean, decay_enabled),
    decay_days = coalesce((p->>'decay_days')::int, decay_days)
  where id = 1;
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_set_admin(p_player uuid, p_is boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  perform assert_admin();
  update players set is_admin = p_is where id = p_player;
end $function$
;

-- ---------- TOURNAMENTS ----------
-- Added 2026-10-02 (supabase/migrations/2026-10-02-tournaments.sql).
create table if not exists tournaments (
  id uuid not null default gen_random_uuid(),
  name text not null,
  size integer not null default 8,
  status text not null default 'draft',          -- draft | locked | complete
  is_test boolean not null default false,        -- test runs: emails go to admins only
  cutoff_at timestamp with time zone not null,   -- ladder ranks at this moment set the seeds
  -- [{ "name": "Quarterfinals", "starts": ts, "ends": ts }, ...] one per round
  rounds jsonb not null default '[]'::jsonb,
  -- top size+2 active players at the cutoff: [{ "id", "name", "rank" }, ...]
  seeds_snapshot jsonb,
  snapshot_at timestamp with time zone,
  locked_at timestamp with time zone,
  locked_by uuid,
  qualified_emailed_at timestamp with time zone,
  champion_id uuid,
  completed_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  PRIMARY KEY (id)
);

create table if not exists tournament_matches (
  id uuid not null default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  round integer not null,                 -- 1 = QF, 2 = SF, 3 = Final
  slot integer not null,                  -- position within the round, top to bottom
  seed_a integer,
  seed_b integer,
  player_a uuid references players(id),
  player_b uuid references players(id),
  play_by timestamp with time zone,
  winner_id uuid references players(id),
  score text,
  result_type text,                       -- played | walkover
  reported_at timestamp with time zone,
  reported_by uuid,
  result_emailed_at timestamp with time zone,
  ready_emailed_at timestamp with time zone,   -- "your match is set" sent
  reminder_sent_at timestamp with time zone,   -- 3-days-left reminder sent
  expired_notified_at timestamp with time zone,-- admins told it's past deadline
  created_at timestamp with time zone not null default now(),
  PRIMARY KEY (id),
  UNIQUE (tournament_id, round, slot)
);

alter table tournaments enable row level security;
alter table tournament_matches enable row level security;

drop policy if exists tournaments_read on tournaments;
create policy tournaments_read on tournaments
  as permissive for select to public
  using (true);

drop policy if exists tournament_matches_read on tournament_matches;
create policy tournament_matches_read on tournament_matches
  as permissive for select to public
  using (true);

-- The 2026 tournament. Cutoff Sun Oct 18 11:59 PM ET (EDT).
-- QF 14 days, SF and Final 10 days each; every deadline is 11:59 PM ET.
insert into tournaments (name, cutoff_at, rounds)
select '2026 Fredericksburg Ladder Tournament',
       '2026-10-18 23:59:00-04',
       '[{"name":"Quarterfinals","starts":"2026-10-20T00:00:00-04:00","ends":"2026-11-02T23:59:00-05:00"},
         {"name":"Semifinals","starts":"2026-11-03T00:00:00-05:00","ends":"2026-11-12T23:59:00-05:00"},
         {"name":"Final","starts":"2026-11-13T00:00:00-05:00","ends":"2026-11-22T23:59:00-05:00"}]'::jsonb
where not exists (
  select 1 from tournaments where name = '2026 Fredericksburg Ladder Tournament'
);

-- ---------- HELPERS ----------

-- Top n active players right now, as the jsonb the snapshot stores.
CREATE OR REPLACE FUNCTION public.tourney_ranks_now(p_n integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'rank', rank) order by rank), '[]'::jsonb)
  from (select id, name, rank from players where active order by rank limit p_n) p;
$function$
;

-- Saves the seeding the first time ranks are about to change after a
-- tournament's cutoff. Ranks can't move between the cutoff and that first
-- change, so the snapshot is exactly the ladder at the cutoff, with no cron.
-- BEFORE ... FOR EACH STATEMENT sees the table as it was before the update.
-- Never lets an error escape: a snapshot problem must not block a score.
CREATE OR REPLACE FUNCTION public.tourney_snapshot_ranks()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  begin
    update tournaments
       set seeds_snapshot = tourney_ranks_now(size + 2), snapshot_at = now()
     where status = 'draft' and seeds_snapshot is null and cutoff_at <= now();
  exception when others then null;
  end;
  return null;
end $function$
;

drop trigger if exists trg_tourney_snapshot_ranks on players;
CREATE TRIGGER trg_tourney_snapshot_ranks BEFORE UPDATE OF rank ON public.players
  FOR EACH STATEMENT EXECUTE FUNCTION tourney_snapshot_ranks();

-- Pushes a match's winner (or the lack of one) into the next round.
-- If that changes who is in the next match and it already had a result,
-- the result is cleared and the change keeps flowing up the bracket.
-- After the final, sets the champion and the tournament status.
CREATE OR REPLACE FUNCTION public.tourney_propagate(p_match uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare m tournament_matches; n tournament_matches; top boolean; cur uuid;
begin
  select * into m from tournament_matches where id = p_match;
  if m.id is null then return; end if;

  select * into n from tournament_matches
   where tournament_id = m.tournament_id and round = m.round + 1 and slot = (m.slot + 1) / 2;

  if n.id is null then
    -- this was the final
    update tournaments
       set champion_id = m.winner_id,
           status = case when m.winner_id is null then 'locked' else 'complete' end,
           completed_at = case when m.winner_id is null then null else coalesce(completed_at, now()) end
     where id = m.tournament_id;
    return;
  end if;

  top := (m.slot % 2 = 1);
  cur := case when top then n.player_a else n.player_b end;
  if cur is not distinct from m.winner_id then return; end if;

  if top then
    update tournament_matches set player_a = m.winner_id, ready_emailed_at = null where id = n.id;
  else
    update tournament_matches set player_b = m.winner_id, ready_emailed_at = null where id = n.id;
  end if;

  if n.winner_id is not null then
    update tournament_matches
       set winner_id = null, score = null, result_type = null, reported_at = null,
           reported_by = null, result_emailed_at = null
     where id = n.id;
    perform tourney_propagate(n.id);
  end if;
end $function$
;

-- Internal only: callable from the functions above/below, not by the app.
revoke execute on function public.tourney_propagate(uuid) from public, anon, authenticated;
revoke execute on function public.tourney_ranks_now(integer) from public, anon, authenticated;

-- ---------- PLAYER ACTIONS ----------

-- Either player (or an admin) reports. Final immediately; the winner moves on.
CREATE OR REPLACE FUNCTION public.tourney_report_score(p_match uuid, p_winner uuid, p_score text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare c players; m tournament_matches; t tournaments;
begin
  c := me();
  if c.id is null then raise exception 'Sign in first'; end if;
  select * into m from tournament_matches where id = p_match for update;
  if m.id is null then raise exception 'Match not found'; end if;
  select * into t from tournaments where id = m.tournament_id;
  if t.status <> 'locked' then raise exception 'This tournament is not in progress'; end if;
  if c.id is distinct from m.player_a and c.id is distinct from m.player_b
     and not coalesce(c.is_admin, false) then
    raise exception 'Only the two players or an admin can report this score';
  end if;
  if m.player_a is null or m.player_b is null then
    raise exception 'This match does not have both players yet';
  end if;
  if m.winner_id is not null then
    raise exception 'A score is already in for this match. Ask an admin to change it';
  end if;
  if p_winner is distinct from m.player_a and p_winner is distinct from m.player_b then
    raise exception 'Winner must be one of the two players';
  end if;

  update tournament_matches
     set winner_id = p_winner, score = coalesce(nullif(trim(p_score), ''), 'n/a'),
         result_type = 'played', reported_at = now(), reported_by = c.id, result_emailed_at = null
   where id = p_match;

  if not t.is_test then
    update players set last_activity = now() where id in (m.player_a, m.player_b);
  end if;

  perform tourney_propagate(p_match);
end $function$
;

-- ---------- ADMIN ----------

-- Builds the bracket from the cutoff snapshot: 1v8, 4v5 (top half), 2v7, 3v6.
-- Real tournaments can't lock before the cutoff; test ones can.
CREATE OR REPLACE FUNCTION public.admin_tourney_lock(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare t tournaments; snap jsonb; r int;
begin
  perform assert_admin();
  select * into t from tournaments where id = p_id for update;
  if t.id is null then raise exception 'Tournament not found'; end if;
  if t.status <> 'draft' then raise exception 'This bracket is already locked'; end if;
  if t.size <> 8 then raise exception 'Only 8-player brackets are supported'; end if;
  if now() < t.cutoff_at and not t.is_test then
    raise exception 'The ladder cutoff has not passed yet';
  end if;
  if jsonb_array_length(t.rounds) <> 3 then raise exception 'Tournament needs 3 rounds of dates'; end if;

  snap := t.seeds_snapshot;
  if snap is null then
    -- No rank has changed since the cutoff, so the ladder right now IS the cutoff ladder.
    snap := tourney_ranks_now(t.size + 2);
    update tournaments set seeds_snapshot = snap, snapshot_at = now() where id = p_id;
  end if;
  if jsonb_array_length(snap) < t.size then raise exception 'Not enough players for a full bracket'; end if;

  delete from tournament_matches where tournament_id = p_id;

  insert into tournament_matches (tournament_id, round, slot, seed_a, seed_b, player_a, player_b, play_by)
  select p_id, 1, s.slot, s.a, s.b,
         (snap -> (s.a - 1) ->> 'id')::uuid, (snap -> (s.b - 1) ->> 'id')::uuid,
         (t.rounds -> 0 ->> 'ends')::timestamptz
    from (values (1, 1, 8), (2, 4, 5), (3, 2, 7), (4, 3, 6)) as s(slot, a, b);

  for r in 2..3 loop
    insert into tournament_matches (tournament_id, round, slot, play_by)
    select p_id, r, g, (t.rounds -> (r - 1) ->> 'ends')::timestamptz
      from generate_series(1, case when r = 2 then 2 else 1 end) g;
  end loop;

  update tournaments set status = 'locked', locked_at = now(), locked_by = (me()).id where id = p_id;
end $function$
;

-- Back to draft. Only while no match has a result, so nothing real is lost.
CREATE OR REPLACE FUNCTION public.admin_tourney_unlock(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  perform assert_admin();
  if exists (select 1 from tournament_matches where tournament_id = p_id and winner_id is not null) then
    raise exception 'Clear every result first. Unlocking only works on an unplayed bracket';
  end if;
  delete from tournament_matches where tournament_id = p_id;
  update tournaments
     set status = 'draft', locked_at = null, locked_by = null, qualified_emailed_at = null,
         champion_id = null, completed_at = null
   where id = p_id;
end $function$
;

-- Enter or change any result, including walkovers. Changing a result that
-- already moved someone on clears the later match it affected.
CREATE OR REPLACE FUNCTION public.admin_tourney_set_result(p_match uuid, p_winner uuid, p_score text, p_walkover boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare m tournament_matches; t tournaments;
begin
  perform assert_admin();
  select * into m from tournament_matches where id = p_match for update;
  if m.id is null then raise exception 'Match not found'; end if;
  select * into t from tournaments where id = m.tournament_id;
  if t.status not in ('locked', 'complete') then raise exception 'Lock the bracket first'; end if;
  if m.player_a is null or m.player_b is null then
    raise exception 'This match does not have both players yet';
  end if;
  if p_winner is distinct from m.player_a and p_winner is distinct from m.player_b then
    raise exception 'Winner must be one of the two players';
  end if;

  update tournament_matches
     set winner_id = p_winner,
         score = case when p_walkover then coalesce(nullif(trim(p_score), ''), 'W/O')
                      else coalesce(nullif(trim(p_score), ''), 'n/a') end,
         result_type = case when p_walkover then 'walkover' else 'played' end,
         reported_at = now(), reported_by = (me()).id, result_emailed_at = null
   where id = p_match;

  if not p_walkover and not t.is_test then
    update players set last_activity = now() where id in (m.player_a, m.player_b);
  end if;

  perform tourney_propagate(p_match);
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_tourney_clear_result(p_match uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  perform assert_admin();
  update tournament_matches
     set winner_id = null, score = null, result_type = null, reported_at = null,
         reported_by = null, result_emailed_at = null
   where id = p_match;
  perform tourney_propagate(p_match);
end $function$
;

-- Put any player into either spot of a match (or empty it with null).
-- If the match had a result, it's cleared, since the lineup changed.
CREATE OR REPLACE FUNCTION public.admin_tourney_set_player(p_match uuid, p_spot text, p_player uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare m tournament_matches;
begin
  perform assert_admin();
  if p_spot not in ('a', 'b') then raise exception 'Spot must be a or b'; end if;
  select * into m from tournament_matches where id = p_match for update;
  if m.id is null then raise exception 'Match not found'; end if;

  if p_player is not null then
    if not exists (select 1 from players where id = p_player) then raise exception 'Player not found'; end if;
    if (p_spot = 'a' and m.player_b = p_player) or (p_spot = 'b' and m.player_a = p_player) then
      raise exception 'That player is already in this match';
    end if;
    if exists (
      select 1 from tournament_matches
       where tournament_id = m.tournament_id and round = m.round and id <> m.id
         and (player_a = p_player or player_b = p_player)
    ) then
      raise exception 'That player is already in another match this round. Take them out of it first';
    end if;
  end if;

  if p_spot = 'a' then
    update tournament_matches set player_a = p_player, ready_emailed_at = null where id = p_match;
  else
    update tournament_matches set player_b = p_player, ready_emailed_at = null where id = p_match;
  end if;

  if m.winner_id is not null then
    update tournament_matches
       set winner_id = null, score = null, result_type = null, reported_at = null,
           reported_by = null, result_emailed_at = null
     where id = p_match;
    perform tourney_propagate(p_match);
  end if;
end $function$
;

-- New deadline for one match. No email; the 3-day reminder re-arms for the new date.
CREATE OR REPLACE FUNCTION public.admin_tourney_extend(p_match uuid, p_play_by timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  perform assert_admin();
  update tournament_matches
     set play_by = p_play_by, reminder_sent_at = null, expired_notified_at = null
   where id = p_match;
  if not found then raise exception 'Match not found'; end if;
end $function$
;

-- A throwaway tournament for trying everything out. Cutoff is now, so it can
-- be locked right away; rounds are 3 days each. Emails go to admins only.
CREATE OR REPLACE FUNCTION public.admin_tourney_create_test()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare tid uuid;
begin
  perform assert_admin();
  insert into tournaments (name, is_test, cutoff_at, rounds)
  values ('TEST tournament', true, now(),
          jsonb_build_array(
            jsonb_build_object('name', 'Quarterfinals', 'starts', now(), 'ends', now() + interval '3 days'),
            jsonb_build_object('name', 'Semifinals', 'starts', now() + interval '3 days', 'ends', now() + interval '6 days'),
            jsonb_build_object('name', 'Final', 'starts', now() + interval '6 days', 'ends', now() + interval '9 days')))
  returning id into tid;
  return tid;
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_tourney_delete_test(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  perform assert_admin();
  delete from tournaments where id = p_id and is_test;
  if not found then raise exception 'Only test tournaments can be deleted'; end if;
end $function$
;
