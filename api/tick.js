// Daily housekeeping: expires stale challenges, auto-confirms overdue scores,
// and applies inactivity decay. Vercel calls this on the cron in vercel.json.
// (The app also runs tick() on every page load, so this is just a backstop
// for quiet weeks when nobody opens the app.)
//
// This handler ALSO sends the "your match expires tomorrow" reminder. That
// part deliberately lives here in JS rather than in the tick() RPC, because
// the RPC runs on every page load and would fire emails constantly.
//
// Extra env vars needed for the reminder (same ones notify.js already uses):
//   RESEND_API_KEY, EMAIL_FROM, SITE_URL

// How far ahead to look. The cron runs once a day, so a 24h window would let
// matches whose deadline falls just before the next run slip through entirely.
// 30h overlaps by 6h; play_reminder_sent_at stops the overlap double-sending.
const REMINDER_WINDOW_HOURS = 30;

// Deadline rendered in ET, floored to the hour. Rounding DOWN is deliberate:
// it understates the real cutoff, so nobody is caught out by an email that
// promised more time than they had. play_by's minutes are a meaningless
// artifact of whenever the opponent happened to tap Accept, so we drop them.
const fmtET = (d) => {
  const floored = new Date(d);
  floored.setMinutes(0, 0, 0);
  return floored.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
  });
};

// Whole hours until the deadline, floored. The reminder window is 30h and the
// cron runs once a day, so real notice ranges from ~6h to ~30h — "24 hours"
// would be wrong most of the time.
const hoursUntil = (d) =>
  Math.max(1, Math.floor((new Date(d) - Date.now()) / 3600000));

async function sendPlayReminders(SB, KEY) {
  const RESEND = process.env.RESEND_API_KEY;
  const FROM = process.env.EMAIL_FROM || "FXBG Ladder <onboarding@resend.dev>";
  const site = process.env.SITE_URL || "https://rallyladders.com";
  if (!RESEND) return { skipped: "email not configured" };

  const sbFetch = async (path) => {
    const r = await fetch(`${SB}/rest/v1/${path}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    return r.json();
  };

  const now = new Date();
  const cutoff = new Date(now.getTime() + REMINDER_WINDOW_HOURS * 3600 * 1000);

  // Accepted matches whose play_by lands in the window and that haven't been
  // reminded yet. Already-expired ones are excluded by the gte on now().
  // Wildcards are admin-arranged and deliberately get no reminder — the
  // not.is.true form covers both false and null.
  const due = await sbFetch(
    `challenges?status=eq.accepted` +
      `&play_by=gte.${encodeURIComponent(now.toISOString())}` +
      `&play_by=lte.${encodeURIComponent(cutoff.toISOString())}` +
      `&play_reminder_sent_at=is.null` +
      `&is_wildcard=not.is.true` +
      `&select=id,challenger_id,opponent_id,play_by,is_wildcard&order=play_by.asc`
  );
  if (!Array.isArray(due) || due.length === 0) return { sent: 0 };

  const players = await sbFetch(`players?select=id,name,rank,email,phone`);
  const byId = new Map((players || []).map((p) => [p.id, p]));
  const fromAddr = FROM.includes("<") ? FROM.match(/<([^>]+)>/)[1] : FROM;
  const btn = `<p><a href="${site}" style="background:#D8F529;color:#0F2E25;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold">Open the ladder</a></p>`;

  let sent = 0;
  for (const ch of due) {
    if (ch.is_wildcard) continue; // belt-and-braces if the server filter ever slips
    const a = byId.get(ch.challenger_id);
    const b = byId.get(ch.opponent_id);
    if (!a || !b) continue;
    const to = [a.email, b.email].filter(Boolean);
    if (to.length === 0) continue;

    const contact = (p) => `<p style="font-family:monospace;line-height:1.8">
        <b>${p.name}</b> (#${p.rank})<br/>
        ${p.phone ? `PHONE: <a href="tel:${p.phone}">${p.phone}</a><br/>` : ""}
        ${p.email ? `EMAIL: <a href="mailto:${p.email}">${p.email}</a>` : ""}
      </p>`;

    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND}` },
        body: JSON.stringify({
          from: `FXBG Ladder <${fromAddr}>`,
          to,
          subject: `Expiring soon: ${a.name} vs. ${b.name}`,
          html: `<p>Heads up — your ladder match between <b>${a.name}</b> (#${a.rank})
              and <b>${b.name}</b> (#${b.rank}) expires in about
              <b>${hoursUntil(ch.play_by)} hours</b> — <b>${fmtET(ch.play_by)}</b> ET.</p>
            <p>If you've already played, either of you can report the score in the app.
              If you haven't, there's still time — here's how to reach each other:</p>
            ${contact(a)}
            ${contact(b)}
            <p>If it expires, nothing changes on the ladder — no penalty, but no
              movement either.</p>${btn}`,
        }),
      });
      if (!r.ok) continue; // leave unstamped; next run retries

      // Stamp only after a successful send, so a Resend hiccup doesn't
      // silently burn the reminder.
      await fetch(`${SB}/rest/v1/challenges?id=eq.${ch.id}`, {
        method: "PATCH",
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ play_reminder_sent_at: new Date().toISOString() }),
      });
      sent++;
    } catch (_) {
      // One bad challenge never stops the rest of the batch.
    }
  }
  return { sent, considered: due.length };
}

export default async function handler(req, res) {
  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SB || !KEY) return res.status(200).json({ skipped: "not configured" });

  let ok = false;
  try {
    const r = await fetch(`${SB}/rest/v1/rpc/tick`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: "{}",
    });
    ok = r.ok;
  } catch (e) {
    return res.status(200).json({ error: String(e) });
  }

  // Reminders run after tick() so anything that just expired is already out
  // of 'accepted' and won't get a pointless "expires tomorrow" email.
  let reminders;
  try {
    reminders = await sendPlayReminders(SB, KEY);
  } catch (e) {
    reminders = { error: String(e) };
  }

  return res.status(200).json({ ok, reminders });
}
