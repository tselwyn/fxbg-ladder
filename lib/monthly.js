// Monthly recap email: builds the content for api/monthly.js. Pure functions
// only (no fetches), so the same code renders the real email, the
// ?preview=1 page, and local test renders.
//
// What counts as a match in month M: a ladder challenge reported in M
// (status reported or completed), plus a PLAYED tournament match reported
// in M (walkovers don't count, test tournaments never count). Months are
// calendar months in Eastern time.

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

// The month to report on. "YYYY-MM" if given, otherwise last month (ET).
export function resolveMonth(param, now = new Date()) {
  let year, month;
  const m = /^(\d{4})-(\d{2})$/.exec(param || "");
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]) - 1;
  } else {
    const t = etToday(now);
    year = t.month === 0 ? t.year - 1 : t.year;
    month = t.month === 0 ? 11 : t.month - 1;
  }
  const start = etMonthStart(year, month);
  const end = etMonthStart(month === 11 ? year + 1 : year, (month + 1) % 12);
  const key = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthName = new Date(Date.UTC(year, month, 15)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return { key, start, end, monthName, label: `${monthName} ${year}` };
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
    `<b>Going to be unavailable?</b> Use the Temp Drop feature to step off the ladder temporarily &mdash; it's quick, easy, and keeps things fair for the players challenging you. Rejoin whenever you're ready.`,
  ];
  if (decayOff) {
    reminders.push(`<b>Winter schedule.</b> Inactivity decay is paused, so nobody slides for sitting out a few weeks.`);
  }

  const subject = `${month.label} Ladder Recap — FXBG Singles Tennis`;

  const html = (unsubUrl) => `
    <div style="font-family:Arial,sans-serif;color:#0F2E25;max-width:640px">
      <div style="background:#0F2E25;border-radius:8px 8px 0 0;padding:18px 22px;margin:0 0 20px">
        <div style="font-size:30px;line-height:1">&#127934;</div>
        <h2 style="margin:6px 0 0;color:#D8F529;font-family:Arial,sans-serif">${month.label} Recap &mdash; FXBG Singles Tennis</h2>
      </div>
      <p ${P}>Good evening, everyone!</p>
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
      <p style="font-size:12px;color:#8a948f;margin-top:28px">Questions? Just reply to this email. To stop getting this monthly recap, click <a href="${unsubUrl}">HERE</a>.</p>
    </div>`;

  return { subject, html, stats: { total, tournament: tCount, open: openCount, mostWins, mostMatches, top3: top3.map((p) => p.name) } };
}
