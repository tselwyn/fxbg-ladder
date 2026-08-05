import React, { useState, useEffect, useMemo } from "react";

// ================================================================
// RALLY REPORT — stats engine + report UI, ported into the ladder.
// Model code is byte-for-byte from rally--report (pre-backtest —
// do NOT tune weights here; calibrate against legacy_matches first).
// Data now comes from the ladder app's own state (players,
// challenges) plus a one-time paginated read of legacy_matches.
// ================================================================

// ---- THEME (same court, same colors as main.jsx) ----
const C = {
  court: "#1B4D3E",
  clay: "#0F2E25",
  line: "#F5F2E8",
  ball: "#D8F529",
  red: "#E8604C",
  mute: "rgba(245,242,232,0.55)",
  faint: "rgba(245,242,232,0.15)",
};
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

// ================================================================
// DATA LAYER
// ================================================================

// Frozen TennisRungs archive (1,445 rows > the 1000-row page cap, so
// paginate). Cached for the session; safe to call from several places.
let _legacy = null;
export function fetchLegacyLogs(supabase) {
  if (!_legacy) {
    _legacy = (async () => {
      const rows = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        const { data, error } = await supabase
          .from("legacy_matches")
          .select("player_name,opponent_name,player_won,score,player_rank,played_on")
          .order("played_on", { ascending: false })
          .range(from, from + page - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < page) break;
      }
      const logs = new Map();
      for (const r of rows) {
        if (!logs.has(r.player_name)) logs.set(r.player_name, []);
        logs.get(r.player_name).push({
          date: new Date(r.played_on + "T12:00:00"),
          rank: r.player_rank ?? null,
          opp: r.opponent_name,
          win: !!r.player_won,
          score: r.score || "",
        });
      }
      return logs;
    })();
    _legacy.catch(() => { _legacy = null; }); // allow retry after a failed load
  }
  return _legacy;
}

// Name map for EVERY player row ever (active, dropped, or removed) so
// live-era matches against departed players still resolve. Cached.
let _names = null;
export function fetchAllPlayerNames(supabase) {
  if (!_names) {
    _names = (async () => {
      const { data, error } = await supabase.from("players").select("id,name");
      if (error) throw error;
      return new Map((data || []).map((p) => [p.id, p.name]));
    })();
    _names.catch(() => { _names = null; });
  }
  return _names;
}

// New-era match logs from completed challenges, one entry per perspective
// (same shape as the legacy logs): { date, rank, opp, win, score }.
export function buildLiveLogs(challenges, nameById, rankByName) {
  const logs = new Map();
  const push = (name, m) => {
    if (!logs.has(name)) logs.set(name, []);
    logs.get(name).push(m);
  };
  for (const c of challenges) {
    if (c.status !== "completed" || !c.winner_id) continue;
    const ch = nameById.get(c.challenger_id);
    const op = nameById.get(c.opponent_id);
    if (!ch || !op) continue;
    const date = new Date(c.reported_at || c.created_at);
    const score = c.score || "";
    push(ch, { date, rank: c.opponent_rank ?? rankByName.get(op) ?? null, opp: op, win: c.winner_id === c.challenger_id, score });
    push(op, { date, rank: c.challenger_rank ?? rankByName.get(ch) ?? null, opp: ch, win: c.winner_id === c.opponent_id, score });
  }
  for (const arr of logs.values()) arr.sort((a, b) => a.date - b.date);
  return logs;
}

// Full career log per player: new-era merged with the TennisRungs archive.
// Oldest-first — every consumer (recentRecord, h2h weights, FormStrip, the
// reversed log display) assumes ascending; do NOT change to descending.
export function mergeLogs(live, legacy) {
  const names = new Set([...live.keys(), ...(legacy ? legacy.keys() : [])]);
  const out = new Map();
  for (const name of names) {
    const merged = [...(live.get(name) || []), ...((legacy && legacy.get(name)) || [])];
    merged.sort((a, b) => a.date - b.date);
    out.set(name, merged);
  }
  return out;
}

// Adapter: a ladder `players` row -> the rankings-row shape the model
// functions expect (string fields, "W3"/"L2" streaks), so the ported
// model code below stays untouched.
export function playerToRow(p) {
  return {
    rank: String(p.rank),
    name: p.name,
    wins: String(p.wins),
    losses: String(p.losses),
    streak: p.streak > 0 ? `W${p.streak}` : p.streak < 0 ? `L${-p.streak}` : "–",
  };
}

// ================================================================
// ODDS MODEL — ported verbatim from rally--report. Weights are
// heuristic; backtest against legacy_matches before touching them.
// ================================================================

// Laplace-smoothed win %, then shrunk toward 50% for small samples so a
// 3-0 record doesn't outrank a proven 15-5 one. Full weight at 8+ matches.
function smoothedPct(r) {
  const w = +r.wins || 0, l = +r.losses || 0;
  const smoothed = (w + 1) / (w + l + 2);
  const conf = Math.min((w + l) / 8, 1);
  return 0.5 + (smoothed - 0.5) * conf;
}

// Rank-gap and streak terms shared by both the collapsed and expanded models.
function rankStreakScore(a, b) {
  const streakVal = (r) => {
    const m = (r.streak || "").match(/^([WL])\s*(\d+)/i);
    if (!m) return 0;
    const n = Math.min(+m[2], 5);
    return m[1].toUpperCase() === "W" ? n : -n;
  };
  return (
    0.06 * ((+b.rank) - (+a.rank)) +      // higher ladder position edge
    0.08 * (streakVal(a) - streakVal(b))  // current streak
  );
}

// Raw logistic score from rankings-table data only.
function rowScore(a, b) {
  return 3.0 * (smoothedPct(a) - smoothedPct(b)) + rankStreakScore(a, b);
}

// Margin multiplier from a score string: ~1.0 for a typical result, up to
// 1.3 for a blowout (6-0 6-0), down to 0.7 for a razor-thin one (7-6 7-6).
// Retirements, walkovers, and anything unparseable count as a normal match
// so one bogus scoreline can't swing a prediction.
function marginFactor(score) {
  if (!score) return 1;
  if (/ret|def|w\/?o|forfeit|walkover/i.test(score)) return 1;
  const sets = (score.replace(/\([^)]*\)/g, "").match(/\d{1,2}-\d{1,2}/g) || [])
    .map((x) => x.split("-").map(Number))
    .filter(([p, q]) => Math.max(p, q) <= 7 && Math.max(p, q) >= 6);
  if (!sets.length) return 1;
  let g1 = 0, g2 = 0;
  sets.forEach(([p, q]) => { g1 += p; g2 += q; });
  const tot = g1 + g2;
  if (!tot) return 1;
  const dom = Math.abs(g1 - g2) / tot; // 0 = dead even, 1 = double bagel
  return Math.max(0.7, Math.min(1.3, 1 + 0.6 * (dom - 0.3)));
}

// Opponent-strength multiplier for a single result. Symmetric in both
// directions: a win over a top player counts up to 1.4x, a win over a
// bottom player as little as 0.6x — and losses mirror it, so losing to #2
// barely dings you (0.6x) while losing to #28 stings (1.4x). Unknown
// opponent rank = neutral 1.0.
function oppFactor(win, rank, ladderSize) {
  if (!rank) return 1;
  const n = Math.max(ladderSize || 30, 2);
  const q = Math.max(0, Math.min(1, (n - rank) / (n - 1))); // 1 = top, 0 = bottom
  return 1 + 0.8 * (win ? q - 0.5 : 0.5 - q);
}

// Recency-weighted record over the last 15 logged matches: each older match
// worth 12% less, each result scaled by score margin AND opponent strength,
// shrunk for small samples (full weight at 8+ logged matches). Roughly -1..1.
function recentRecord(log, ladderSize) {
  const ms = log.slice(-15);
  if (!ms.length) return 0;
  let s = 0, wsum = 0;
  ms.forEach((m, i) => {
    const w = Math.pow(0.88, ms.length - 1 - i);
    s += (m.win ? 1 : -1) * marginFactor(m.score) * oppFactor(m.win, m.rank, ladderSize) * w;
    wsum += w;
  });
  return (s / wsum) * Math.min(ms.length / 8, 1);
}

function capLogit(score, cap) {
  const s = Math.max(-cap, Math.min(cap, score));
  const p = 1 / (1 + Math.exp(-s));
  const pA = Math.round(p * 100);
  return { pA, pB: 100 - pA };
}

// Collapsed odds from standings data only (no logs needed).
export function challengeOddsRows(a, b) {
  if (!a || !b) return null;
  return capLogit(rowScore(a, b), 2.2); // cap at ~90/10
}

// Refined odds once both match logs are loaded. Uses everything the logs
// give us:
//  - recent record: last 15 matches, recency-weighted, each result scaled
//    by score margin and opponent strength IN BOTH DIRECTIONS — wins over
//    top players count extra, losses to top players count less against you.
//    Blended in over the career record as log data allows, so an improving
//    player isn't dragged down by an old losing season, and a fading one
//    can't coast on past glory.
//  - head-to-head, recency-weighted (last meeting counts most)
//  - H2H margin (a straight-sets win says more than a tiebreak escape)
// Weights are heuristic — backtest against the archive before changing.
export function refinedOdds(a, b, h2hAll, logA, logB, ladderSize) {
  // Blend career record (standings) with recent record (logs). With 8+
  // logged matches each, who you are NOW fully replaces career totals.
  const c = Math.min(Math.min(logA.length, logB.length) / 8, 1);
  let score =
    (1 - c) * 3.0 * (smoothedPct(a) - smoothedPct(b)) +
    c * 1.4 * (recentRecord(logA, ladderSize) - recentRecord(logB, ladderSize)) +
    rankStreakScore(a, b);

  // Head-to-head: last 6 meetings, later meetings weighted heavier.
  const recent = h2hAll.slice(-6);
  recent.forEach((m, idx) => {
    const w = 0.14 * Math.pow(1.3, idx); // most recent ≈ 0.5, oldest ≈ 0.14
    const tight = /7-6|6-7|\(\d+-\d+\)/.test(m.score);
    const sets = (m.score.match(/\d+-\d+/g) || []).length;
    const margin = sets <= 2 && !tight ? 0.06 : 0; // decisive straight sets
    score += (m.win ? 1 : -1) * (w + margin);
  });

  return capLogit(score, 2.5);
}

// Pull head-to-head matches vs `oppName` out of a player's match log.
export function h2hMatches(log, oppName) {
  const norm = (s) => (s || "").replace(/^\s*\d+\s*[.)-]?\s*/, "").toLowerCase().trim();
  const target = norm(oppName);
  let ms = log.filter((m) => norm(m.opp) === target);
  if (!ms.length) {
    // Loose fallback in case the log spells the name slightly differently.
    ms = log.filter((m) => norm(m.opp).includes(target) || target.includes(norm(m.opp)));
  }
  return ms;
}

// Full-strength odds for a challenge row, given the merged log map.
// Falls back to standings-only odds when either log is missing.
export function oddsForPair(pA, pB, logsByName, ladderSize) {
  if (!pA || !pB) return null;
  const a = playerToRow(pA), b = playerToRow(pB);
  const logA = logsByName.get(pA.name);
  const logB = logsByName.get(pB.name);
  if (!logA || !logB) return challengeOddsRows(a, b);
  const h2hAll = h2hMatches(logA, pB.name);
  return refinedOdds(a, b, h2hAll, logA, logB, ladderSize);
}

// ================================================================
// STATS — ported verbatim from rally--report
// ================================================================
export function computeStats(ms) {
  if (!ms.length) return null;
  const wins = ms.filter((x) => x.win).length;
  const total = ms.length;

  const byYear = {};
  ms.forEach((x) => {
    const y = x.date.getFullYear();
    byYear[y] = byYear[y] || { w: 0, l: 0 };
    x.win ? byYear[y].w++ : byYear[y].l++;
  });

  const h2h = {};
  ms.forEach((x) => {
    h2h[x.opp] = h2h[x.opp] || { w: 0, l: 0 };
    x.win ? h2h[x.opp].w++ : h2h[x.opp].l++;
  });

  let bestW = 0, bestL = 0, curW = 0, curL = 0;
  ms.forEach((x) => {
    if (x.win) { curW++; curL = 0; if (curW > bestW) bestW = curW; }
    else { curL++; curW = 0; if (curL > bestL) bestL = curL; }
  });
  const last = ms[ms.length - 1];
  let curStreak = 1;
  for (let i = ms.length - 2; i >= 0; i--) {
    if (ms[i].win === last.win) curStreak++;
    else break;
  }

  const stb = ms.filter((x) => /,\s*\(\d+-\d+\)\s*$/.test(x.score));
  const stbW = stb.filter((x) => x.win).length;

  let tbSets = 0;
  ms.forEach((x) => {
    const sets = x.score.match(/7-6|6-7/g);
    if (sets) tbSets += sets.length;
  });

  let bagelSets = 0;
  const doubleBagels = [];
  ms.forEach((x) => {
    const b = (x.score.match(/6-0/g) || []).length;
    bagelSets += b;
    if (b >= 2) doubleBagels.push(x);
  });

  const cutoff = new Date(last.date);
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const recent = ms.filter((x) => x.date >= cutoff);
  const recentW = recent.filter((x) => x.win).length;

  const topWins = ms.filter((x) => x.win && x.rank === 1);
  const forfeits = ms.filter((x) => /forfeit/i.test(x.score));

  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthCount = {};
  ms.forEach((x) => {
    const k = monthNames[x.date.getMonth()];
    monthCount[k] = (monthCount[k] || 0) + 1;
  });
  const busiest = Object.entries(monthCount).sort((a, b) => b[1] - a[1])[0];

  return {
    ms, wins, losses: total - wins, total,
    winPct: (wins / total) * 100,
    byYear, h2h, bestW, bestL,
    curStreak: { len: curStreak, win: last.win },
    stb: { total: stb.length, w: stbW, l: stb.length - stbW },
    tbSets, bagelSets, doubleBagels,
    recent: { w: recentW, l: recent.length - recentW, total: recent.length },
    topWins, forfeits, busiest,
    firstDate: ms[0].date, lastDate: last.date,
    oppCount: Object.keys(h2h).length,
  };
}

const pct = (w, l) => (w + l ? Math.round((w / (w + l)) * 100) : 0);
const fmtD = (d) =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// ================================================================
// REPORT UI — ported from rally--report
// ================================================================
function Label({ children }) {
  return (
    <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: C.mute, marginBottom: 10, fontFamily: MONO }}>
      {children}
    </div>
  );
}

function RCard({ children, span }) {
  return (
    <div style={{ background: "rgba(15,46,37,0.6)", border: `1px solid ${C.faint}`, borderRadius: 4, padding: 20, gridColumn: span ? "1 / -1" : undefined }}>
      {children}
    </div>
  );
}

function Big({ v, sub, color }) {
  return (
    <div>
      <div style={{ fontFamily: MONO, fontSize: 36, fontWeight: 700, color: color || C.line, lineHeight: 1.1 }}>{v}</div>
      <div style={{ fontSize: 13, color: C.mute, marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function Scoreboard({ s, name }) {
  return (
    <div style={{ background: C.clay, border: `2px solid ${C.line}`, borderRadius: 4, padding: "28px 24px", textAlign: "center", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: "50%", width: 2, height: "100%", background: "rgba(245,242,232,0.12)" }} />
      <div style={{ fontSize: 12, letterSpacing: 4, color: C.mute, textTransform: "uppercase", fontFamily: MONO }}>
        {name ? `${name} — Career Record` : "Career Record"}
      </div>
      <div style={{ display: "flex", justifyContent: "center", alignItems: "baseline", gap: 18, marginTop: 8 }}>
        <span style={{ fontFamily: MONO, fontSize: "clamp(52px, 12vw, 88px)", fontWeight: 700, color: C.ball, lineHeight: 1 }}>{s.wins}</span>
        <span style={{ fontSize: 28, color: C.mute }}>–</span>
        <span style={{ fontFamily: MONO, fontSize: "clamp(52px, 12vw, 88px)", fontWeight: 700, color: C.line, lineHeight: 1 }}>{s.losses}</span>
      </div>
      <div style={{ marginTop: 10, fontSize: 14, color: C.mute, fontFamily: MONO }}>
        {s.winPct.toFixed(1)}% · {s.total} matches · {s.oppCount} opponents · {fmtD(s.firstDate)} → {fmtD(s.lastDate)}
      </div>
    </div>
  );
}

function FormStrip({ ms }) {
  const recent = ms.slice(-30);
  return (
    <div>
      <Label>Last {recent.length} matches</Label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {recent.map((m, i) => (
          <div
            key={i}
            title={`${fmtD(m.date)} vs ${m.opp}: ${m.win ? "W" : "L"} ${m.score}`}
            style={{
              width: 18, height: 18, borderRadius: "50%",
              background: m.win ? C.ball : "transparent",
              border: `2px solid ${m.win ? C.ball : C.red}`,
              boxShadow: m.win ? "inset 0 -2px 0 rgba(0,0,0,0.25)" : "none",
            }}
          />
        ))}
      </div>
    </div>
  );
}

function YearBars({ byYear }) {
  const years = Object.keys(byYear).sort();
  return (
    <div>
      <Label>Win rate by year</Label>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, height: 140 }}>
        {years.map((y) => {
          const { w, l } = byYear[y];
          const p = pct(w, l);
          return (
            <div key={y} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, height: "100%", justifyContent: "flex-end" }}>
              <div style={{ fontSize: 13, fontFamily: MONO, color: C.ball }}>{p}%</div>
              <div style={{ width: "100%", maxWidth: 48, height: `${Math.max(p, 4)}%`, background: C.ball, borderRadius: "2px 2px 0 0", opacity: 0.4 + (p / 100) * 0.6 }} />
              <div style={{ fontSize: 12, color: C.mute, fontFamily: MONO }}>{y}</div>
              <div style={{ fontSize: 11, color: C.mute }}>{w}-{l}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function H2H({ h2h }) {
  const rows = Object.entries(h2h)
    .map(([opp, r]) => ({ opp, ...r, total: r.w + r.l }))
    .filter((r) => r.total >= 2)
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);
  return (
    <div>
      <Label>Head to head (2+ matches)</Label>
      {rows.map((r) => (
        <div key={r.opp} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid rgba(245,242,232,0.08)" }}>
          <div style={{ flex: 1, fontSize: 14, color: C.line, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.opp}</div>
          <div style={{ width: 90, height: 8, background: "rgba(232,96,76,0.5)", borderRadius: 4, overflow: "hidden", flexShrink: 0 }}>
            <div style={{ width: `${pct(r.w, r.l)}%`, height: "100%", background: C.ball }} />
          </div>
          <div style={{ fontFamily: MONO, fontSize: 14, color: r.w >= r.l ? C.ball : C.red, width: 52, textAlign: "right", flexShrink: 0 }}>
            {r.w}-{r.l}
          </div>
        </div>
      ))}
    </div>
  );
}

function Insights({ s }) {
  const items = [];
  const h2hArr = Object.entries(s.h2h).map(([opp, r]) => ({ opp, ...r, total: r.w + r.l }));
  const rival = [...h2hArr].sort((a, b) => b.total - a.total)[0];
  if (rival && rival.total >= 4)
    items.push(
      `Biggest rivalry: ${rival.opp} — ${rival.total} matches, ${rival.w}-${rival.l}. ${
        Math.abs(rival.w - rival.l) <= 2
          ? "Dead even. This one's personal."
          : rival.w > rival.l
          ? "Owns this matchup."
          : "Trails this one."
      }`
    );
  const owned = h2hArr.filter((r) => r.total >= 4 && r.l === 0).sort((a, b) => b.total - a.total)[0];
  if (owned) items.push(`Total ownership: ${owned.w}-0 against ${owned.opp}.`);
  const krypt = h2hArr.filter((r) => r.total >= 4 && r.w === 0).sort((a, b) => b.total - a.total)[0];
  if (krypt) items.push(`Kryptonite: 0-${krypt.l} vs ${krypt.opp}.`);
  if (s.stb.total >= 5) {
    const cp = pct(s.stb.w, s.stb.l);
    items.push(
      `${Math.round((s.stb.total / s.total) * 100)}% of matches went to a deciding super tiebreak (${s.stb.w}-${s.stb.l}). ${
        cp >= 55 ? "Clutch when it counts." : "Closing tight matches is the biggest lever here."
      }`
    );
  }
  if (s.topWins.length) items.push(`Giant killer: ${s.topWins.length} win${s.topWins.length > 1 ? "s" : ""} over the #1 ranked player.`);
  if (s.doubleBagels.length) items.push(`Double bagels served: ${s.doubleBagels.length} (6-0, 6-0).`);
  if (s.recent.total >= 8) {
    const rp = pct(s.recent.w, s.recent.l);
    items.push(
      `Last 12 months: ${s.recent.w}-${s.recent.l} (${rp}%) — ${
        rp > s.winPct + 3
          ? "trending up, playing their best tennis right now."
          : rp < s.winPct - 3
          ? "below career pace lately."
          : "right on career pace."
      }`
    );
  }
  if (s.busiest) items.push(`Busiest month historically: ${s.busiest[0]} (${s.busiest[1]} matches).`);
  return (
    <div>
      <Label>Scouting notes</Label>
      {items.map((t, i) => (
        <div key={i} style={{ display: "flex", gap: 10, padding: "8px 0", fontSize: 14, lineHeight: 1.5, color: C.line, borderBottom: i < items.length - 1 ? "1px solid rgba(245,242,232,0.08)" : "none" }}>
          <span style={{ color: C.ball, flexShrink: 0 }}>›</span>
          <span>{t}</span>
        </div>
      ))}
    </div>
  );
}

function MatchLog({ ms }) {
  const [oppFilter, setOppFilter] = useState(null);
  // newest first
  const ordered = [...ms].reverse();
  const shown = oppFilter ? ordered.filter((m) => m.opp === oppFilter) : ordered;

  // record vs the filtered opponent
  let filtRecord = null;
  if (oppFilter) {
    const w = shown.filter((m) => m.win).length;
    filtRecord = `${w}-${shown.length - w}`;
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <Label>{oppFilter ? `vs ${oppFilter}` : `All matches (${ordered.length})`}</Label>
        {oppFilter && (
          <button
            onClick={() => setOppFilter(null)}
            style={{ background: "none", border: `1px solid ${C.mute}`, color: C.line, borderRadius: 4, padding: "4px 12px", fontSize: 12, cursor: "pointer" }}
          >
            {filtRecord} · clear filter ✕
          </button>
        )}
      </div>
      {!oppFilter && (
        <div style={{ fontSize: 12, color: C.mute, marginBottom: 12 }}>
          Tip: tap any opponent's name to see only those matches.
        </div>
      )}
      <div>
        {shown.map((m, i) => (
          <div
            key={i}
            style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid rgba(245,242,232,0.08)" }}
          >
            <div style={{ fontFamily: MONO, fontSize: 12, color: C.mute, width: 76, flexShrink: 0 }}>
              {fmtD(m.date)}
            </div>
            <div
              style={{
                width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: MONO, fontSize: 12, fontWeight: 700,
                background: m.win ? C.ball : "transparent",
                border: `2px solid ${m.win ? C.ball : C.red}`,
                color: m.win ? C.clay : C.red,
              }}
            >
              {m.win ? "W" : "L"}
            </div>
            <button
              onClick={() => setOppFilter(m.opp === oppFilter ? null : m.opp)}
              style={{ flex: 1, textAlign: "left", background: "none", border: "none", color: C.line, fontSize: 14, cursor: "pointer", padding: 0, textDecoration: "underline", textDecorationColor: "rgba(245,242,232,0.25)" }}
            >
              {m.opp}
            </button>
            <div style={{ fontFamily: MONO, fontSize: 13, color: C.mute, textAlign: "right", flexShrink: 0 }}>
              {m.score}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Toggle({ view, setView }) {
  const opt = (key, label) => (
    <button
      onClick={() => setView(key)}
      style={{
        background: view === key ? C.ball : "transparent",
        color: view === key ? C.clay : C.line,
        border: `1px solid ${view === key ? C.ball : "rgba(245,242,232,0.25)"}`,
        borderRadius: 4, padding: "8px 18px", fontSize: 14, fontWeight: 700, cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: "flex", gap: 8 }}>
      {opt("summary", "Summary")}
      {opt("log", "Match Log")}
    </div>
  );
}

// The full player report (summary/match-log toggle), as in Rally Report.
export function Report({ stats, name }) {
  const [view, setView] = useState("summary");
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
      <div style={{ gridColumn: "1 / -1" }}>
        <Scoreboard s={stats} name={name} />
      </div>
      <div style={{ gridColumn: "1 / -1" }}>
        <Toggle view={view} setView={setView} />
      </div>

      {view === "summary" ? (
        <>
          <RCard span><FormStrip ms={stats.ms} /></RCard>
          <RCard>
            <Label>Streaks</Label>
            <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
              <Big v={stats.bestW} sub="longest win streak" color={C.ball} />
              <Big v={stats.bestL} sub="longest skid" color={C.red} />
              <Big v={`${stats.curStreak.win ? "W" : "L"}${stats.curStreak.len}`} sub="current streak" color={stats.curStreak.win ? C.ball : C.red} />
            </div>
          </RCard>
          <RCard>
            <Label>Clutch</Label>
            <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
              <Big v={`${stats.stb.w}-${stats.stb.l}`} sub="deciding super tiebreaks" color={stats.stb.w >= stats.stb.l ? C.ball : C.red} />
              <Big v={stats.tbSets} sub="sets to 7-6" />
              <Big v={stats.bagelSets} sub="6-0 sets" />
            </div>
          </RCard>
          <RCard span><YearBars byYear={stats.byYear} /></RCard>
          <RCard span><H2H h2h={stats.h2h} /></RCard>
          <RCard span><Insights s={stats} /></RCard>
        </>
      ) : (
        <RCard span><MatchLog ms={stats.ms} /></RCard>
      )}
    </div>
  );
}

// Full-page player report with a back bar and optional Challenge action.
// Rendered by main.jsx in place of the tab content when a player is open.
export function PlayerReportView({ player, logsByName, onBack, onChallenge }) {
  const log = logsByName ? logsByName.get(player.name) || [] : [];
  const stats = useMemo(() => computeStats(log), [log]);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <button
          onClick={onBack}
          style={{ background: "none", border: `1px solid ${C.faint}`, color: C.line, borderRadius: 6, padding: "8px 14px", fontFamily: MONO, fontSize: 12, letterSpacing: 1, cursor: "pointer" }}
        >
          ← BACK
        </button>
        <div style={{ flex: 1 }} />
        {onChallenge && (
          <button
            onClick={onChallenge}
            style={{ background: C.ball, border: "none", color: C.clay, borderRadius: 6, padding: "8px 16px", fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: 1, cursor: "pointer" }}
          >
            CHALLENGE
          </button>
        )}
      </div>
      {!logsByName && (
        <div style={{ textAlign: "center", padding: 40, color: C.mute, fontSize: 14 }}>Loading match history...</div>
      )}
      {logsByName && !stats && (
        <div style={{ textAlign: "center", padding: 40, color: C.mute, fontSize: 14 }}>
          No matches on record for {player.name} yet.
        </div>
      )}
      {stats && <Report stats={stats} name={player.name} />}
    </div>
  );
}

// ================================================================
// ODDS BAR — the pending-challenge probability display, as in
// Rally Report's Rankings view.
// ================================================================
export function OddsBar({ odds, leftName, rightName, compact, note }) {
  if (!odds) return null;
  return (
    <div style={{ marginTop: compact ? 6 : 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, fontFamily: MONO, fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: odds.pA >= odds.pB ? C.ball : C.mute, fontWeight: 700, flexShrink: 0, whiteSpace: "nowrap" }}>
          {leftName ? `${leftName} ` : ""}{odds.pA}%
        </span>
        <span style={{ color: C.mute, fontSize: 10, letterSpacing: 2, textTransform: "uppercase", minWidth: 0, textAlign: "center" }}>
          {note || "win probability"}
        </span>
        <span style={{ color: odds.pB > odds.pA ? C.ball : C.mute, fontWeight: 700, flexShrink: 0, whiteSpace: "nowrap" }}>
          {odds.pB}%{rightName ? ` ${rightName}` : ""}
        </span>
      </div>
      <div style={{ display: "flex", gap: 2, height: 4, borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${odds.pA}%`, background: odds.pA >= odds.pB ? C.ball : "rgba(245,242,232,0.3)", borderRadius: 2 }} />
        <div style={{ width: `${odds.pB}%`, background: odds.pB > odds.pA ? C.ball : "rgba(245,242,232,0.3)", borderRadius: 2 }} />
      </div>
    </div>
  );
}

// ================================================================
// LEADERBOARDS — ported from rally--report, computed from the
// in-memory merged logs (no fetching needed).
// ================================================================
function currentMonth(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { start, end, label: start.toLocaleDateString("en-US", { month: "long", year: "numeric" }) };
}
function lastFullMonth(now = new Date()) {
  const end = new Date(now.getFullYear(), now.getMonth(), 1);
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { start, end, label: start.toLocaleDateString("en-US", { month: "long", year: "numeric" }) };
}
function yearToDate(now = new Date()) {
  const start = new Date(now.getFullYear(), 0, 1);
  const end = new Date(now.getFullYear() + 1, 0, 1);
  return { start, end, label: `${now.getFullYear()} · Year to date` };
}
const PERIODS = [
  { key: "month", title: "This Month", range: currentMonth },
  { key: "last", title: "Last Month", range: lastFullMonth },
  { key: "ytd", title: "Year to Date", range: yearToDate },
];

// Rank per-player matches inside a window. Forfeits are included.
function rankWindow(all, range) {
  const { start, end } = range;
  const tally = all.map((p) => {
    const w = p.matches.filter((m) => m.date >= start && m.date < end);
    return { name: p.name, wins: w.filter((m) => m.win).length, total: w.length };
  });
  const played = tally.filter((t) => t.total > 0);
  const byWins = [...played].sort((a, b) => b.wins - a.wins || b.total - a.total).slice(0, 5);
  const byMatches = [...played].sort((a, b) => b.total - a.total || b.wins - a.wins).slice(0, 5);
  return { byWins, byMatches };
}

function Board({ title, rows, accent, metric }) {
  return (
    <div style={{ flex: 1, minWidth: 240, background: C.clay, border: `1px solid rgba(245,242,232,0.2)`, borderRadius: 8, padding: "16px 18px" }}>
      <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 12, color: C.line }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ color: C.mute, fontSize: 13 }}>No matches recorded.</div>
      ) : (
        rows.map((r, i) => (
          <div
            key={r.name}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 0", borderTop: i === 0 ? "none" : "1px solid rgba(245,242,232,0.1)" }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
              <span style={{ width: 16, textAlign: "right", color: i === 0 ? accent : C.mute, fontWeight: i === 0 ? 800 : 600, fontSize: 13 }}>{i + 1}</span>
              <span style={{ color: C.line, fontSize: 14, fontWeight: i === 0 ? 700 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
            </span>
            <span style={{ color: accent, fontWeight: 800, fontSize: 15, flexShrink: 0, marginLeft: 10 }}>{metric(r)}</span>
          </div>
        ))
      )}
    </div>
  );
}

export function LeaderBoards({ players, logsByName }) {
  const [period, setPeriod] = useState("month"); // default: This Month

  const all = useMemo(() => {
    if (!logsByName) return null;
    return players.map((p) => ({ name: p.name, matches: logsByName.get(p.name) || [] }));
  }, [players, logsByName]);

  const sel = PERIODS.find((p) => p.key === period) || PERIODS[0];
  const range = sel.range();
  const data = all ? rankWindow(all, range) : null;

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: C.mute, fontFamily: MONO }}>
          Leaderboard · {range.label}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              style={{
                background: period === p.key ? C.ball : "transparent",
                color: period === p.key ? C.clay : C.line,
                border: `1px solid ${period === p.key ? C.ball : "rgba(245,242,232,0.25)"}`,
                borderRadius: 4, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer",
              }}
            >
              {p.title}
            </button>
          ))}
        </div>
      </div>
      {!data ? (
        <div style={{ background: C.clay, border: "1px solid rgba(245,242,232,0.2)", borderRadius: 8, padding: "22px 18px", color: C.mute, fontSize: 14, textAlign: "center" }}>
          Crunching results…
        </div>
      ) : (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <Board title="🏆 Most Wins" rows={data.byWins} accent={C.ball} metric={(r) => r.wins} />
          <Board title="🔥 Most Matches" rows={data.byMatches} accent={C.red} metric={(r) => r.total} />
        </div>
      )}
    </div>
  );
}

// ================================================================
// STATS TAB — leaderboards + tap-a-player quick lookups. The league
// match history feed (the old History tab, with admin edit/delete)
// stays in main.jsx and renders below this.
// ================================================================
export function StatsTab({ players, logsByName, onPlayer }) {
  const record = (name) => {
    const log = (logsByName && logsByName.get(name)) || [];
    const w = log.filter((m) => m.win).length;
    return log.length ? `${w}-${log.length - w}` : "–";
  };
  return (
    <div>
      <LeaderBoards players={players} logsByName={logsByName} />
      <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: C.mute, marginBottom: 10, fontFamily: MONO }}>
        Player Reports · lifetime record
      </div>
      <div style={{ background: "rgba(15,46,37,0.6)", border: `1px solid ${C.faint}`, borderRadius: 4, overflow: "hidden", marginBottom: 28 }}>
        {players.map((p, i) => (
          <button
            key={p.id}
            onClick={() => onPlayer(p)}
            style={{
              display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
              background: "none", border: "none", cursor: "pointer", padding: "11px 14px",
              borderBottom: i < players.length - 1 ? "1px solid rgba(245,242,232,0.08)" : "none",
            }}
          >
            <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 14, color: C.ball, width: 30, textAlign: "right", flexShrink: 0 }}>{p.rank}</span>
            <span style={{ flex: 1, color: C.line, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: C.mute, flexShrink: 0 }}>{record(p.name)}</span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: C.mute, flexShrink: 0 }}>›</span>
          </button>
        ))}
      </div>
    </div>
  );
}
