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

  // ---- WEEKLY BACKUP (Sundays) ----
  // Emails full CSV exports of players, challenges, and legacy_matches to
  // BACKUP_EMAIL (Vercel env var; comma-separate for multiple recipients).
  // Supabase free tier has no automatic backups — this is the offsite copy.
  // Deliberately runs BEFORE the "no matches today" early-return below, so
  // quiet weeks still get backed up. Best-effort: never blocks the digest.
  const BACKUP_TO = (process.env.BACKUP_EMAIL || "").split(",").map((e) => e.trim()).filter(Boolean);
  if (BACKUP_TO.length && new Date().getUTCDay() === 0) {
    try {
      // Paged read — Supabase caps responses at 1000 rows, and legacy_matches
      // alone is over that. A naive fetch would silently truncate the backup.
      const allRows = async (table) => {
        const out = [];
        const page = 1000;
        for (let from = 0; ; from += page) {
          const r = await fetch(
            `${SB}/rest/v1/${table}?select=*&order=created_at.asc,id.asc`,
            { headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + page - 1}` } }
          );
          if (!r.ok) throw new Error(`${table} ${r.status}`);
          const rows = await r.json();
          out.push(...rows);
          if (rows.length < page) return out;
        }
      };
      const toCsv = (rows) => {
        if (!rows.length) return "";
        const cols = Object.keys(rows[0]);
        const esc = (v) => {
          const s = v === null || v === undefined ? "" : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
      };
      const [pl, chl, leg] = await Promise.all([
        allRows("players"), allRows("challenges"), allRows("legacy_matches"),
      ]);
      const stamp = new Date().toISOString().slice(0, 10);
      const b64 = (t) => Buffer.from(t, "utf8").toString("base64");
      const fromAddrB = FROM.includes("<") ? FROM.match(/<([^>]+)>/)[1] : FROM;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND}` },
        body: JSON.stringify({
          from: `FXBG Ladder Backup <${fromAddrB}>`,
          to: BACKUP_TO,
          subject: `[Backup] Ladder data ${stamp} — ${pl.length} players, ${chl.length} matches, ${leg.length} legacy`,
          html: `<p>Weekly database backup attached. Nothing to do — this email existing is the backup.</p>
            <p style="font-family:monospace">players: ${pl.length}<br/>challenges: ${chl.length}<br/>legacy_matches: ${leg.length}</p>
            <p>Restore after a total loss: new Supabase project &rarr; run schema.sql from the repo &rarr; Table Editor &rarr; import these CSVs (players first, then challenges, then legacy_matches).</p>`,
          attachments: [
            { filename: `players-${stamp}.csv`, content: b64(toCsv(pl)) },
            { filename: `challenges-${stamp}.csv`, content: b64(toCsv(chl)) },
            { filename: `legacy_matches-${stamp}.csv`, content: b64(toCsv(leg)) },
          ],
        }),
      });
    } catch (_) { /* backup is best-effort; the digest below always runs */ }
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
