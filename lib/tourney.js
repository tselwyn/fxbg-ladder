// Shared tournament email helpers for api/tourney.js, api/tick.js and
// api/digest.js. Lives outside api/ so Vercel doesn't deploy it as a function.
//
// Test tournaments (is_test) never email players: every message goes to the
// admins instead, with [TEST] in the subject.

export const ROUND_NAMES = ["Quarterfinal", "Semifinal", "Final"];
export const roundName = (r) => ROUND_NAMES[r - 1] || `Round ${r}`;
const ROUND_SHORT = ["QF", "SF", "Final"];

export const FORMAT_LINE =
  "Best 2 of 3 full sets, with a normal tiebreak at 6-6 in every set. " +
  "No 10-point tiebreak in place of a third set.";

// "Mon, Nov 2" in ET
export const fmtDay = (d) =>
  new Date(d).toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
  });
// "Nov 2" in ET
const fmtShort = (d) =>
  new Date(d).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

const firstName = (p) => String(p?.name || "").split(" ")[0] || "there";

// "QF Oct 20 – Nov 2 · SF Nov 3 – Nov 12 · Final Nov 13 – Nov 22"
export const scheduleLine = (t) =>
  (t.rounds || [])
    .map((r, i) => `${ROUND_SHORT[i] || r.name} ${fmtShort(r.starts)} – ${fmtShort(r.ends)}`)
    .join(" &middot; ");

export function makeSb(SB, KEY) {
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  return {
    get: async (path) => (await fetch(`${SB}/rest/v1/${path}`, { headers })).json(),
    // PATCH that returns the rows it changed. A filter like `x=is.null` turns
    // it into a claim: an empty result means someone else already did it.
    patch: async (path, body) => {
      const r = await fetch(`${SB}/rest/v1/${path}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify(body),
      });
      const out = await r.json();
      return Array.isArray(out) ? out : [];
    },
  };
}

export function makeMailer(RESEND, FROM) {
  const addr = FROM.includes("<") ? FROM.match(/<([^>]+)>/)[1] : FROM;
  return async ({ to, bcc, subject, html, fromName = "FXBG Ladder" }) => {
    const list = (Array.isArray(to) ? to : [to]).filter(Boolean);
    if (!list.length) return false;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND}` },
      body: JSON.stringify({
        from: `${fromName} <${addr}>`, to: list,
        bcc: bcc && bcc.length ? bcc : undefined, subject, html,
      }),
    });
    return r.ok;
  };
}

// Everything an email needs about the people involved.
export async function loadPeople(sb) {
  const players = await sb.get(`players?select=id,name,email,phone,rank,is_admin`);
  const byId = new Map((players || []).map((p) => [p.id, p]));
  const admins = (players || []).filter((p) => p.is_admin && p.email)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const adminNames = admins.map(firstName).join(" or ") || "an admin";
  return { byId, admins, adminEmails: admins.map((a) => a.email), adminNames };
}

// Who actually receives a player email. Test runs go to admins only.
export const route = (t, playerEmails, people) =>
  t.is_test ? people.adminEmails : playerEmails.filter(Boolean);
export const subj = (t, s) => (t.is_test ? `[TEST] ${s}` : s);

export const contactHtml = (p) => `<p style="font-family:monospace;line-height:1.8">
    <b>${p.name}</b><br/>
    ${p.phone ? `PHONE: <a href="tel:${p.phone}">${p.phone}</a><br/>` : ""}
    ${p.email ? `EMAIL: <a href="mailto:${p.email}">${p.email}</a>` : ""}
  </p>`;

const btn = (site) =>
  `<p><a href="${site}/?tab=tournament" style="background:#D8F529;color:#0F2E25;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold">View the bracket</a></p>`;

// player id -> seed number, from the first-round matches
export const seedMap = (matches) => {
  const m = new Map();
  for (const x of matches) {
    if (x.round !== 1) continue;
    if (x.player_a) m.set(x.player_a, x.seed_a);
    if (x.player_b) m.set(x.player_b, x.seed_b);
  }
  return m;
};

// ---------- "You qualified" (sent once, when the bracket locks) ----------
export async function sendQualified({ t, matches, people, send, site }) {
  const seeds = seedMap(matches);
  const snapRank = new Map((t.seeds_snapshot || []).map((s) => [s.id, s.rank]));
  const qf = matches.filter((m) => m.round === 1 && m.player_a && m.player_b);
  let sent = 0;
  for (const m of qf) {
    for (const [meId, oppId] of [[m.player_a, m.player_b], [m.player_b, m.player_a]]) {
      const me = people.byId.get(meId);
      const opp = people.byId.get(oppId);
      if (!me || !opp) continue;
      const ok = await send({
        to: route(t, [me.email], people),
        subject: subj(t, `You qualified for the ${t.name} 🎾`),
        html: `<p>Congrats ${firstName(me)}! You finished #${snapRank.get(meId) ?? me.rank} on the ladder and
            you're the <b>${seeds.get(meId)} seed</b> in the ${t.name}.</p>
          <p><b>Your quarterfinal:</b> vs. ${opp.name} (${seeds.get(oppId)} seed)<br/>
            <b>Play by:</b> ${fmtDay(m.play_by)}</p>
          ${contactHtml(opp)}
          <p><b>Format:</b> ${FORMAT_LINE}<br/>
            <b>Scheduling:</b> Reach out to your opponent this week. Either player reports the score in the app.<br/>
            <b>Can't get it played by the deadline?</b> Contact ${people.adminNames}.</p>
          <p><b>Schedule:</b> ${scheduleLine(t)}</p>${btn(site)}`,
      });
      if (ok) sent++;
      if (t.is_test) return sent; // one sample is enough for a test run
    }
  }
  return sent;
}

// ---------- Result (sent once per result) ----------
export async function sendResult({ t, m, people, send, site }) {
  const w = people.byId.get(m.winner_id);
  const loserId = m.winner_id === m.player_a ? m.player_b : m.player_a;
  const l = people.byId.get(loserId);
  if (!w || !l) return false;
  const rn = roundName(m.round);
  const wo = m.result_type === "walkover";
  const score = !wo && m.score && m.score !== "n/a" ? ` ${m.score}` : "";
  const isFinal = m.round === (t.rounds || []).length;
  const players = [w.email, l.email];
  const lower = players.filter(Boolean).map((e) => e.toLowerCase());
  return send({
    to: route(t, players, people),
    bcc: t.is_test ? [] : people.adminEmails.filter((e) => !lower.includes(e.toLowerCase())),
    subject: subj(t, wo
      ? `Tournament ${rn}: ${w.name} advances by walkover`
      : `Tournament ${rn}: ${w.name} def. ${l.name}${score}`),
    html: `<p>${wo
        ? `<b>${w.name}</b> advances over <b>${l.name}</b> by walkover in the ${rn}.`
        : `<b>${w.name}</b> def. <b>${l.name}</b>${score} in the ${rn}.`}</p>
      <p>${isFinal
        ? `&#127942; <b>${w.name}</b> is the champion of the ${t.name}!`
        : `${w.name} moves on to the ${roundName(m.round + 1)}.`}</p>
      <p>If this was entered in error, contact ${people.adminNames}.</p>${btn(site)}`,
  });
}

// ---------- "Your next match is set" ----------
// For every match that now has both players, no result and no email yet.
// First-round matches are covered by the qualified email, so they only get
// this after an admin swaps someone in (which clears ready_emailed_at).
export async function sendReady({ t, matches, people, send, sb, site }) {
  if (t.status !== "locked") return 0;
  let sent = 0;
  for (const m of matches) {
    if (!m.player_a || !m.player_b || m.winner_id || m.ready_emailed_at) continue;
    if (m.round === 1 && !t.qualified_emailed_at) continue;
    const claimed = await sb.patch(
      `tournament_matches?id=eq.${m.id}&ready_emailed_at=is.null`,
      { ready_emailed_at: new Date().toISOString() }
    );
    if (!claimed.length) continue;
    const a = people.byId.get(m.player_a);
    const b = people.byId.get(m.player_b);
    if (!a || !b) continue;
    const rn = roundName(m.round);
    const ok = await send({
      to: route(t, [a.email, b.email], people),
      subject: subj(t, `Your ${rn.toLowerCase()} is set: ${a.name} vs. ${b.name}`),
      html: `<p>Your <b>${rn.toLowerCase()}</b> in the ${t.name} is set:
          <b>${a.name}</b> vs. <b>${b.name}</b>.</p>
        <p><b>Play by:</b> ${fmtDay(m.play_by)}</p>
        ${contactHtml(a)}${contactHtml(b)}
        <p><b>Format:</b> ${FORMAT_LINE} Either player reports the score in the app.<br/>
          Can't get it played by the deadline? Contact ${people.adminNames}.</p>${btn(site)}`,
    });
    if (ok) sent++;
  }
  return sent;
}

// ---------- Daily cron: 3-days-left reminders + admin expiry alerts ----------
export async function sendTourneyNotices({ sb, send, site }) {
  const ts = await sb.get(`tournaments?status=eq.locked&select=*`);
  if (!Array.isArray(ts) || !ts.length) return { reminders: 0, expired: 0 };
  const people = await loadPeople(sb);
  const now = Date.now();
  let reminders = 0, expired = 0;

  for (const t of ts) {
    const matches = await sb.get(`tournament_matches?tournament_id=eq.${t.id}&select=*&order=round,slot`);
    if (!Array.isArray(matches)) continue;
    const open = matches.filter((m) => m.player_a && m.player_b && !m.winner_id && m.play_by);

    // 3 days or less left and not played
    for (const m of open) {
      const left = new Date(m.play_by) - now;
      if (left <= 0 || left > 3 * 86400000 || m.reminder_sent_at) continue;
      const claimed = await sb.patch(
        `tournament_matches?id=eq.${m.id}&reminder_sent_at=is.null`,
        { reminder_sent_at: new Date().toISOString() }
      );
      if (!claimed.length) continue;
      const a = people.byId.get(m.player_a);
      const b = people.byId.get(m.player_b);
      if (!a || !b) continue;
      const days = Math.max(1, Math.ceil(left / 86400000));
      const rn = roundName(m.round).toLowerCase();
      const ok = await send({
        to: route(t, [a.email, b.email], people),
        subject: subj(t, `${days} day${days === 1 ? "" : "s"} left: ${a.name} vs. ${b.name}`),
        html: `<p>Heads up: your tournament ${rn} between <b>${a.name}</b> and <b>${b.name}</b>
            is due by <b>${fmtDay(m.play_by)}</b> (${days} day${days === 1 ? "" : "s"} left).</p>
          <p>Already played? Either of you can report the score in the app.
            Haven't played yet? Here's how to reach each other:</p>
          ${contactHtml(a)}${contactHtml(b)}
          <p>Can't get it played in time? Contact ${people.adminNames}.</p>${btn(site)}`,
      });
      if (ok) reminders++;
    }

    // Past deadline: nothing happens automatically, admins decide.
    const late = [];
    for (const m of open) {
      if (new Date(m.play_by) > now || m.expired_notified_at) continue;
      const claimed = await sb.patch(
        `tournament_matches?id=eq.${m.id}&expired_notified_at=is.null`,
        { expired_notified_at: new Date().toISOString() }
      );
      if (claimed.length) late.push(m);
    }
    if (late.length) {
      const rows = late.map((m) =>
        `<li>${roundName(m.round)}: <b>${people.byId.get(m.player_a)?.name}</b> vs. <b>${people.byId.get(m.player_b)?.name}</b> (was due ${fmtDay(m.play_by)})</li>`
      ).join("");
      const ok = await send({
        to: people.adminEmails,
        fromName: "FXBG Ladder Admin",
        subject: subj(t, `[Admin] Tournament match${late.length === 1 ? "" : "es"} past deadline (${late.length})`),
        html: `<p>${late.length === 1 ? "This match has" : "These matches have"} passed the deadline with no score:</p>
          <ul style="line-height:1.7">${rows}</ul>
          <p>Nothing happens automatically. In the Tourney tab, tap <b>Manage</b> on the match to
            extend the deadline, record a walkover, or swap a player.</p>${btn(site)}`,
      });
      if (ok) expired += late.length;
    }
  }
  return { reminders, expired };
}

// ---------- Daily results email: tournament section ----------
export function tourneySectionHtml({ t, matches, byId, since }) {
  const seeds = seedMap(matches);
  const nm = (id) => {
    if (!id) return "TBD";
    const s = seeds.get(id);
    return `${s ? `(${s}) ` : ""}${byId[id]?.name || "Unknown"}`;
  };
  const cell = 'style="padding:4px 14px 4px 0;font-family:Arial,sans-serif;font-size:14px;color:#0F2E25"';
  const muted = 'style="padding:4px 0;font-family:Arial,sans-serif;font-size:13px;color:#5a6b64"';
  const justLocked = t.locked_at && new Date(t.locked_at) >= new Date(since);

  const rounds = (t.rounds || []).map((r, i) => {
    const rows = matches
      .filter((m) => m.round === i + 1)
      .map((m) => {
        if (m.winner_id) {
          const loser = m.winner_id === m.player_a ? m.player_b : m.player_a;
          const right = m.result_type === "walkover" ? "walkover" : (m.score && m.score !== "n/a" ? m.score : "");
          return `<tr><td ${cell}><b>${nm(m.winner_id)}</b> def. ${nm(loser)}</td><td ${muted}>${right}</td></tr>`;
        }
        const due = m.player_a && m.player_b && m.play_by ? `play by ${fmtDay(m.play_by)}` : "";
        return `<tr><td ${cell}>${nm(m.player_a)} vs. ${nm(m.player_b)}</td><td ${muted}>${due}</td></tr>`;
      })
      .join("");
    return `<p style="margin:14px 0 4px;font-weight:bold">${r.name} <span style="font-weight:normal;color:#5a6b64">${fmtShort(r.starts)} – ${fmtShort(r.ends)}</span></p>
      <table cellpadding="0" cellspacing="0">${rows}</table>`;
  }).join("");

  const champ = t.champion_id ? byId[t.champion_id]?.name : null;
  return `<h3 style="margin:28px 0 6px">${justLocked ? `The bracket is set: ${t.name}` : t.name}</h3>
    ${justLocked ? `<p style="margin:0 0 6px;color:#5a6b64">Seeded from the ladder at the cutoff. ${FORMAT_LINE}<br/>Schedule: ${scheduleLine(t)}</p>` : ""}
    ${champ ? `<p style="font-size:16px">&#127942; <b>Champion: ${champ}</b></p>` : ""}
    ${rounds}`;
}
