-- Wildcard matches must not count toward a player's active-challenge limit
-- or block their incoming slot. The app UI already ignored them, but
-- issue_challenge() counted them, so the server rejected challenges the UI
-- allowed ("X already has an open challenge"). Re-runnable.

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
  -- Wildcards are admin-arranged and never count toward either limit below.
  select count(*) into n from challenges
    where challenger_id = c.id and status in ('pending','accepted','reported')
      and not is_wildcard;
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
    where opponent_id = o.id and status in ('pending','accepted')
      and not is_wildcard;
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
