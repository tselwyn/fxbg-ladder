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

-- Settings singleton
insert into settings (id) values (1) on conflict do nothing;

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
  insert into challenges (challenger_id, opponent_id, accept_by)
    values (c.id, o.id, now() + make_interval(days => s.accept_days))
    returning id into cid;
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
  update players set active = false, rank = 9999 where id = p_player;
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
