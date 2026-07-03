// Daily housekeeping: expires stale challenges, auto-confirms overdue scores,
// and applies inactivity decay. Vercel calls this on the cron in vercel.json.
// (The app also runs tick() on every page load, so this is just a backstop
// for quiet weeks when nobody opens the app.)

export default async function handler(req, res) {
  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SB || !KEY) return res.status(200).json({ skipped: "not configured" });
  try {
    const r = await fetch(`${SB}/rest/v1/rpc/tick`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: "{}",
    });
    return res.status(200).json({ ok: r.ok });
  } catch (e) {
    return res.status(200).json({ error: String(e) });
  }
}
