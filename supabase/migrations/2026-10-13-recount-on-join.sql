-- ============================================================
-- Recount a player's W/L when they're added or come back
-- ------------------------------------------------------------
-- Adding (or re-adding) a player used to leave wins/losses/streak at
-- whatever the row held: 0-0 for a new row, even when the TennisRungs
-- archive has their history under the same name. The player report
-- reads the archive directly, so it looked right while the ladder row
-- said 0-0 (Freedman Kim, Jose Ordonez). Now both paths recount.
-- Safe to re-run.
-- ============================================================

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
  -- Rebuild W/L + streak from their match history and the TennisRungs archive.
  perform recount_player_stats((select id from players where lower(email) = lower(trim(p_email))));
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
  -- Rebuild W/L + streak from their match history and the TennisRungs archive.
  perform recount_player_stats(p_player);
end $function$
;
