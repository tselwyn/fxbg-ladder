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
  const { type, challengeId, email } = req.body || {};
  if (!type) return res.status(400).json({ error: "Missing type" });
  if (type !== "welcome" && !challengeId) return res.status(400).json({ error: "Missing challengeId" });

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
    // ---- WELCOME: no challenge involved, looked up by email ----
    if (type === "welcome") {
      if (!email) return res.status(400).json({ error: "Missing email" });
      const site = process.env.SITE_URL || "https://rallyladders.com";
      const [p] = await sbFetch(`players?email=eq.${encodeURIComponent(String(email).trim().toLowerCase())}&select=*`);
      if (!p || !p.email) return res.status(200).json({ skipped: "player not found" });
      const fromAddrW = FROM.includes("<") ? FROM.match(/<([^>]+)>/)[1] : FROM;
      const openBtn = `<p><a href="${site}" style="background:#D8F529;color:#0F2E25;padding:14px 22px;border-radius:4px;text-decoration:none;font-weight:bold">Open the ladder</a></p>`;
      const first = String(p.name || "").split(" ")[0] || "there";
      const w = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND}` },
        body: JSON.stringify({
          from: `FXBG Ladder <${fromAddrW}>`,
          to: p.email,
          subject: `You're on the FXBG Singles Ladder`,
          html: `<p>Welcome to the ladder, ${first}!</p>
            <p>Matt will place you on the ladder based on your level — open the app any time
              to see where you landed. Here's how it works:</p>
            <ul style="line-height:1.7">
              <li><b>Challenge up.</b> You can challenge anyone up to a few spots above you. Tap their row on the ladder and hit Challenge.</li>
              <li><b>They have a few days to accept</b>, then you both have a window to actually play. You'll get emails with the deadlines.</li>
              <li><b>Win and you take their spot.</b> Everyone in between slides down one. Lose and nothing changes.</li>
              <li><b>Either player reports the score</b> in the app when you're done.</li>
            </ul>
            <p><b>Signing in:</b> go to <a href="${site}">rallyladders.com</a>, tap Sign in, and enter
              <b>${p.email}</b>. We'll email you a 6-digit code — it's right in the subject line.
              No password, and you only do this once per device.</p>
            <p>On your phone you can add it to your home screen and it works like an app
              (Share &rarr; Add to Home Screen).</p>
            ${openBtn}
            <p>Questions? Matt Selwyn &middot; 540-498-0799</p>`,
        }),
      });
      const outW = await w.json();
      return res.status(200).json({ sent: true, id: outW.id });
    }

    const [ch] = await sbFetch(`challenges?id=eq.${challengeId}&select=*`);
    if (!ch) return res.status(404).json({ error: "Challenge not found" });
    const [challenger] = await sbFetch(`players?id=eq.${ch.challenger_id}&select=*`);
    const [opponent] = await sbFetch(`players?id=eq.${ch.opponent_id}&select=*`);
    const site = process.env.SITE_URL || "https://rallyladders.com";

    let to, subject, html, fromName, replyTo;
    const btn = `<p><a href="${site}" style="background:#D8F529;color:#0F2E25;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold">Open the ladder</a></p>`;

    if (type === "issued") {
      to = opponent?.email;
      fromName = `${challenger.name} · FXBG Ladder`;
      replyTo = challenger?.email;
      subject = `${challenger.name} challenged you on the FXBG ladder`;
      const acceptUrl = `${process.env.SITE_URL || site}/api/accept?c=${ch.id}&t=${opponent.email_token || ""}`;
      html = `<p><b>${challenger.name}</b> (#${challenger.rank}) has challenged you (#${opponent.rank}).</p>
        <p>Accept by <b>${new Date(ch.accept_by).toLocaleDateString()}</b> or the challenge expires.</p>
        <p><a href="${acceptUrl}" style="background:#0F2E25;color:#D8F529;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold">Click here to accept the challenge</a></p>
        <p>Reply to this email to reach ${challenger.name} directly.</p>${btn}`;

      // Also alert all admins (skip an admin who is one of the two players —
      // they already hear about it). Best-effort; never blocks the player email.
      try {
        const admins = await sbFetch(`players?is_admin=eq.true&select=email,name`);
        const involved = [challenger?.email, opponent?.email].filter(Boolean).map((e) => e.toLowerCase());
        const adminTo = (admins || [])
          .map((a) => a.email)
          .filter((e) => e && !involved.includes(e.toLowerCase()));
        if (adminTo.length) {
          const fromAddrA = FROM.includes("<") ? FROM.match(/<([^>]+)>/)[1] : FROM;
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND}` },
            body: JSON.stringify({
              from: `FXBG Ladder Admin <${fromAddrA}>`,
              to: adminTo,
              subject: `[Admin] Challenge issued: ${challenger.name} → ${opponent.name}`,
              html: `<p><b>${challenger.name}</b> (#${challenger.rank}) has challenged <b>${opponent.name}</b> (#${opponent.rank}).</p>
                <p>Accept-by deadline: <b>${new Date(ch.accept_by).toLocaleDateString()}</b>.</p>${btn}`,
            }),
          });
        }
      } catch (_) { /* admin alert is best-effort */ }
    } else if (type === "accepted") {
      to = challenger?.email;
      fromName = `${opponent.name} · FXBG Ladder`;
      replyTo = opponent?.email;
      const daysToPlay = Math.max(1, Math.ceil((new Date(ch.play_by) - Date.now()) / 86400000));
      subject = `${opponent.name} accepted your challenge`;
      html = `<p>Awesome — <b>${opponent.name}</b> has accepted your challenge!</p>
        <p>Use the contact information below to reach your opponent and set up all match details. Remember, you have <b>${daysToPlay} days</b> (by <b>${new Date(ch.play_by).toLocaleDateString()}</b>) to complete your match before it expires.</p>
        <p style="font-family:monospace;line-height:1.8">
          ${opponent.phone ? `PHONE: <a href="tel:${opponent.phone}">${opponent.phone}</a><br/>` : ""}
          ${opponent.email ? `EMAIL: <a href="mailto:${opponent.email}">${opponent.email}</a>` : ""}
        </p>
        <p>You can also just reply to this email — it goes straight to ${opponent.name}.</p>${btn}`;
    } else if (type === "wildcard") {
      // Admin-arranged match. One email, both players, contact info for each
      // other, no accept step. Sent to the two players who agreed to it.
      const lo = challenger; // lower-ranked player is stored as challenger
      const hi = opponent;
      const daysToPlay = Math.max(1, Math.ceil((new Date(ch.play_by) - Date.now()) / 86400000));
      to = [challenger?.email, opponent?.email].filter(Boolean);
      fromName = `FXBG Ladder`;
      subject = `Wildcard match pending: ${lo.name} vs. ${hi.name}`;
      const contact = (p) => `<p style="font-family:monospace;line-height:1.8">
          <b>${p.name}</b> (#${p.rank})<br/>
          ${p.phone ? `PHONE: <a href="tel:${p.phone}">${p.phone}</a><br/>` : ""}
          ${p.email ? `EMAIL: <a href="mailto:${p.email}">${p.email}</a>` : ""}
        </p>`;
      html = `<p>A <b>wildcard match</b> has been set up between <b>${lo.name}</b> (#${lo.rank})
          and <b>${hi.name}</b> (#${hi.rank}).</p>
        <p>Wildcard matches are set up by an admin as an exception to the usual rules.
          They ignore the normal challenge range, they don't use up either of your
          challenge slots, and they don't trip the rematch cooldown. Otherwise this
          one counts exactly like any other match.</p>
        <p>Use the contact info below to sort out the details. You have
          <b>${daysToPlay} day${daysToPlay === 1 ? "" : "s"}</b>
          (by <b>${new Date(ch.play_by).toLocaleDateString()}</b>) to play, and either
          player can report the score in the app.</p>
        ${contact(lo)}
        ${contact(hi)}
        <p>If <b>${lo.name}</b> wins, they take over <b>#${hi.rank}</b> on the ladder,
          same as any other match.</p>${btn}`;
    } else if (type === "reported") {
      const loserId = ch.winner_id === ch.challenger_id ? ch.opponent_id : ch.challenger_id;
      const [loser] = await sbFetch(`players?id=eq.${loserId}&select=*`);
      const winner = ch.winner_id === ch.challenger_id ? challenger : opponent;
      to = [challenger?.email, opponent?.email].filter(Boolean);
      fromName = `FXBG Ladder`;
      subject = `Final: ${winner.name} def. ${loser.name}${ch.score && ch.score !== "n/a" ? ` ${ch.score}` : ""}`;
      html = `<p>The score has been recorded: <b>${winner.name}</b> def. <b>${loser.name}</b>${ch.score && ch.score !== "n/a" ? ` ${ch.score}` : ""}.</p>
        <p>The ladder has been updated. If this score was reported in error, contact Matt.</p>${btn}`;

      // Also alert all admins (skip any admin who played the match — they already
      // get the player email above). Fire-and-forget; never blocks the player email.
      try {
        const admins = await sbFetch(`players?is_admin=eq.true&select=email,name`);
        const playerEmails = to.map((e) => e.toLowerCase());
        const adminTo = (admins || [])
          .map((a) => a.email)
          .filter((e) => e && !playerEmails.includes(e.toLowerCase()));
        if (adminTo.length) {
          const fromAddrA = FROM.includes("<") ? FROM.match(/<([^>]+)>/)[1] : FROM;
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND}` },
            body: JSON.stringify({
              from: `FXBG Ladder Admin <${fromAddrA}>`,
              to: adminTo,
              subject: `[Admin] Score reported: ${winner.name} def. ${loser.name}${ch.score && ch.score !== "n/a" ? ` ${ch.score}` : ""}`,
              html: `<p><b>${winner.name}</b> (#${winner.rank}) def. <b>${loser.name}</b> (#${loser.rank})${ch.score && ch.score !== "n/a" ? ` — <b>${ch.score}</b>` : ""}.</p>
                <p>Reported ${new Date(ch.reported_at || Date.now()).toLocaleString("en-US", { timeZone: "America/New_York" })} ET. The ladder has been updated automatically.</p>${btn}`,
            }),
          });
        }
      } catch (_) { /* admin alert is best-effort */ }
    } else if (type === "withdrawn") {
      // Challenger pulled the challenge — tell the opponent
      to = opponent?.email;
      fromName = `FXBG Ladder`;
      subject = `${challenger.name} withdrew their challenge`;
      html = `<p><b>${challenger.name}</b> has withdrawn their challenge against you.</p>
        <p>No action needed — you're free to make or receive other challenges.</p>${btn}`;
    } else if (type === "declined") {
      // Opponent said no — tell the challenger
      to = challenger?.email;
      fromName = `FXBG Ladder`;
      subject = `${opponent.name} declined your challenge`;
      html = `<p><b>${opponent.name}</b> has declined your challenge.</p>
        <p>You're free to challenge someone else.</p>${btn}`;
    } else {
      return res.status(400).json({ error: "Unknown type" });
    }

    if (!to || (Array.isArray(to) && to.length === 0)) {
      return res.status(200).json({ skipped: "recipient has no email" });
    }

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
