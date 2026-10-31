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
-- ============================================================

alter table players  add column if not exists monthly_emails boolean not null default true;
alter table settings add column if not exists monthly_recap_sent_for text;
alter table settings add column if not exists monthly_recap_sent_at timestamp with time zone;
