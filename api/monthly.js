// Monthly recap email. Vercel cron hits this every evening (see vercel.json);
// it only does anything on the LAST day of the month (ET). The recap covers
// the month: matches played, open challenges, the current top 3, Most Wins /
// Most Matches leaderboard, and a few reminders.
//
// What happens on the last day depends on settings.monthly_recap_mode,
// which admins pick in the Admin tab:
//   "draft" (default)  ONE email to the admins: check results, a BCC list of
//                      every player (temp drops included), the subject, and
//                      the recap to paste into Gmail. A person sends it, so
//                      it costs 1 Resend email instead of ~40 (free tier is
//                      100/day, shared with the daily results email).
//   "auto"             the app emails every player itself, one each, with a
//                      per-player unsubscribe link. Temp-dropped players get
//                      a "contact Matt or Tyler to rejoin" box.
//   "off"              nothing.
//
// Recipients: every player still in the league with an email (on the ladder
// or temp dropped), unless monthly_emails was turned off.
//
// Before anything goes out it runs tick() (so expired challenges aren't
// counted as open), then verifyRecap() checks the data. In auto mode any
// problem blocks the send and the admins get the list instead; in draft mode
// the problems are shown in red at the top of the draft.
//
// Other ways in:
//   POST (from the Admin tab, signed-in admin's token)
//                      "Email me the draft now": sends the draft for the
//                      month so far to the admins. Doesn't count as the
//                      month's recap.
//   ?preview=1[&month=YYYY-MM][&dropped=1]
//                      the recap as a web page, with the check results.
//                      Sends nothing. No login needed: it only shows names
//                      and counts the app already shows publicly.
//   ?force=1&key=<CRON_SECRET>[&month=YYYY-MM]
//                      run the last-day job on another day (the cron failed,
//                      or a problem was fixed). Still refuses a month done.
//
// Needs the migration supabase/migrations/2026-10-31-monthly-recap.sql.

import { makeSb } from "../lib/tourney.js";
import { resolveMonth, isLastDayET, buildRecap, verifyRecap, buildDraft } from "../lib/monthly.js";

export default async function handler(req, res) {
  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  const FROM = process.env.EMAIL_FROM || "FXBG Ladder <onboarding@resend.dev>";
  const SITE = process.env.SITE_URL || `https://${req.headers.host}`;
  const SECRET = process.env.CRON_SECRET;
  const q = req.query || {};

  if (!SB || !KEY) return res.status(200).json({ skipped: "not configured" });

  const manual = req.method === "POST";
  const preview = !manual && q.preview === "1";
  const force = !manual && q.force === "1";
  const cron = !manual && !preview;

  if (cron) {
    const authed = !SECRET || req.headers.authorization === `Bearer ${SECRET}` || q.key === SECRET;
    if (!authed) return res.status(401).json({ error: "unauthorized" });
  }
  if (!preview && !RESEND) return res.status(200).json({ skipped: "email not configured" });
  // Cheap exit for the 29-30 evenings a month that aren't the last day.
  if (cron && !force && !isLastDayET()) {
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
        <p>The monthly recap was <b>NOT sent</b>. Here's what went wrong:</p>
        <ul>${lines.map((l) => `<li style="margin:0 0 6px">${String(l).replace(/</g, "&lt;")}</li>`).join("")}</ul>
        <p>Preview what it would say: <a href="${SITE}/api/monthly?preview=1">${SITE}/api/monthly?preview=1</a></p>
        <p>Once it's fixed, tap <b>Email me the draft now</b> in the Admin tab and send it from Gmail.</p>
      </div>`,
    }]);
    return r.ok;
  };

  try {
    const players = await must("players", `players?select=id,name,email,rank,active,dropped,is_admin,email_token,monthly_emails`);
    adminEmails = players.filter((p) => p.is_admin && p.email).map((p) => p.email);

    // The Admin-tab button: only a signed-in admin. Supabase checks the token.
    if (manual) {
      const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const u = token
        ? await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } })
        : null;
      const user = u && u.ok ? await u.json() : null;
      const email = String(user?.email || "").toLowerCase();
      if (!email || !players.some((p) => p.is_admin && String(p.email || "").toLowerCase() === email)) {
        return res.status(403).json({ error: "Admins only" });
      }
    }

    // Housekeeping first: expire stale challenges, auto-confirm scores, so
    // the open-challenge count and the rankings are current.
    if (!preview) {
      await fetch(`${SB}/rest/v1/rpc/tick`, {
        method: "POST",
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: "{}",
      }).catch(() => {});
    }

    const [settingsRows, fresh] = await Promise.all([
      must("settings", `settings?id=eq.1&select=*`),
      // Re-read after tick(): decay may have moved ranks.
      preview ? Promise.resolve(players)
        : must("players", `players?select=id,name,email,rank,active,dropped,is_admin,email_token,monthly_emails`),
    ]);
    const settings = settingsRows[0] || null;
    const mode = settings?.monthly_recap_mode || "draft";
    if (cron && mode === "off") return res.status(200).json({ skipped: "monthly recap is off" });

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
            `&winner_id=not.is.null&${range}&select=id,player_a,player_b,winner_id,result_type,reported_at`)
      : [];

    // Everyone still in the league: on the ladder or temp dropped.
    const recipients = fresh.filter(
      (p) => p.email && (p.active !== false || p.dropped === true) && p.monthly_emails !== false
    );

    const recap = buildRecap({
      month, players: fresh, challenges, tMatches,
      openCount: open.length, tourney: tourneys[0] || null, settings, site: SITE,
    });
    const problems = verifyRecap({ month, players: fresh, challenges, tMatches, open, settings, recipients, now });
    const unsub = (token) => `${SITE}/api/unsubscribe?t=${token}&list=monthly`;

    if (preview) {
      const variant = q.dropped === "1" ? "dropped" : q.draft === "1" ? "everyone" : "ladder";
      const link = (v, label) => {
        const params = ["preview=1", q.month ? `month=${q.month}` : "", v === "dropped" ? "dropped=1" : v === "everyone" ? "draft=1" : ""];
        return v === variant ? `<b>${label}</b>` : `<a href="?${params.filter(Boolean).join("&")}">${label}</a>`;
      };
      const check = problems.length
        ? `<div style="font-family:Arial,sans-serif;font-size:13px;background:#fde8e8;color:#8a1c1c;padding:10px 14px;border-radius:6px;margin:0 0 12px"><b>Checks failed.</b><ul style="margin:6px 0 0">${problems.map((p) => `<li>${p.replace(/</g, "&lt;")}</li>`).join("")}</ul></div>`
        : `<div style="font-family:Arial,sans-serif;font-size:13px;background:#e8f5e9;color:#1b5e20;padding:10px 14px;border-radius:6px;margin:0 0 12px">All checks passed &middot; ${recipients.length} recipients (${recipients.filter((p) => p.dropped).length} temp drops) &middot; mode: ${mode}</div>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>Monthly recap preview</title></head><body style="margin:0;padding:16px;background:#fff">` +
          `<p style="font-family:Arial,sans-serif;font-size:12px;color:#8a948f">PREVIEW &middot; ${recap.subject} &middot; ` +
          `${link("everyone", "Gmail draft")} &middot; ${link("ladder", "auto: on ladder")} &middot; ${link("dropped", "auto: temp drop")}</p>` +
          check + recap.html(variant === "everyone" ? null : "#", variant) + `</body></html>`
      );
    }

    const draftTo = async (isManual) => {
      const d = buildDraft({ recap, problems, recipients, month, manual: isManual });
      return sendBatch([{
        from: `FXBG Ladder <${fromAddr}>`, to: adminEmails, subject: d.subject, html: d.html,
      }]);
    };

    if (manual) {
      if (!adminEmails.length) return res.status(200).json({ error: "No admin emails on file" });
      const r = await draftTo(true);
      return res.status(200).json({ draft: true, ok: r.ok, to: adminEmails.length, problems, out: r.ok ? undefined : r.out });
    }

    // ---- last day of the month (cron, or force=1) ----
    if (settings?.monthly_recap_sent_for === month.key) {
      return res.status(200).json({ skipped: `${month.key} recap already done` });
    }
    if (mode === "auto" && problems.length) {
      const alerted = await alertAdmins(`Monthly recap NOT sent — ${problems.length} problem${problems.length === 1 ? "" : "s"}`, problems);
      return res.status(200).json({ blocked: true, month: month.key, problems, alerted });
    }

    // Claim the month first, so a second cron fire finds it taken. The window
    // end is stored so next month's recap picks up exactly where this stopped.
    const claimed = await sb.patch(
      `settings?id=eq.1&or=(monthly_recap_sent_for.is.null,monthly_recap_sent_for.neq.${month.key})`,
      { monthly_recap_sent_for: month.key, monthly_recap_sent_at: month.end.toISOString() }
    );
    if (!claimed.length) return res.status(200).json({ skipped: `${month.key} recap already done` });
    const release = () => sb.patch(`settings?id=eq.1`, {
      monthly_recap_sent_for: settings?.monthly_recap_sent_for ?? null,
      monthly_recap_sent_at: settings?.monthly_recap_sent_at ?? null,
    });

    if (mode !== "auto") {
      const r = await draftTo(false);
      if (!r.ok) await release();
      return res.status(200).json({ draft: true, month: month.key, ok: r.ok, problems, stats: recap.stats, out: r.ok ? undefined : r.out });
    }

    const base = { from: `FXBG Ladder <${fromAddr}>`, reply_to: adminEmails.length ? adminEmails : undefined };
    const results = [];
    for (let i = 0; i < recipients.length; i += 100) {
      const chunk = recipients.slice(i, i + 100).map((p) => ({
        ...base, to: [p.email], subject: recap.subject,
        html: recap.html(unsub(p.email_token), p.dropped === true ? "dropped" : "ladder"),
      }));
      results.push(await sendBatch(chunk));
    }
    if (results.some((r) => !r.ok)) {
      // Nothing went out: release the claim so a force=1 retry can send it.
      if (results.every((r) => !r.ok)) await release();
      await alertAdmins("Monthly recap: the email provider rejected the send",
        results.filter((r) => !r.ok).map((r) => JSON.stringify(r.out).slice(0, 300)));
    }
    return res.status(200).json({
      sent: recipients.length, month: month.key, stats: recap.stats,
      resend: results.every((r) => r.ok), out: results.map((r) => r.out),
    });
  } catch (e) {
    if (!preview) await alertAdmins("Monthly recap NOT sent — couldn't load the data", [String(e)]).catch(() => {});
    return res.status(200).json({ error: String(e) });
  }
}
