-- ============================================================
-- END-OF-SEASON TOURNAMENT (phase 2)
-- ------------------------------------------------------------
-- Run in the Supabase SQL editor BEFORE merging the code that
-- reads these tables. Safe to re-run: if-not-exists and
-- create-or-replace throughout; the 2026 tournament row is only
-- inserted if it isn't there yet.
--
-- Tournament results never touch ladder ranks. A reported
-- tournament match does count as activity for inactivity decay.
-- ============================================================

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
