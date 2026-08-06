// Public "Request to join" endpoint. Anyone can POST here (no auth) —
// that's the point: the person isn't on the ladder yet. Writes a row to
// join_requests using the service key, then emails the admins.
//
// The join_requests table has RLS on with no public policies, so this
// endpoint is the only way in and the anon client can never read
// applicant contact info.
//
// Vercel env vars needed (all already set for notify.js):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY, EMAIL_FROM, SITE_URL

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const phone = String(req.body?.phone || "").trim();
  const note = String(req.body?.note || "").trim().slice(0, 500);

  if (!name) return res.status(400).json({ error: "Name is required" });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "A valid email is required" });
  }

  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  const FROM = process.env.EMAIL_FROM || "FXBG Ladder <onboarding@resend.dev>";
  const SITE = process.env.SITE_URL || "https://rallyladders.com";
  if (!SB || !KEY) return res.status(500).json({ error: "Server not configured" });

  const sbFetch = async (path, init) => {
    const r = await fetch(`${SB}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
    return r;
  };

  try {
    // Already a player? Don't create a request — tell them to just sign in.
    const pr = await sbFetch(`players?email=eq.${encodeURIComponent(email)}&select=id,active`);
    const existing = await pr.json();
    if (Array.isArray(existing) && existing.length > 0 && existing[0].active) {
      return res.status(200).json({ already: true });
    }

    const ins = await sbFetch("join_requests", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ name, email, phone: phone || null, note: note || null }),
    });

    if (!ins.ok) {
      const err = await ins.json().catch(() => ({}));
      // Unique partial index on pending emails — they already applied.
      if (String(err?.code) === "23505") {
        return res.status(200).json({ duplicate: true });
      }
      return res.status(500).json({ error: err?.message || "Could not save request" });
    }

    // Email the admins. Best-effort — a failed email never fails the request,
    // because the row is already saved and visible in the Admin tab.
    if (RESEND) {
      try {
        const ar = await sbFetch("players?is_admin=eq.true&select=email,name");
        const admins = await ar.json();
        const to = (admins || []).map((a) => a.email).filter(Boolean);
        if (to.length) {
          const fromAddr = FROM.includes("<") ? FROM.match(/<([^>]+)>/)[1] : FROM;
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND}` },
            body: JSON.stringify({
              from: `FXBG Ladder <${fromAddr}>`,
              to,
              subject: `Join request: ${name}`,
              reply_to: email,
              html: `<p><b>${name}</b> asked to join the ladder.</p>
                <p>EMAIL: <a href="mailto:${email}">${email}</a><br/>
                ${phone ? `PHONE: <a href="tel:${phone}">${phone}</a><br/>` : ""}</p>
                ${note ? `<p>THEY SAID: ${note}</p>` : ""}
                <p>Approve or deny it in the Admin tab.</p>
                <p style="margin:28px 0"><a href="${SITE}" style="background:#D8F529;color:#0F2E25;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold">Open the ladder</a></p>`,
            }),
          });
        }
      } catch {}
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
