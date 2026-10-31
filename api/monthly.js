// Monthly recap email. Vercel cron hits this every evening (see vercel.json);
// it only does anything on the LAST day of the month (ET). It recaps the
// month: matches played, open challenges, the current top 3, Most Wins /
// Most Matches leaderboard, and a few reminders.
//
// Recipients: EVERY player still in the league with an email, including
// temp drops (active or dropped), unless they turned off monthly_emails.
// Temp-dropped players also get a "contact Matt or Tyler to rejoin" box.
// The daily-results opt-out (daily_emails) does not apply here; this one has
// its own unsubscribe link (/api/unsubscribe?t=<token>&list=monthly).
// Replies go to the admins.
//
// Before sending it runs tick() (so expired challenges aren't counted as
// open), then verifyRecap() checks the data: ranks 1..N with no gaps or
// repeats, every counted match has two real players and a valid winner,
// no open challenge past its deadline, etc. If ANY check fails, players get
// nothing and the admins get an email listing the problems. Fix them, then
// re-send with force=1.
//
// Modes:
//   (cron)                  real send, last day of the month only, once per
//                           month (settings.monthly_recap_sent_for).
//   ?preview=1[&month=YYYY-MM]
//                           returns the email as a web page, plus the
//                           verification result. Sends nothing. No secret
//                           needed: only shows names and counts the app
//                           already shows publicly.
//   ?test=1&key=<CRON_SECRET>[&month=YYYY-MM]
//                           sends ONE copy to the admins only, [TEST] subject.
//   ?force=1&key=<CRON_SECRET>[&month=YYYY-MM]
//                           real send on another day (the cron failed, or a
//                           verification problem was fixed). Still refuses a
//                           month already sent.
//
// Needs the migration supabase/migrations/2026-10-31-monthly-recap.sql.

import { makeSb } from "../lib/tourney.js";
import { resolveMonth, isLastDayET, buildRecap, verifyRecap } from "../lib/monthly.js";

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

  const real = !preview && !test;
  // Cheap exit for the 29-30 evenings a month that aren't the last day.
  if (real && !force && !isLastDayET()) {
    return res.status(200).json({ skipped: "not the last day of the month (use force=1)" });
  }

  const sb = makeSb(SB, KEY);
  // A failed read must stop the send, not quietly become "0 matches".
  const must = async (label, path) => {
    const out = await sb.get(path);
    if (!Array.isArray(out)) throw new Error(`Couldn't read ${label}: ${JSON.stringify(out).slice(0, 200)}`);
    return out;
  };
  const fromAddr = FROM.includes("<") ? FROM.match(/<([^>]+)>/)[1] : FROM;
  const sendBatch = async (batch) => {
    const r = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND}` },
      body: JSON.stringify(batch),
    });
    return { ok: r.ok, out: await r.json().catch(() => null) };
  };
  let adminEmails = [];
  const alertAdmins = async (subject, lines) => {
    if (!RESEND || !adminEmails.length) return false;
    const r = await sendBatch([{
      from: `FXBG Ladder <${fromAddr}>`, to: adminEmails, subject,
      html: `<div style="font-family:Arial,sans-serif;color:#0F2E25;max-width:640px">
        <p>The monthly recap was <b>NOT sent</b> to players. Here's what looked wrong:</p>
        <ul>${lines.map((l) => `<li style="margin:0 0 6px">${String(l).replace(/</g, "&lt;")}</li>`).join("")}</ul>
        <p>Preview what it would say: <a href="${SITE}/api/monthly?preview=1">${SITE}/api/monthly?preview=1</a></p>
        <p>Once it's fixed, send it with <code>${SITE}/api/monthly?force=1&amp;key=&lt;CRON_SECRET&gt;</code></p>
      </div>`,
    }]);
    return r.ok;
  };

  try {
    // Housekeeping first: expire stale challenges, auto-confirm scores, so
    // the open-challenge count and the rankings are current.
    if (!preview) {
      await fetch(`${SB}/rest/v1/rpc/tick`, {
        method: "POST",
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: "{}",
      }).catch(() => {});
    }

    const [settingsRows, players] = await Promise.all([
      must("settings", `settings?id=eq.1&select=*`),
      must("players", `players?select=id,name,email,rank,active,dropped,is_admin,email_token,monthly_emails`),
    ]);
    adminEmails = players.filter((p) => p.is_admin && p.email).map((p) => p.email);
    const settings = settingsRows[0] || null;
    const now = new Date();
    const month = resolveMonth(q.month, now, settings?.monthly_recap_sent_at);
    const range = `reported_at=gte.${encodeURIComponent(month.start.toISOString())}` +
      `&reported_at=lt.${encodeURIComponent(month.end.toISOString())}`;

    const [challenges, open, tourneys] = await Promise.all([
      must("ladder matches", `challenges?status=in.(reported,completed)&${range}&select=id,challenger_id,opponent_id,winner_id,reported_at`),
      must("open challenges", `challenges?status=in.(pending,accepted)&select=id,status,accept_by,play_by`),
      must("tournaments", `tournaments?is_test=eq.false&select=id,name,status,champion_id,completed_at&order=created_at.desc`),
    ]);
    const tMatches = tourneys.length
      ? await must("tournament matches",
          `tournament_matches?tournament_id=in.(${tourneys.map((t) => t.id).join(",")})` +
            `&result_type=eq.played&${range}&select=id,player_a,player_b,winner_id,reported_at`)
      : [];

    // Everyone still in the league: on the ladder or temp dropped.
    const recipients = players.filter(
      (p) => p.email && (p.active !== false || p.dropped === true) && p.monthly_emails !== false
    );

    const recap = buildRecap({
      month, players, challenges, tMatches,
      openCount: open.length, tourney: tourneys[0] || null, settings, site: SITE,
    });
    const problems = verifyRecap({ month, players, challenges, tMatches, open, settings, recipients, now });
    const unsub = (token) => `${SITE}/api/unsubscribe?t=${token}&list=monthly`;

    if (preview) {
      const dropped = q.dropped === "1";
      const check = problems.length
        ? `<div style="font-family:Arial,sans-serif;font-size:13px;background:#fde8e8;color:#8a1c1c;padding:10px 14px;border-radius:6px;margin:0 0 12px"><b>Would NOT send.</b><ul style="margin:6px 0 0">${problems.map((p) => `<li>${p.replace(/</g, "&lt;")}</li>`).join("")}</ul></div>`
        : `<div style="font-family:Arial,sans-serif;font-size:13px;background:#e8f5e9;color:#1b5e20;padding:10px 14px;border-radius:6px;margin:0 0 12px">All checks passed &middot; ${recipients.length} recipients (${recipients.filter((p) => p.dropped).length} temp drops)</div>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>Monthly recap preview</title></head><body style="margin:0;padding:16px;background:#fff">` +
          `<p style="font-family:Arial,sans-serif;font-size:12px;color:#8a948f">PREVIEW &middot; subject: ${recap.subject} &middot; ` +
          `window ${month.start.toISOString()} &rarr; ${month.end.toISOString()} &middot; ` +
          `<a href="?preview=1${q.month ? `&month=${q.month}` : ""}${dropped ? "" : "&dropped=1"}">${dropped ? "show normal version" : "show temp-drop version"}</a></p>` +
          check + recap.html("#", dropped) + `</body></html>`
      );
    }

    const base = {
      from: `FXBG Ladder <${fromAddr}>`,
      reply_to: adminEmails.length ? adminEmails : undefined,
    };

    if (test) {
      if (!adminEmails.length) return res.status(200).json({ skipped: "no admin emails" });
      const note = problems.length
        ? `<p style="font-family:Arial,sans-serif;color:#8a1c1c"><b>Verification would block the real send:</b><br/>${problems.join("<br/>")}</p>`
        : "";
      const r = await sendBatch([
        { ...base, to: adminEmails, subject: `[TEST] ${recap.subject}`, html: note + recap.html("#") },
        { ...base, to: adminEmails, subject: `[TEST, temp-drop version] ${recap.subject}`, html: note + recap.html("#", true) },
      ]);
      return res.status(200).json({ test: true, month: month.key, problems, stats: recap.stats, resend: r.ok, out: r.out });
    }

    if (settings?.monthly_recap_sent_for === month.key) {
      return res.status(200).json({ skipped: `${month.key} recap already sent` });
    }
    if (problems.length) {
      const alerted = await alertAdmins(`Monthly recap NOT sent — ${problems.length} problem${problems.length === 1 ? "" : "s"}`, problems);
      return res.status(200).json({ blocked: true, month: month.key, problems, alerted });
    }

    // Claim the month first, so a second cron fire finds it taken. The window
    // end is stored so next month's recap picks up exactly where this stopped.
    const claimed = await sb.patch(
      `settings?id=eq.1&or=(monthly_recap_sent_for.is.null,monthly_recap_sent_for.neq.${month.key})`,
      { monthly_recap_sent_for: month.key, monthly_recap_sent_at: month.end.toISOString() }
    );
    if (!claimed.length) return res.status(200).json({ skipped: `${month.key} recap already sent` });

    const results = [];
    for (let i = 0; i < recipients.length; i += 100) {
      const chunk = recipients.slice(i, i + 100).map((p) => ({
        ...base, to: [p.email], subject: recap.subject, html: recap.html(unsub(p.email_token), p.dropped === true),
      }));
      results.push(await sendBatch(chunk));
    }
    if (results.some((r) => !r.ok)) {
      // Nothing went out: release the claim so a force=1 retry can send it.
      if (results.every((r) => !r.ok)) {
        await sb.patch(`settings?id=eq.1`, {
          monthly_recap_sent_for: settings?.monthly_recap_sent_for ?? null,
          monthly_recap_sent_at: settings?.monthly_recap_sent_at ?? null,
        });
      }
      await alertAdmins("Monthly recap: email provider rejected the send",
        results.filter((r) => !r.ok).map((r) => JSON.stringify(r.out).slice(0, 300)));
    }
    return res.status(200).json({
      sent: recipients.length, month: month.key, stats: recap.stats,
      resend: results.every((r) => r.ok), out: results.map((r) => r.out),
    });
  } catch (e) {
    if (real) await alertAdmins("Monthly recap NOT sent — couldn't load the data", [String(e)]).catch(() => {});
    return res.status(200).json({ error: String(e) });
  }
}
