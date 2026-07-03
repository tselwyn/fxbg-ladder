# FXBG Singles Ladder

The ladder itself — challenges, bump rankings, score reporting. Companion to Rally Report.

**Rules baked in:** challenge up to 5 spots above you · max 2 active challenges · bump rank (win = take their spot, everyone between shifts down) · no wildcards · email notifications · 3 days to accept, 10 to play, 48h auto-confirm · inactivity decay (1 spot per 30 idle days). All of it is adjustable in the app's Admin tab.

---

## Setup (one time, ~20 minutes)

### 1. Put this code on GitHub
Create a new repo (e.g. `fxbg-ladder`) → **Add file → Upload files** → drag this whole folder's contents in → commit to `main`.

### 2. Supabase (database + sign-in)
1. supabase.com → New project (free tier). Pick a region like `us-east-1`.
2. **SQL Editor → New query** → paste ALL of `supabase/schema.sql` → **Run**.
3. Add yourself so you can sign in as admin — run this (with your real email):
   ```sql
   insert into players (name, email, rank, is_admin)
   values ('Tyler Selwyn', 'YOUR_EMAIL', 1, true);
   ```
4. **Settings → API**: copy the **Project URL** and the **anon public** key. You'll also need the **service_role** key for step 4 (keep that one secret — it only ever goes in Vercel env vars, never in the code).
5. **Authentication → URL Configuration**: set Site URL to your Vercel URL (add this after step 4 gives you the URL).

### 3. Resend (challenge emails)
1. resend.com → sign up free → **API Keys** → create one, copy it.
2. Optional but recommended: buy a domain (~$12/yr) and verify it in Resend so emails come from `ladder@yourdomain.com` instead of the generic onboarding address.

### 4. Vercel
1. vercel.com → **Add New Project** → import the GitHub repo. Framework: Vite (auto-detected).
2. **Environment Variables** — add these before deploying:

   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | Supabase Project URL |
   | `VITE_SUPABASE_ANON_KEY` | Supabase anon key |
   | `SUPABASE_URL` | same Project URL again |
   | `SUPABASE_SERVICE_KEY` | Supabase service_role key |
   | `RESEND_API_KEY` | Resend API key |
   | `EMAIL_FROM` | optional: `FXBG Ladder <ladder@yourdomain.com>` |

3. Deploy. Go back to Supabase step 2.5 and set the Site URL to the new `*.vercel.app` address (magic-link emails redirect there).

### 5. Load the roster
Sign in with your email (magic link) → **Admin** tab → **Import roster from sheet**. It reads the same Google Sheet Rally Report uses; every row with an email gets added to the bottom of the ladder. Then use the **Rank** button per player to set the real starting order (or `admin_set_rank` won't be needed if you just add them in ladder order). Make your dad an admin with the ★ button next to his name.

---

## Day-to-day

- Everyone can **view** the ladder without signing in. Challenging/reporting requires sign-in (magic link to their roster email — no passwords).
- **Deadlines run themselves**: expired challenges, auto-confirmed scores, and inactivity decay are handled on every page load plus a daily cron at noon UTC.
- **Editing code**: GitHub pencil editor → commit to `main` → Vercel auto-deploys in ~60–90s → hard refresh (Ctrl+Shift+R). Same as Rally Report.
- If the Vercel webhook misses a deploy, push a new commit — don't use the Redeploy button (it rebuilds the old commit).

## Costs
$0 on Vercel Hobby + Supabase free + Resend free. Only optional cost is a domain (~$12/yr) for nicer email sending. Supabase pauses free projects after ~7 days of zero traffic; any page load keeps it awake, and data is never lost either way.
