# Rally Ladders (FXBG Singles Ladder)

Live tennis ladder for a ~38-player league in Fredericksburg, VA. Real people use
this every day — treat production with care.

- Live site: rallyladders.com (Vercel, auto-deploys on push to `main`)
- Work on the `Dev` branch (capital D). Push to `Dev` only, never to `main`.
  Vercel builds a preview for `Dev`; Tyler checks it and merges `Dev` into `main` himself.
- Owner/dev: Tyler. League admin: Matt (uses the Admin tab).

## Stack

- Frontend: React 18 + Vite, almost entirely in `src/main.jsx` (`src/stats.jsx` for stats)
- Backend: Vercel serverless functions in `api/`
- Database + auth: Supabase (Postgres, RLS, code-only OTP sign-in)
- Email: Resend (free tier, 100 emails/day cap)
- Crons (`vercel.json`): `/api/digest` 10:00 UTC daily, `/api/tick` 12:00 UTC daily

## Files

- `src/main.jsx` — the whole app UI
- `api/notify.js` — challenge emails (issued/accepted/declined/withdrawn)
- `api/digest.js` — daily results email + Sunday CSV backup email
- `api/tick.js` — runs `tick()` (expiry, auto-confirm, decay) + "expires soon" reminders
- `api/accept.js`, `api/join.js`, `api/unsubscribe.js`
- `supabase/schema.sql` — source of truth for the database, re-runnable

## Ladder rules (values live in the `settings` table, editable in Admin)

- Bump ranking: winner takes loser's spot, everyone between shifts down one
- Challenge up to `challenge_range` (5) spots above; max 2 active challenges; 1 incoming
- 3 days to accept, 10 to play, scores auto-confirm after 48h
- Ignored challenges auto-EXPIRE (no forfeit, no penalty)
- Inactivity decay: drop 1 spot after 30 idle days (`decay_enabled` toggle)
- Wildcards: admin-arranged matches that skip limits; still one open match per pair
- DB enforces one open match per pair (`challenges_one_open_per_pair` unique index)

## How to work in this repo

1. `git pull` before starting anything. If `main` has commits `Dev` doesn't, merge `main` into `Dev` first.
2. Read the actual code before changing it. Don't assume.
3. Run `npm run build` before every commit. It must pass. `node --check` is not enough for JSX.
4. After big edits, search for literal `\uXXXX` escape sequences in source — a recurring bug here.
5. SQL changes:
   - Write them re-runnable (`ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `IF NOT EXISTS`).
   - Put each change in `supabase/migrations/` as a dated file AND update `schema.sql` to match.
   - You have NO Supabase access. Give Tyler the exact SQL to run in the Supabase SQL editor,
     and tell him clearly that it must run BEFORE he merges the code that depends on it.
   - Never run destructive SQL (UPDATE/DELETE on real data) without showing Tyler the exact
     statement and the rows it affects first.
6. Batch related changes into one commit, pushed to `Dev`. Merging to `main` = live deploy (Tyler does this).
7. Keep email volume low — Resend free tier is 100/day. Don't add per-player emails casually.
8. iOS PWA and Safari have separate sessions; email links open Safari. Sign-out uses
   `signOut({ scope: "local" })` on purpose.

## Previews

- Vercel preview builds for `Dev` use the LIVE database. Actions taken in a preview
  (challenges, scores) happen for real.
- `api/` functions and crons only run on Vercel.

## Current project: 2026 Fredericksburg Ladder Tournament

Rules (decided with Matt, Oct 2026):
- Top 8 on the ladder at the cutoff, **Sun Oct 18 11:59 PM ET**, qualify. Scores reported after
  the cutoff don't count toward seeding. An admin (Tyler or Matt) locks the bracket after that.
- Seeds 1v8, 4v5 (top half), 2v7, 3v6. Best 2 of 3 full sets, normal tiebreak at 6-6 in every set.
  No 10-point match tiebreak in place of a third set.
- QF Oct 20 – Nov 2 (14 days), SF Nov 3–12 (10 days), Final Nov 13–22 (10 days). Done before Thanksgiving.
  Every deadline is 11:59 PM ET.
- Either player reports the score; final immediately, the winner advances automatically.
- Unplayed by the deadline: nothing automatic. Admins get an email and decide (extend, walkover
  for either player, or swap someone in). No arbiter.
- Admins can do everything: swap players, enter/edit/clear any score, walkovers, extend deadlines.
  Changing an old result clears any later match it affected.
- Tournament results do NOT move ladder ranks during the season; they DO count as activity for decay.
  A temp drop from the ladder doesn't remove anyone from the tournament.
- **New year reset (Jan 1, 2027):** the 8 tournament players take ladder spots #1–8 by finish:
  champion #1, runner-up #2, SF losers #3–4 (higher seed first), QF losers #5–8 (by seed).
  Everyone else keeps their relative order below them. Done by an admin (Rank button, or a
  one-tap tool if one gets built).
- Ladder stays open during the tournament with no restrictions.
- Emails: "you qualified" to the 8 when the bracket locks; result to both players (admins bcc);
  "your match is set" when the next round's opponent is known; "N days left" reminder at 3 days;
  admins alerted when a match passes its deadline. No email when a deadline is extended.
  Tournament emails ignore the daily-email opt-out (they're about the player's own match).
  The daily results email carries the bracket while the tournament runs and sends on days with
  a ladder OR tournament result (or the day the bracket locks).
- Later: champion badge next to the winner's name.

How it's built:
- Tables `tournaments` + `tournament_matches` (migration `supabase/migrations/2026-10-02-tournaments.sql`).
  The 2026 tournament row is inserted by that migration.
- Seeds come from `tournaments.seeds_snapshot`, saved by a trigger the first time any rank changes
  after the cutoff (so it's exact without a cron). If nothing changed, lock uses the current ladder.
- RPCs: `tourney_report_score`, `admin_tourney_lock/unlock/set_result/clear_result/set_player/extend`,
  `admin_tourney_create_test/delete_test`. `tourney_propagate` moves winners up the bracket (internal).
- UI: `TournamentTab` in `src/main.jsx`. Admin controls are on the Tourney tab (Manage on each match).
- Emails: `api/tourney.js` (app-triggered, idempotent via *_emailed_at stamps), `api/tick.js`
  (reminders + expiry alerts), `api/digest.js` (bracket section). Shared code in `lib/tourney.js`.
- Test tournaments (`is_test`): admin-only, can lock immediately, every email goes to admins only.
  Delete them before the real one locks.

## Winter soft freeze (Nov 1 – Dec 31)

Admin settings only, no code: `decay_enabled` off, accept 5 days, play 21 days.
Planned code: a banner on the ladder that shows automatically when decay is off.
