// Sends challenge emails via Resend. Called by the app after a challenge
// action succeeds. Failures here never block the ladder itself.
//
// Vercel env vars needed:
//   SUPABASE_URL            — same as VITE_SUPABASE_URL
//   SUPABASE_SERVICE_KEY    — Supabase > Settings > API > service_role key
//   RESEND_API_KEY          — resend.com > API Keys
//   EMAIL_FROM  (optional)  — e.g. "FXBG Ladder <ladder@yourdomain.com>"
//                             defaults to Resend's onboarding address

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { type, challengeId } = req.body || {};
  if (!type || !challengeId) return res.status(400).json({ error: "Missing type or challengeId" });

  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  const FROM = process.env.EMAIL_FROM || "FXBG Ladder <onboarding@resend.dev>";
  if (!SB || !KEY || !RESEND) return res.status(200).json({ skipped: "email not configured" });

  const sbFetch = async (path) => {
    const r = await fetch(`${SB}/rest/v1/${path}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    return r.json();
  };

  try {
    const [ch] = await sbFetch(`challenges?id=eq.${challengeId}&select=*`);
    if (!ch) return res.status(404).json({ error: "Challenge not found" });
    const [challenger] = await sbFetch(`players?id=eq.${ch.challenger_id}&select=*`);
    const [opponent] = await sbFetch(`players?id=eq.${ch.opponent_id}&select=*`);
    const site = `https://${req.headers.host}`;

    let to, subject, html, fromName, replyTo;
    const btn = `<p><a href="${site}" style="background:#D8F529;color:#0F2E25;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold">Open the ladder</a></p>`;

    if (type === "issued") {
      to = opponent?.email;
      fromName = `${challenger.name} · FXBG Ladder`;
      replyTo = challenger?.email;
      subject = `${challenger.name} challenged you on the FXBG ladder`;
      html = `<p><b>${challenger.name}</b> (#${challenger.rank}) has challenged you (#${opponent.rank}).</p>
        <p>Accept by <b>${new Date(ch.accept_by).toLocaleDateString()}</b> or the challenge expires.</p>
        <p>Reply to this email to reach ${challenger.name} directly.</p>${btn}`;
    } else if (type === "accepted") {
      to = challenger?.email;
      fromName = `${opponent.name} · FXBG Ladder`;
      replyTo = opponent?.email;
      const daysToPlay = Math.max(1, Math.ceil((new Date(ch.play_by) - Date.now()) / 86400000));
      subject = `${opponent.name} accepted your challenge`;
      html = `<p>Awesome — <b>${opponent.name}</b> has accepted your challenge!</p>
        <p>Use the contact information below to reach your opponent and set up all match details. Remember, you have <b>${daysToPlay} days</b> (by <b>${new Date(ch.play_by).toLocaleDateString()}</b>) to complete your match before it expires.</p>
        <p style="font-family:monospace;line-height:1.8">
          ${opponent.email ? `EMAIL: <a href="mailto:${opponent.email}">${opponent.email}</a><br/>` : ""}
          ${opponent.phone ? `PHONE: <a href="tel:${opponent.phone}">${opponent.phone}</a>` : ""}
        </p>
        <p>You can also just reply to this email — it goes straight to ${opponent.name}.</p>${btn}`;
    } else if (type === "reported") {
      const loserId = ch.winner_id === ch.challenger_id ? ch.opponent_id : ch.challenger_id;
      const [loser] = await sbFetch(`players?id=eq.${loserId}&select=*`);
      const winner = ch.winner_id === ch.challenger_id ? challenger : opponent;
      to = [challenger?.email, opponent?.email].filter(Boolean);
      fromName = `FXBG Ladder`;
      subject = `Final: ${winner.name} def. ${loser.name}${ch.score && ch.score !== "n/a" ? ` ${ch.score}` : ""}`;
      html = `<p>The score has been recorded: <b>${winner.name}</b> def. <b>${loser.name}</b>${ch.score && ch.score !== "n/a" ? ` ${ch.score}` : ""}.</p>
        <p>The ladder has been updated. If this score was reported in error, contact Matt.</p>${btn}`;
    } else {
      return res.status(400).json({ error: "Unknown type" });
    }

    if (!to) return res.status(200).json({ skipped: "recipient has no email" });

    // Keep the configured sender ADDRESS (required by Resend) but show the
    // other player's NAME, TennisRungs-style: "Andy Wolfenbarger · FXBG Ladder"
    const fromAddr = FROM.includes("<") ? FROM.match(/<([^>]+)>/)[1] : FROM;
    const from = fromName ? `${fromName} <${fromAddr}>` : FROM;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND}` },
      body: JSON.stringify({ from, to, subject, html, reply_to: replyTo || undefined }),
    });
    const out = await r.json();
    return res.status(200).json({ sent: true, id: out.id });
  } catch (e) {
    return res.status(200).json({ error: String(e) }); // 200 on purpose: never break the app over email
  }
}
