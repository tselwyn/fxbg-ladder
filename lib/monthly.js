// Monthly recap email: builds the content for api/monthly.js. Pure functions
// only (no fetches), so the same code renders the real email, the
// ?preview=1 page, and local test renders.
//
// It sends on the evening of the LAST day of the month, so the window runs
// from where the previous recap stopped (settings.monthly_recap_sent_at) up
// to the moment it sends. A match reported after that goes into next month's
// recap, so nothing falls through the gap. Without a previous recap the
// window starts at midnight ET on the 1st.
//
// What counts as a match: a ladder challenge reported in the window (status
// reported or completed), plus a PLAYED tournament match reported in the
// window (walkovers don't count, test tournaments never count).

const TZ = "America/New_York";

// UTC instant of midnight ET on the 1st of (year, monthIndex). Tries the
// EDT and EST offsets and keeps whichever lands on hour 0 in ET.
export function etMonthStart(year, monthIndex) {
  for (const off of [4, 5]) {
    const d = new Date(Date.UTC(year, monthIndex, 1, off));
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(d));
    if (h === 0) return d;
  }
  return new Date(Date.UTC(year, monthIndex, 1, 5));
}

// Today's year/month/day in ET.
export function etToday(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(now).map((p) => [p.type, p.value])
  );
  return { year: Number(parts.year), month: Number(parts.month) - 1, day: Number(parts.day) };
}

// True on the last day of the month in ET (tomorrow is the 1st).
export const isLastDayET = (now = new Date()) => etToday(new Date(now.getTime() + 24 * 3600 * 1000)).day === 1;

// The month to report on: "YYYY-MM" if given, otherwise the current ET month.
// prevSentAt = settings.monthly_recap_sent_at (where the last recap stopped).
// It becomes the start only if it falls in the week before this month began;
// anything else (first run, a skipped month) starts at midnight on the 1st.
export function resolveMonth(param, now = new Date(), prevSentAt = null) {
  let year, month;
  const m = /^(\d{4})-(\d{2})$/.exec(param || "");
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]) - 1;
  } else {
    const t = etToday(now);
    year = t.year;
    month = t.month;
  }
  const monthStart = etMonthStart(year, month);
  const monthEnd = etMonthStart(month === 11 ? year + 1 : year, (month + 1) % 12);
  const prev = prevSentAt ? new Date(prevSentAt) : null;
  const start = prev && prev < monthStart && prev > new Date(monthStart.getTime() - 7 * 864e5) ? prev : monthStart;
  const end = now < monthEnd ? now : monthEnd;
  const key = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthName = new Date(Date.UTC(year, month, 15)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return { key, start, end, monthName, label: `${monthName} ${year}` };
}

// Sanity checks run before anything goes to players. Returns a list of
// problems in plain English; empty means safe to send. Any problem stops the
// send and the admins get the list instead.
export function verifyRecap({ month, players, challenges, tMatches, open, settings, recipients, now = new Date() }) {
  const problems = [];
  const byId = new Map(players.map((p) => [p.id, p]));
  const who = (id) => byId.get(id)?.name || `unknown player ${id}`;

  if (!settings) problems.push("Couldn't read the settings row.");

  // The ladder itself: active players ranked exactly 1..N, no gaps or repeats.
  const active = players.filter((p) => p.active !== false);
  if (active.length < 3) problems.push(`Only ${active.length} active players on the ladder.`);
  const ranks = active.map((p) => p.rank).sort((a, b) => a - b);
  const seen = new Set();
  for (const p of active) {
    if (!Number.isInteger(p.rank) || p.rank < 1 || p.rank > active.length) {
      problems.push(`${p.name} has rank ${p.rank}, outside 1-${active.length}.`);
    } else if (seen.has(p.rank)) {
      problems.push(`Two active players share rank #${p.rank}.`);
    }
    seen.add(p.rank);
  }
  for (let r = 1; r <= active.length; r++) {
    if (!ranks.includes(r)) { problems.push(`Nobody is ranked #${r}.`); break; }
  }
  const both = players.filter((p) => p.active !== false && p.dropped === true);
  if (both.length) problems.push(`Marked active AND temp dropped: ${both.map((p) => p.name).join(", ")}.`);

  // Every counted match: two different real players, the winner is one of them,
  // reported inside the window.
  const checkMatch = (a, b, w, at, label) => {
    if (!byId.has(a) || !byId.has(b)) problems.push(`${label}: a player in it doesn't exist (${a} vs ${b}).`);
    else if (a === b) problems.push(`${label}: ${who(a)} is listed as playing themselves.`);
    else if (w !== a && w !== b) problems.push(`${label} ${who(a)} vs ${who(b)}: the winner isn't one of the two players.`);
    const t = new Date(at);
    if (!(t >= month.start && t < month.end)) problems.push(`${label} ${who(a)} vs ${who(b)}: reported ${at}, outside the month.`);
  };
  for (const c of challenges) checkMatch(c.challenger_id, c.opponent_id, c.winner_id, c.reported_at, "Ladder match");
  for (const m of tMatches) checkMatch(m.player_a, m.player_b, m.winner_id, m.reported_at, "Tournament match");

  // Open challenges should already be cleaned up by tick(). One past its
  // deadline means housekeeping didn't run and the open count is wrong.
  const stale = open.filter((c) =>
    (c.status === "pending" && c.accept_by && new Date(c.accept_by) < now) ||
    (c.status === "accepted" && c.play_by && new Date(c.play_by) < now));
  if (stale.length) problems.push(`${stale.length} open challenge(s) are past their deadline (tick didn't run), so the open-challenge count would be wrong.`);

  if (!recipients.length) problems.push("No recipients.");
  const noToken = recipients.filter((p) => !p.email_token);
  if (noToken.length) problems.push(`No unsubscribe token: ${noToken.map((p) => p.name).join(", ")}.`);

  return problems;
}

// Top N by count, highest first, ties by name. Anyone tied with the last
// spot gets in too (up to `cap`), so nobody is cut off on a coin flip.
function leaders(counts, nameOf, n = 5, cap = 8) {
  const rows = [...counts.entries()]
    .filter(([, c]) => c > 0)
    .map(([id, c]) => ({ id, name: nameOf(id), count: c }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  if (rows.length <= n) return rows;
  const floor = rows[n - 1].count;
  return rows.filter((r, i) => i < n || r.count === floor).slice(0, cap);
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const firstName = (p) => String(p?.name || "").split(" ")[0];

// players:   every player row (any status) with id, name, rank, active, is_admin
// challenges: ladder matches reported in the month
// tMatches:   played tournament matches reported in the month (non-test)
// openCount:  challenges currently pending or accepted
// tourney:    the latest non-test tournament, or null
// settings:   the settings row
export function buildRecap({ month, players, challenges, tMatches, openCount, tourney, settings, site }) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const nameOf = (id) => byId.get(id)?.name || "Former player";

  const wins = new Map();
  const played = new Map();
  const bump = (m, id) => id && m.set(id, (m.get(id) || 0) + 1);
  for (const ch of challenges) {
    if (!ch.winner_id) continue;
    bump(wins, ch.winner_id);
    bump(played, ch.challenger_id);
    bump(played, ch.opponent_id);
  }
  for (const m of tMatches) {
    if (!m.winner_id) continue;
    bump(wins, m.winner_id);
    bump(played, m.player_a);
    bump(played, m.player_b);
  }
  const total = challenges.filter((c) => c.winner_id).length + tMatches.filter((m) => m.winner_id).length;
  const tCount = tMatches.filter((m) => m.winner_id).length;

  const top3 = players
    .filter((p) => p.active !== false && p.rank)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3);
  const mostWins = leaders(wins, nameOf);
  const mostMatches = leaders(played, nameOf);

  const admins = players.filter((p) => p.is_admin).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const signoff = admins.map(firstName).filter(Boolean).join(" & ") || "The FXBG Ladder admins";
  const contacts = admins.map(firstName).filter(Boolean).join(" or ") || "an admin";

  const acceptDays = settings?.accept_days ?? 3;
  const playDays = settings?.play_days ?? 10;
  const decayOff = settings && settings.decay_enabled === false;

  // ---- copy ----
  const intro = total === 0
    ? `${month.monthName} was a quiet one on the ladder &mdash; no matches reported.`
    : `${month.monthName} wrapped up with <b>${total} match${total === 1 ? "" : "es"}</b> completed` +
      (tCount ? ` (including ${tCount} tournament match${tCount === 1 ? "" : "es"})` : "") +
      (total >= 30 ? "!!" : "!");
  const open = openCount > 0
    ? ` Right now there ${openCount === 1 ? "is <b>1 open challenge</b>" : `are <b>${openCount} open challenges</b>`} waiting to be played. If you have an open challenge, now's the time to get it scheduled!`
    : "";

  let tourneyLine = "";
  if (tourney) {
    const doneInMonth = tourney.completed_at &&
      new Date(tourney.completed_at) >= month.start && new Date(tourney.completed_at) < month.end;
    if (tourney.status === "locked") {
      tourneyLine = `The <b>${esc(tourney.name)}</b> is underway &mdash; follow the bracket on the Tournament tab.`;
    } else if (tourney.status === "complete" && doneInMonth && tourney.champion_id) {
      tourneyLine = `Congrats to <b>${esc(nameOf(tourney.champion_id))}</b>, champion of the ${esc(tourney.name)}! &#127942;`;
    }
  }

  const list = (rows) => rows.map((r) => `${esc(r.name)} (${r.count})`).join(", ");

  const P = 'style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#0F2E25"';
  const H = 'style="margin:26px 0 10px;font-family:Arial,sans-serif;font-size:17px;color:#0F2E25"';
  const LI = 'style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#0F2E25"';

  const reminders = [
    `<b>Check your notifications.</b> Keep an eye on the app and your email so you can accept challenges promptly &mdash; you have ${acceptDays} day${acceptDays === 1 ? "" : "s"} to accept, and your opponent is waiting on you!`,
    `<b>Play within ${playDays} days.</b> Once a challenge is accepted, get it on the calendar. It keeps the ladder moving for everyone.`,
    `<b>Going to be unavailable?</b> Use the Temp Drop feature to step off the ladder temporarily &mdash; it's quick, easy, and keeps things fair for the players challenging you.`,
  ];
  if (decayOff) {
    reminders.push(`<b>Winter schedule.</b> Inactivity decay is paused, so nobody slides for sitting out a few weeks.`);
  }

  const subject = `${month.label} Ladder Recap — FXBG Singles Tennis`;

  // The temp-drop note, right under the greeting.
  //   "dropped":  auto-send, only temp-dropped players get it, worded to them
  //   "everyone": the draft (one email BCC'd to all), so it's worded generally
  //   "ladder":   auto-send to players on the ladder, no box
  const dropBox = (variant) => variant === "ladder" ? "" : `
      <div style="border:2px solid #D8F529;background:#F6F8F4;border-radius:6px;padding:12px 16px;margin:0 0 16px">
        <p style="margin:0;font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#0F2E25">${variant === "dropped"
          ? `<b>You're on a temp drop.</b> Miss playing? Contact ${esc(contacts)} to rejoin the ladder &mdash; just reply to this email!`
          : `<b>On a temp drop?</b> Contact ${esc(contacts)} to rejoin the ladder &mdash; just reply to this email!`}</p>
      </div>`;

  // unsubUrl: per-player link (auto-send). null = the draft, which goes out
  // from Matt's Gmail, so opting out is "just reply".
  const html = (unsubUrl, variant = "ladder") => `
    <div style="font-family:Arial,sans-serif;color:#0F2E25;max-width:640px">
      <div style="background:#0F2E25;border-radius:8px 8px 0 0;padding:18px 22px;margin:0 0 20px">
        <div style="font-size:30px;line-height:1">&#127934;</div>
        <h2 style="margin:6px 0 0;color:#D8F529;font-family:Arial,sans-serif">${month.label} Recap &mdash; FXBG Singles Tennis</h2>
      </div>
      <p ${P}>Good evening, everyone!</p>
      ${dropBox(variant)}
      <p ${P}>${intro}${open}</p>
      ${tourneyLine ? `<p ${P}>${tourneyLine}</p>` : ""}
      ${top3.length ? `<p ${P}><b>Current Rankings (Top 3):</b> ${top3.map((p) => `#${p.rank} ${esc(p.name)}`).join(", ")}</p>` : ""}
      ${mostWins.length || mostMatches.length ? `
      <h3 ${H}>${month.label} Leaderboard</h3>
      ${mostWins.length ? `<p ${P}><b>Most Wins:</b> ${list(mostWins)}</p>` : ""}
      ${mostMatches.length ? `<p ${P}><b>Most Matches:</b> ${list(mostMatches)}</p>` : ""}` : ""}
      <h3 ${H}>A Few Reminders</h3>
      <ul style="margin:0 0 14px;padding-left:20px">
        ${reminders.map((r) => `<li ${LI}>${r}</li>`).join("")}
      </ul>
      <p style="margin:24px 0"><a href="${site}" style="background:#D8F529;color:#0F2E25;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold">Open the ladder</a></p>
      <p ${P}>See you on the court &mdash; let's keep the momentum going!</p>
      <p ${P}>${esc(signoff)}</p>
      <p style="font-size:12px;color:#8a948f;margin-top:28px">${unsubUrl
        ? `Questions? Just reply to this email. To stop getting this monthly recap, click <a href="${unsubUrl}">HERE</a>.`
        : `To opt out of ladder emails, just reply and let us know.`}</p>
    </div>`;

  return { subject, html, stats: { total, tournament: tCount, open: openCount, mostWins, mostMatches, top3: top3.map((p) => p.name) } };
}

// The "ready to send" email that goes to the admins in draft mode: check
// results, the BCC list, the subject, then the recap to copy into Gmail.
export function buildDraft({ recap, problems, recipients, month, manual = false }) {
  const F = "font-family:Arial,sans-serif;color:#0F2E25";
  const dropCount = recipients.filter((p) => p.dropped === true).length;
  const bcc = recipients.map((p) => p.email).join(", ");
  const check = problems.length
    ? `<div style="${F};background:#fde8e8;color:#8a1c1c;padding:12px 16px;border-radius:6px;margin:0 0 16px">
        <b>&#9888;&#65039; Don't send yet &mdash; ${problems.length} thing${problems.length === 1 ? "" : "s"} looked wrong:</b>
        <ul style="margin:6px 0 0;padding-left:20px">${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
        <div style="margin-top:8px">Fix it in the app, then tap <b>Email me the draft now</b> in Admin for a fresh copy.</div>
      </div>`
    : `<div style="${F};background:#e8f5e9;color:#1b5e20;padding:12px 16px;border-radius:6px;margin:0 0 16px">
        &#9989; All checks passed &mdash; rankings, match results and open challenges look right.
      </div>`;
  const box = "background:#F6F8F4;border:1px solid #d9dfd6;border-radius:6px;padding:10px 12px;font-family:monospace;font-size:13px;line-height:1.5;word-break:break-all;margin:6px 0 16px";
  const html = `
    <div style="${F};max-width:640px">
      <p style="${F};font-size:15px;margin:0 0 14px">${manual ? "Here's the draft you asked for" : "The month's almost over &mdash; here's the recap"}, ready to send from Gmail.</p>
      ${check}
      <p style="${F};font-size:14px;margin:0"><b>1. BCC these ${recipients.length} people</b> (${dropCount} on temp drop):</p>
      <div style="${box}">${esc(bcc)}</div>
      <p style="${F};font-size:14px;margin:0"><b>2. Subject:</b></p>
      <div style="${box}">${esc(recap.subject)}</div>
      <p style="${F};font-size:14px;margin:0 0 6px"><b>3. Copy everything below the line</b> into the email body, read it over, and send.</p>
      <p style="${F};font-size:12px;color:#8a948f;margin:0 0 6px">Numbers cover ${month.start.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} &ndash; ${month.end.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET.</p>
      <div style="border-top:2px dashed #8a948f;margin:18px 0 22px;text-align:center;font-family:Arial,sans-serif;font-size:11px;color:#8a948f;letter-spacing:2px">&#9986; COPY BELOW THIS LINE</div>
    </div>
    ${recap.html(null, "everyone")}`;
  return {
    subject: `${problems.length ? "⚠️ Check first: " : ""}${month.label} recap — ready to send`,
    html,
  };
}
