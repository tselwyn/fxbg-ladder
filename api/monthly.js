// Monthly recap email. Vercel cron hits this on the 1st of every month
// (see vercel.json) and it recaps the month that just ended: matches played,
// open challenges, the current top 3, Most Wins / Most Matches leaderboard,
// and a few reminders.
//
// Recipients: EVERY player still in the league with an email, including
// temp drops (active or dropped), unless they turned off monthly_emails.
// The daily-results opt-out (daily_emails) does not apply here; this one has
// its own unsubscribe link (/api/unsubscribe?t=<token>&list=monthly).
// Replies go to the admins.
//
// Modes:
//   (cron)                  real send for last month. Only on the 1st (ET),
//                           and only once per month (settings.monthly_recap_sent_for).
//   ?preview=1[&month=YYYY-MM]
//                           returns the email as a web page. Sends nothing.
//                           No secret needed: it only shows names and counts
//                           that the app already shows publicly.
//   ?test=1&key=<CRON_SECRET>[&month=YYYY-MM]
//                           sends ONE copy to the admins only, [TEST] subject.
//   ?force=1&key=<CRON_SECRET>[&month=YYYY-MM]
//                           real send on a day other than the 1st (e.g. the
//                           cron failed). Still refuses a month already sent.
//
// Needs the migration supabase/migrations/2026-10-31-monthly-recap.sql.

import { makeSb } from "../lib/tourney.js";
import { resolveMonth, etToday, buildRecap } from "../lib/monthly.js";

export default async function handler(req, res) {
  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  const FROM = process.env.EMAIL_FROM || "FXBG Ladder <onboarding@resend.dev>";
  const SITE = process.env.SITE_URL || `https://${req.headers.host}`;
  const SECRET = process.env.CRON_SECRET;
  const q = req.query || {};

  if (!SB || !KEY) return res.status(200).json({ skipped: "not configured" });

  const preview = q.preview === "1";
  const test = q.test === "1";
  const force = q.force === "1";
  const authed = !SECRET || req.headers.authorization === `Bearer ${SECRET}` || q.key === SECRET;
  if (!preview && !authed) return res.status(401).json({ error: "unauthorized" });
  if (!preview && !RESEND) return res.status(200).json({ skipped: "email not configured" });

  const month = resolveMonth(q.month);
  const real = !preview && !test;
  if (real && !force && etToday().day !== 1) {
    return res.status(200).json({ skipped: "only sends on the 1st (use force=1)" });
  }

  const sb = makeSb(SB, KEY);
  const arr = (x) => (Array.isArray(x) ? x : []);
  const range = `reported_at=gte.${encodeURIComponent(month.start.toISOString())}` +
    `&reported_at=lt.${encodeURIComponent(month.end.toISOString())}`;

  try {
    const [settingsRows, players, challenges, open, tourneys] = await Promise.all([
      sb.get(`settings?id=eq.1&select=*`),
      sb.get(`players?select=id,name,email,rank,active,dropped,is_admin,email_token,monthly_emails`),
      sb.get(`challenges?status=in.(reported,completed)&${range}&select=id,challenger_id,opponent_id,winner_id`),
      sb.get(`challenges?status=in.(pending,accepted)&select=id`),
      sb.get(`tournaments?is_test=eq.false&select=id,name,status,champion_id,completed_at&order=created_at.desc`),
    ]);
    if (!Array.isArray(players)) throw new Error(`players: ${JSON.stringify(players)}`);
    const settings = arr(settingsRows)[0] || null;
    const tList = arr(tourneys);
    const tMatches = tList.length
      ? arr(await sb.get(
          `tournament_matches?tournament_id=in.(${tList.map((t) => t.id).join(",")})` +
            `&result_type=eq.played&${range}&select=id,player_a,player_b,winner_id`
        ))
      : [];

    const recap = buildRecap({
      month, players, challenges: arr(challenges), tMatches,
      openCount: arr(open).length, tourney: tList[0] || null, settings, site: SITE,
    });
    const unsub = (token) => `${SITE}/api/unsubscribe?t=${token}&list=monthly`;

    if (preview) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>${recap.subject}</title></head><body style="margin:0;padding:16px;background:#fff">` +
          `<p style="font-family:Arial,sans-serif;font-size:12px;color:#8a948f">PREVIEW &middot; subject: ${recap.subject}</p>` +
          recap.html("#") + `</body></html>`
      );
    }

    const fromAddr = FROM.includes("<") ? FROM.match(/<([^>]+)>/)[1] : FROM;
    const adminEmails = players.filter((p) => p.is_admin && p.email).map((p) => p.email);
    const send = async (batch) => {
      const r = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND}` },
        body: JSON.stringify(batch),
      });
      return { ok: r.ok, out: await r.json().catch(() => null) };
    };
    const base = {
      from: `FXBG Ladder <${fromAddr}>`,
      reply_to: adminEmails.length ? adminEmails : undefined,
    };

    if (test) {
      if (!adminEmails.length) return res.status(200).json({ skipped: "no admin emails" });
      const r = await send([{ ...base, to: adminEmails, subject: `[TEST] ${recap.subject}`, html: recap.html("#") }]);
      return res.status(200).json({ test: true, to: adminEmails.length, month: month.key, stats: recap.stats, resend: r.ok, out: r.out });
    }

    // Everyone still in the league: on the ladder or temp dropped.
    const recipients = players.filter(
      (p) => p.email && (p.active !== false || p.dropped === true) && p.monthly_emails !== false
    );
    if (!recipients.length) return res.status(200).json({ skipped: "no recipients" });

    // Claim the month first, so a second cron fire finds it taken.
    const prev = settings?.monthly_recap_sent_for ?? null;
    const claimed = await sb.patch(
      `settings?id=eq.1&or=(monthly_recap_sent_for.is.null,monthly_recap_sent_for.neq.${month.key})`,
      { monthly_recap_sent_for: month.key }
    );
    if (!claimed.length) return res.status(200).json({ skipped: `${month.key} recap already sent` });

    const results = [];
    for (let i = 0; i < recipients.length; i += 100) {
      const chunk = recipients.slice(i, i + 100).map((p) => ({
        ...base, to: [p.email], subject: recap.subject, html: recap.html(unsub(p.email_token)),
      }));
      results.push(await send(chunk));
    }
    // Nothing went out: release the claim so a force=1 retry can send it.
    if (results.every((r) => !r.ok)) {
      await sb.patch(`settings?id=eq.1`, { monthly_recap_sent_for: prev });
    }
    return res.status(200).json({
      sent: recipients.length, month: month.key, stats: recap.stats,
      resend: results.every((r) => r.ok), out: results.map((r) => r.out),
    });
  } catch (e) {
    return res.status(200).json({ error: String(e) });
  }
}
