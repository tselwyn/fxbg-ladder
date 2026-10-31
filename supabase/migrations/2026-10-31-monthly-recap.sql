-- ============================================================
-- MONTHLY RECAP EMAIL
-- ------------------------------------------------------------
-- Run in the Supabase SQL editor BEFORE merging the code that
-- sends the monthly recap (api/monthly.js). Safe to re-run.
--
-- players.monthly_emails: separate opt-out for the monthly recap.
--   Defaults to true for everyone, including temp drops. Turning
--   off the daily results email does NOT turn this off.
-- settings.monthly_recap_sent_for: 'YYYY-MM' of the last month
--   whose recap went out. Stops a double cron fire from sending
--   the same recap twice.
-- settings.monthly_recap_sent_at: where that recap's window ended.
--   The recap sends on the evening of the last day, so the next
--   month's window starts here and late-night matches aren't lost.
-- settings.monthly_recap_mode: picked in the Admin tab.
--   'draft' (default) = admins get a ready-to-send draft + BCC list
--   'auto'  = the app emails every player (~40 of the 100/day cap)
--   'off'   = nothing
-- admin_update_settings: now also saves monthly_recap_mode.
-- ============================================================

alter table players  add column if not exists monthly_emails boolean not null default true;
alter table settings add column if not exists monthly_recap_sent_for text;
alter table settings add column if not exists monthly_recap_sent_at timestamp with time zone;
alter table settings add column if not exists monthly_recap_mode text not null default 'draft';
alter table settings drop constraint if exists settings_monthly_recap_mode_check;
alter table settings add constraint settings_monthly_recap_mode_check check (monthly_recap_mode in ('off','draft','auto'));

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
    decay_days = coalesce((p->>'decay_days')::int, decay_days),
    monthly_recap_mode = coalesce(nullif(p->>'monthly_recap_mode', ''), monthly_recap_mode)
  where id = 1;
end $function$
;
