// Tournament emails. The app calls this after a tournament action succeeds;
// failures here never block the bracket itself.
//
//   { type: "qualified", tournamentId }  after an admin locks the bracket
//   { type: "result",    matchId }       after any score/walkover is entered
//   { type: "sweep",     tournamentId }  after an admin swaps a player
//
// Every send is claimed with a stamp column first (qualified_emailed_at,
// result_emailed_at, ready_emailed_at), so calling this twice, or by anyone
// who finds the URL, never sends the same email twice.
//
// Same env vars as notify.js. The 3-day reminders and the admin
// "past deadline" alerts run from api/tick.js on the daily cron.

import {
  makeSb, makeMailer, loadPeople, sendQualified, sendResult, sendReady,
} from "../lib/tourney.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { type, tournamentId, matchId } = req.body || {};

  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  const FROM = process.env.EMAIL_FROM || "FXBG Ladder <onboarding@resend.dev>";
  const site = process.env.SITE_URL || "https://rallyladders.com";
  if (!SB || !KEY || !RESEND) return res.status(200).json({ skipped: "email not configured" });

  const sb = makeSb(SB, KEY);
  const send = makeMailer(RESEND, FROM);
  const isId = (v) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

  try {
    let tid = tournamentId;
    let resultSent = false;

    if (type === "result") {
      if (!isId(matchId)) return res.status(400).json({ error: "Missing matchId" });
      const claimed = await sb.patch(
        `tournament_matches?id=eq.${matchId}&winner_id=not.is.null&result_emailed_at=is.null`,
        { result_emailed_at: new Date().toISOString() }
      );
      if (claimed.length) {
        const m = claimed[0];
        tid = m.tournament_id;
        const [t] = await sb.get(`tournaments?id=eq.${tid}&select=*`);
        const people = await loadPeople(sb);
        if (t) resultSent = await sendResult({ t, m, people, send, site });
      } else {
        const [m] = await sb.get(`tournament_matches?id=eq.${matchId}&select=tournament_id`);
        tid = m?.tournament_id;
      }
    } else if (type !== "qualified" && type !== "sweep") {
      return res.status(400).json({ error: "Unknown type" });
    }

    if (!isId(tid)) return res.status(200).json({ skipped: "no tournament" });

    let qualified = 0;
    if (type === "qualified") {
      const claimed = await sb.patch(
        `tournaments?id=eq.${tid}&status=eq.locked&qualified_emailed_at=is.null`,
        { qualified_emailed_at: new Date().toISOString() }
      );
      if (claimed.length) {
        const t = claimed[0];
        const matches = await sb.get(`tournament_matches?tournament_id=eq.${tid}&select=*&order=round,slot`);
        const people = await loadPeople(sb);
        qualified = await sendQualified({ t, matches, people, send, site });
        // The qualifier email already covers each first-round match.
        await sb.patch(
          `tournament_matches?tournament_id=eq.${tid}&round=eq.1&ready_emailed_at=is.null`,
          { ready_emailed_at: new Date().toISOString() }
        );
      }
    }

    // Any match that now has both players and hasn't been announced yet.
    const [t] = await sb.get(`tournaments?id=eq.${tid}&select=*`);
    let ready = 0;
    if (t) {
      const matches = await sb.get(`tournament_matches?tournament_id=eq.${tid}&select=*&order=round,slot`);
      const people = await loadPeople(sb);
      ready = await sendReady({ t, matches, people, send, sb, site });
    }

    return res.status(200).json({ resultSent, qualified, ready });
  } catch (e) {
    return res.status(200).json({ error: String(e) }); // 200 on purpose: never break the app over email
  }
}
