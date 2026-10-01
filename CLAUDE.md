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

## Current project: end-of-season tournament (Oct 2026)

- Top 8 on the ladder at the cutoff (Sun Oct 11) qualify; Matt locks the bracket in Admin
- Seeds 1v8, 4v5, 2v7, 3v6. Best of 3, full third set.
- 10 days per round: QF Oct 12–21, SF Oct 22–31, Final Nov 1–10
- Unplayed by deadline: the responsive player advances (Matt decides via walkover tool)
- Tournament results do NOT move ladder ranks; they DO count as activity for decay
- Ladder stays open during the tournament; no restrictions on tournament players
- Data model: `tournaments` + `tournament_matches` tables, built to support many tournaments
- Build first (before Oct 11): Tournament tab with projected bracket from current top 8,
  countdown to cutoff, "on the bubble" tags for ranks 9–10
- Then (before Oct 12): lock bracket, your-match card, score report/confirm, auto-advance,
  admin walkover/extend/override/replace, round-start + deadline emails
- Later: tournament history, champion badge

## Winter soft freeze (Nov 1 – Dec 31)

Admin settings only, no code: `decay_enabled` off, accept 5 days, play 21 days.
Planned code: a banner on the ladder that shows automatically when decay is off.
