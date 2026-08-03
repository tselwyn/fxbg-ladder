// One-click unsubscribe from the daily digest. Linked from every digest email
// as /api/unsubscribe?t=<email_token>. No login required — the token is the
// proof. Flips players.daily_emails to false and shows a tiny confirmation page.

export default async function handler(req, res) {
  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const t = (req.query && req.query.t) || "";
  const page = (msg) =>
    `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#0F2E25;background:#F6F8F4;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>FXBG Singles Tennis</h2><p>${msg}</p></div></body></html>`;

  if (!SB || !KEY) return res.status(200).send(page("Email settings are not configured."));
  if (!/^[0-9a-f-]{36}$/i.test(t)) return res.status(200).send(page("That unsubscribe link isn't valid."));

  try {
    const r = await fetch(`${SB}/rest/v1/players?email_token=eq.${t}`, {
      method: "PATCH",
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ daily_emails: false }),
    });
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length > 0) {
      return res
        .status(200)
        .send(page("You've been removed from the daily results email. Challenge and score emails still apply. Changed your mind? Contact Matt."));
    }
    return res.status(200).send(page("That unsubscribe link isn't valid."));
  } catch (e) {
    return res.status(200).send(page("Something went wrong — try again later."));
  }
}
