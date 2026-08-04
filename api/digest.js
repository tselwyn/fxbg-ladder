// Daily results digest. Vercel cron hits this once a day (see vercel.json).
// Sends ONLY if at least one match was reported in the last 24 hours.
// Recipients: every active player with an email and daily_emails = true.
// Each email carries a per-player unsubscribe link (players.email_token).
//
// Extra env var (recommended): CRON_SECRET — if set, requests must carry
// "Authorization: Bearer <CRON_SECRET>". Vercel sends this automatically
// for cron invocations when the env var exists. Without it, anyone who
// finds the URL could make the app spam the roster.

export default async function handler(req, res) {
  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  const FROM = process.env.EMAIL_FROM || "FXBG Ladder <onboarding@resend.dev>";
  const SITE = process.env.SITE_URL || `https://${req.headers.host}`;
  if (!SB || !KEY || !RESEND) return res.status(200).json({ skipped: "not configured" });

  const SECRET = process.env.CRON_SECRET;
  if (SECRET && req.headers.authorization !== `Bearer ${SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const sbFetch = async (path) => {
    const r = await fetch(`${SB}/rest/v1/${path}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    return r.json();
  };

  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    // Matches reported in the last 24h (reported or already auto-completed)
    const completed = await sbFetch(
      `challenges?status=in.(reported,completed)&reported_at=gte.${since}&select=*&order=reported_at.asc`
    );
    if (!Array.isArray(completed) || completed.length === 0) {
      return res.status(200).json({ skipped: "no matches completed today" });
    }

    // Open challenges (issued or accepted, not yet played)
    const pending = await sbFetch(
      `challenges?status=in.(pending,accepted)&select=*&order=created_at.asc`
    );

    const players = await sbFetch(`players?select=id,name,email,active,daily_emails,email_token`);
    const byId = Object.fromEntries((players || []).map((p) => [p.id, p]));
    const nameOf = (id) => byId[id]?.name || "Unknown";

    const LADDER = "FXBG Singles Tennis";
    const cell = 'style="padding:6px 14px 6px 0;font-family:Arial,sans-serif;font-size:14px;color:#0F2E25"';

    const resultRows = completed
      .map((ch) => {
        const loserId = ch.winner_id === ch.challenger_id ? ch.opponent_id : ch.challenger_id;
        const score = ch.score && ch.score !== "n/a" ? ch.score : "";
        return `<tr><td ${cell}>${LADDER}</td><td ${cell}><b>${nameOf(ch.winner_id)}</b> def. ${nameOf(loserId)}</td><td ${cell}>${score}</td></tr>`;
      })
      .join("");

    const pendingRows = (Array.isArray(pending) ? pending : [])
      .map(
        (ch) =>
          `<tr><td ${cell}>${LADDER}</td><td ${cell}>${nameOf(ch.challenger_id)}</td><td ${cell}>vs.</td><td ${cell}>${nameOf(ch.opponent_id)}</td></tr>`
      )
      .join("");

    const lastReported = completed[completed.length - 1]?.reported_at;
    const dateStr = new Date(lastReported || Date.now()).toLocaleDateString("en-US", {
      timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric",
    });

    const buildHtml = (token) => `
      <div style="font-family:Arial,sans-serif;color:#0F2E25;max-width:640px">
        <div style="background:#0F2E25;border-radius:8px 8px 0 0;padding:18px 22px;margin:0 0 18px">
          <div style="font-size:30px;line-height:1">\ud83c\udfbe</div>
          <h2 style="margin:6px 0 0;color:#D8F529;font-family:Arial,sans-serif">Recent Match Results — FXBG Singles Tennis</h2>
        </div>
        <p style="margin:-8px 0 16px;color:#5a6b64">${dateStr}</p>
        <table cellpadding="0" cellspacing="0">${resultRows}</table>
        ${pendingRows ? `<h3 style="margin:24px 0 8px">Pending Challenges</h3>
        <table cellpadding="0" cellspacing="0">${pendingRows}</table>` : ""}
        <p style="margin:28px 0"><a href="${SITE}" style="background:#D8F529;color:#0F2E25;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold">Open the ladder</a></p>
        <p style="font-size:12px;color:#8a948f">To be removed from these result emails, click <a href="${SITE}/api/unsubscribe?t=${token}">HERE</a>.</p>
      </div>`;

    const recipients = (players || []).filter(
      (p) => p.email && p.active !== false && p.daily_emails !== false
    );
    if (recipients.length === 0) return res.status(200).json({ skipped: "no recipients" });

    const fromAddr = FROM.includes("<") ? FROM.match(/<([^>]+)>/)[1] : FROM;
    const subject = `Recent Match Results — FXBG Singles Tennis (${completed.length} match${completed.length === 1 ? "" : "es"})`;

    // Resend batch endpoint: up to 100 emails per call
    const batch = recipients.map((p) => ({
      from: `FXBG Ladder <${fromAddr}>`,
      to: [p.email],
      subject,
      html: buildHtml(p.email_token),
    }));

    const r = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND}` },
      body: JSON.stringify(batch),
    });
    const out = await r.json();
    return res.status(200).json({ sent: recipients.length, matches: completed.length, resend: r.ok, out });
  } catch (e) {
    return res.status(200).json({ error: String(e) });
  }
}
