// Accept a challenge straight from the email. Linked from the "issued"
// challenge email as /api/accept?c=<challengeId>&t=<opponent email_token>.
//
// Two-step on purpose: GET shows a confirmation page with an Accept button,
// and only the button's POST actually accepts. Email security scanners
// (Outlook SafeLinks etc.) pre-fetch GET links in emails — if GET accepted
// directly, robots would accept challenges before the player ever saw them.
//
// The token proves the clicker owns the opponent's email — no login needed.
// After accepting, the page links straight into the app.

export default async function handler(req, res) {
  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const SITE = process.env.SITE_URL || `https://${req.headers.host}`;

  const q = req.query || {};
  const body = req.body || {};
  const c = String(q.c || body.c || "");
  const t = String(q.t || body.t || "");

  const page = (inner) =>
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
     <body style="font-family:Arial,sans-serif;color:#0F2E25;background:#F6F8F4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px">
     <div style="text-align:center;max-width:420px">
       <h2 style="margin:0 0 6px">FXBG Singles Tennis</h2>${inner}
       <p style="margin-top:28px"><a href="${SITE}" style="background:#D8F529;color:#0F2E25;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold">Open the ladder</a></p>
     </div></body></html>`;

  if (!SB || !KEY) return res.status(200).send(page("<p>Not configured.</p>"));
  const uuidRe = /^[0-9a-f-]{36}$/i;
  if (!uuidRe.test(c) || !uuidRe.test(t)) {
    return res.status(200).send(page("<p>This link isn't valid. Open the app to manage your challenges.</p>"));
  }

  const sb = async (path, opts = {}) => {
    const r = await fetch(`${SB}/rest/v1/${path}`, {
      ...opts,
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(opts.headers || {}),
      },
    });
    return r.json();
  };

  try {
    const [ch] = await sb(`challenges?id=eq.${c}&select=*`);
    if (!ch) return res.status(200).send(page("<p>Challenge not found.</p>"));

    // Token must belong to the OPPONENT of this challenge
    const [me] = await sb(`players?email_token=eq.${t}&select=id,name`);
    if (!me || me.id !== ch.opponent_id) {
      return res.status(200).send(page("<p>This link isn't valid for this challenge.</p>"));
    }

    const [challenger] = await sb(`players?id=eq.${ch.challenger_id}&select=name,rank`);

    if (ch.status === "accepted") {
      return res.status(200).send(page(`<p>Already accepted — you're playing <b>${challenger?.name || "your opponent"}</b>. Open the app for their contact info.</p>`));
    }
    if (ch.status !== "pending") {
      return res.status(200).send(page(`<p>This challenge is no longer open (${ch.status}). Open the app for the latest.</p>`));
    }

    if (req.method === "GET") {
      // Confirmation step — scanners stop here, humans tap the button
      return res.status(200).send(
        page(`<p><b>${challenger?.name || "A player"}</b>${challenger?.rank ? ` (#${challenger.rank})` : ""} has challenged you.</p>
          <form method="POST" action="${SITE}/api/accept" style="margin-top:16px">
            <input type="hidden" name="c" value="${c}"/>
            <input type="hidden" name="t" value="${t}"/>
            <button type="submit" style="background:#0F2E25;color:#D8F529;padding:14px 28px;border-radius:4px;border:none;font-weight:bold;font-size:16px;cursor:pointer">Accept challenge</button>
          </form>`)
      );
    }

    if (req.method === "POST") {
      const [settings] = await sb(`settings?id=eq.1&select=play_days`);
      const playDays = settings?.play_days || 10;
      const playBy = new Date(Date.now() + playDays * 86400000).toISOString();

      // Guard on status in the WHERE clause so a double-submit can't re-accept
      const updated = await sb(`challenges?id=eq.${c}&status=eq.pending`, {
        method: "PATCH",
        body: JSON.stringify({ status: "accepted", play_by: playBy }),
      });
      if (!Array.isArray(updated) || updated.length === 0) {
        return res.status(200).send(page("<p>This challenge was just updated by someone else. Open the app for the latest.</p>"));
      }

      // Fire the normal "accepted" email to the challenger (best-effort)
      try {
        await fetch(`${SITE}/api/notify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "accepted", challengeId: c }),
        });
      } catch (_) {}

      return res.status(200).send(
        page(`<p><b>Challenge accepted!</b></p>
          <p>You're playing <b>${challenger?.name || "your opponent"}</b>. Open the app for their contact info and to set up your match.</p>`)
      );
    }

    return res.status(405).send(page("<p>Not allowed.</p>"));
  } catch (e) {
    return res.status(200).send(page("<p>Something went wrong — open the app to accept your challenge there.</p>"));
  }
}
