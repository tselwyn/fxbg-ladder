-- ============================================================
-- FXBG SINGLES LADDER — Supabase schema
-- Paste this whole file into Supabase: SQL Editor > New query > Run
-- ============================================================

-- ---------- TABLES ----------

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique,
  phone text,
  rank int not null,
  wins int not null default 0,
  losses int not null default 0,
  streak int not null default 0,          -- +N = win streak, -N = loss streak
  rank_change int not null default 0,      -- last movement: +2 = climbed 2
  last_activity timestamptz not null default now(),
  is_admin boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists challenges (
  id uuid primary key default gen_random_uuid(),
  challenger_id uuid not null references players(id),
  opponent_id uuid not null references players(id),
  status text not null default 'pending',  -- pending|accepted|reported|completed|expired|declined|cancelled
  created_at timestamptz not null default now(),
  accept_by timestamptz not null,
  play_by timestamptz,
  winner_id uuid references players(id),
  score text,
  reported_at timestamptz,
  confirm_by timestamptz
);

create table if not exists settings (
  id int primary key default 1,
  challenge_range int not null default 5,
  max_active_challenges int not null default 2,
  accept_days int not null default 3,
  play_days int not null default 10,
  confirm_hours int not null default 48,
  decay_enabled boolean not null default true,
  decay_days int not null default 30
);
insert into settings (id) values (1) on conflict do nothing;

-- ---------- HELPERS ----------

create or replace function me() returns players
language sql stable security definer as $$
  select * from players where lower(email) = lower(auth.jwt() ->> 'email') limit 1;
$$;

create or replace function assert_admin() returns void
language plpgsql stable security definer as $$
begin
  if not coalesce((me()).is_admin, false) then
    raise exception 'Admins only';
  end if;
end $$;

-- ---------- CORE RULES ----------

create or replace function issue_challenge(p_opponent uuid)
returns uuid language plpgsql security definer as $$
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
  insert into challenges (challenger_id, opponent_id, accept_by)
    values (c.id, o.id, now() + make_interval(days => s.accept_days))
    returning id into cid;
  update players set last_activity = now() where id = c.id;
  return cid;
end $$;

create or replace function accept_challenge(p_id uuid)
returns void language plpgsql security definer as $$
declare c players; ch challenges; s settings;
begin
  c := me(); s := (select settings from settings where id = 1);
  select * into ch from challenges where id = p_id;
  if ch.opponent_id is distinct from c.id then raise exception 'This challenge is not addressed to you'; end if;
  if ch.status <> 'pending' then raise exception 'This challenge is no longer pending'; end if;
  update challenges set status = 'accepted', play_by = now() + make_interval(days => s.play_days) where id = p_id;
  update players set last_activity = now() where id = c.id;
end $$;

create or replace function decline_challenge(p_id uuid)
returns void language plpgsql security definer as $$
declare c players; ch challenges;
begin
  c := me();
  select * into ch from challenges where id = p_id;
  if ch.opponent_id is distinct from c.id then raise exception 'This challenge is not addressed to you'; end if;
  if ch.status <> 'pending' then raise exception 'This challenge is no longer pending'; end if;
  update challenges set status = 'declined' where id = p_id;
end $$;

create or replace function cancel_challenge(p_id uuid)
returns void language plpgsql security definer as $$
declare c players; ch challenges;
begin
  c := me();
  select * into ch from challenges where id = p_id;
  if ch.challenger_id is distinct from c.id and not coalesce(c.is_admin,false) then
    raise exception 'Only the challenger or an admin can cancel';
  end if;
  if ch.status not in ('pending','accepted') then raise exception 'This challenge cannot be cancelled now'; end if;
  update challenges set status = 'cancelled' where id = p_id;
end $$;

create or replace function report_score(p_id uuid, p_winner uuid, p_score text)
returns void language plpgsql security definer as $$
declare c players; ch challenges; s settings;
begin
  c := me(); s := (select settings from settings where id = 1);
  select * into ch from challenges where id = p_id;
  if c.id not in (ch.challenger_id, ch.opponent_id) and not coalesce(c.is_admin,false) then
    raise exception 'Only the two players or an admin can report this score';
  end if;
  if ch.status <> 'accepted' then raise exception 'Scores can only be reported on accepted challenges'; end if;
  if p_winner not in (ch.challenger_id, ch.opponent_id) then raise exception 'Winner must be one of the two players'; end if;
  update challenges set status = 'reported', winner_id = p_winner, score = p_score,
    reported_at = now(), confirm_by = now() + make_interval(hours => s.confirm_hours)
    where id = p_id;
end $$;

-- Applies the bump: winner takes loser's spot, everyone between shifts down one.
create or replace function apply_result(p_id uuid)
returns void language plpgsql security definer as $$
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
end $$;

create or replace function confirm_score(p_id uuid)
returns void language plpgsql security definer as $$
declare c players; ch challenges;
begin
  c := me();
  select * into ch from challenges where id = p_id;
  if ch.status <> 'reported' then raise exception 'No reported score to confirm'; end if;
  if c.id = ch.winner_id and not coalesce(c.is_admin,false) then
    raise exception 'The other player (or an admin) confirms the score';
  end if;
  if c.id not in (ch.challenger_id, ch.opponent_id) and not coalesce(c.is_admin,false) then
    raise exception 'Only the two players or an admin can confirm';
  end if;
  perform apply_result(p_id);
end $$;

-- Housekeeping: expirations, auto-confirms, inactivity decay.
-- Safe to call anytime; the app calls it on load and a daily cron calls it too.
create or replace function tick()
returns void language plpgsql security definer as $$
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
end $$;

-- ---------- ADMIN ----------

create or replace function admin_set_rank(p_player uuid, p_rank int)
returns void language plpgsql security definer as $$
declare old int;
begin
  perform assert_admin();
  select rank into old from players where id = p_player;
  if p_rank < old then
    update players set rank = rank + 1 where active and rank >= p_rank and rank < old;
  elsif p_rank > old then
    update players set rank = rank - 1 where active and rank <= p_rank and rank > old;
  end if;
  update players set rank = p_rank where id = p_player;
end $$;

create or replace function admin_upsert_player(p_name text, p_email text, p_phone text)
returns void language plpgsql security definer as $$
begin
  perform assert_admin();
  insert into players (name, email, phone, rank)
  values (trim(p_name), nullif(lower(trim(p_email)), ''), nullif(trim(p_phone), ''),
          coalesce((select max(rank) from players where active), 0) + 1)
  on conflict (email) do update
    set name = excluded.name, phone = coalesce(excluded.phone, players.phone), active = true;
end $$;

create or replace function admin_import_players(p_rows jsonb)
returns int language plpgsql security definer as $$
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
end $$;

create or replace function admin_remove_player(p_player uuid)
returns void language plpgsql security definer as $$
declare old int;
begin
  perform assert_admin();
  select rank into old from players where id = p_player;
  update players set active = false, rank = 9999 where id = p_player;
  update players set rank = rank - 1 where active and rank > old;
end $$;

create or replace function admin_update_settings(p jsonb)
returns void language plpgsql security definer as $$
begin
  perform assert_admin();
  update settings set
    challenge_range = coalesce((p->>'challenge_range')::int, challenge_range),
    max_active_challenges = coalesce((p->>'max_active_challenges')::int, max_active_challenges),
    accept_days = coalesce((p->>'accept_days')::int, accept_days),
    play_days = coalesce((p->>'play_days')::int, play_days),
    confirm_hours = coalesce((p->>'confirm_hours')::int, confirm_hours),
    decay_enabled = coalesce((p->>'decay_enabled')::boolean, decay_enabled),
    decay_days = coalesce((p->>'decay_days')::int, decay_days)
  where id = 1;
end $$;

create or replace function admin_set_admin(p_player uuid, p_is boolean)
returns void language plpgsql security definer as $$
begin
  perform assert_admin();
  update players set is_admin = p_is where id = p_player;
end $$;

-- ---------- ACCESS CONTROL ----------

alter table players enable row level security;
alter table challenges enable row level security;
alter table settings enable row level security;

-- Everyone (even logged out) can view the ladder, matches, and rules.
drop policy if exists players_read on players;
create policy players_read on players for select using (true);
drop policy if exists challenges_read on challenges;
create policy challenges_read on challenges for select using (true);
drop policy if exists settings_read on settings;
create policy settings_read on settings for select using (true);
-- No insert/update/delete policies: all writes go through the functions above.

grant usage on schema public to anon, authenticated;
grant select on players, challenges, settings to anon, authenticated;
grant execute on function issue_challenge, accept_challenge, decline_challenge,
  cancel_challenge, report_score, confirm_score, tick to authenticated;
grant execute on function tick to anon;
grant execute on function admin_set_rank, admin_upsert_player, admin_import_players,
  admin_remove_player, admin_update_settings, admin_set_admin to authenticated;

-- ============================================================
-- AFTER RUNNING: make yourself and your dad admins (edit emails):
--
-- update players set is_admin = true
--   where lower(email) in ('YOUR_EMAIL_HERE', 'mselwyn20@gmail.com');
--
-- (Players must be imported/added first — do the roster import in the
--  app's Admin tab, or insert yourself manually:)
--
-- insert into players (name, email, rank, is_admin)
--   values ('Tyler Selwyn', 'YOUR_EMAIL_HERE', 1, true);
-- ============================================================
