import React, { useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";
import {
  fetchLegacyLogs, fetchAllPlayerNames, buildLiveLogs, mergeLogs,
  PlayerReportView, StatsTab, ChallengeOddsBlock, OddsExplainer,
} from "./stats.jsx";

// ================================================================
// FXBG SINGLES LADDER — the ladder itself (system of record)
// Companion app to Rally Report. Same court, same colors.
// ================================================================tyler

// ---- CONFIG (pencil-edit these, or set env vars in Vercel) ----
const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || "PASTE_YOUR_SUPABASE_URL_HERE";
const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY || "PASTE_YOUR_SUPABASE_ANON_KEY_HERE";
// Same published Google Sheet Rally Report uses (roster import):
// Donations: Tyler's Venmo. Profile link opens the Venmo app on phones.
const VENMO_USER = "Tyler-Selwyn";
const VENMO_URL = `https://venmo.com/u/${VENMO_USER}`;
const ROSTER_CSV_URL =
  "https://docs.google.com/spreadsheets/d/17-va7j5PGp2DUY4ugL0sWa3Dh6UbId1wNYrS8m4qc_Y/pub?gid=0&single=true&output=csv";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- DESIGN TOKENS (Rally Report family) ----
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

// ---- ROSTER SHEET PARSER (ported from Rally Report) ----
function splitCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function parseSheet(text) {
  const allLines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const looksLikeHeader = (cells) => {
    const low = cells.map((c) => c.toLowerCase());
    const has = (n) => low.some((h) => h.includes(n));
    return (has("last") || has("name")) && (has("email") || has("phone") || has("first"));
  };
  let headerIdx = 0;
  for (let i = 0; i < Math.min(allLines.length, 6); i++) {
    if (looksLikeHeader(splitCsvLine(allLines[i]))) { headerIdx = i; break; }
  }
  const lines = allLines.slice(headerIdx);
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const col = (...names) => {
    for (const n of names) {
      const idx = header.findIndex((h) => h.includes(n));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const iLast = col("last");
  const iFirst = col("first");
  const iName = col("name");
  const iEmail = col("email", "e-mail");
  const iPhone = col("phone", "cell", "mobile", "number");
  const iNotes = col("note", "status", "drop");
  const rows = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = splitCsvLine(lines[r]);
    const get = (i) => (i >= 0 && i < cells.length ? cells[i] : "");
    let name = "";
    if (iFirst >= 0 && iLast >= 0) name = `${get(iFirst)} ${get(iLast)}`.trim();
    else if (iName >= 0) name = get(iName);
    if (!name) continue;
    const notes = get(iNotes).toLowerCase();
    if (notes.includes("dropped")) continue;
    rows.push({ name, email: get(iEmail).toLowerCase(), phone: get(iPhone) });
  }
  return rows;
}

// ---- SMALL HELPERS ----
const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const daysLeft = (d) => Math.max(0, Math.ceil((new Date(d) - Date.now()) / 86400000));
const hoursLeft = (d) => Math.max(0, Math.ceil((new Date(d) - Date.now()) / 3600000));

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

function notify(type, challengeId, extra) {
  // fire-and-forget; email failures never block the app
  fetch("/api/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, challengeId, ...(extra || {}) }),
  }).catch(() => {});
}

// ---- SHARED UI ----
function Eyebrow({ children }) {
  return (
    <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: C.mute, marginBottom: 10, fontFamily: MONO }}>
      {children}
    </div>
  );
}

function Card({ children, style }) {
  return (
    <div style={{ background: "rgba(15,46,37,0.6)", border: `1px solid ${C.faint}`, borderRadius: 4, padding: 16, ...style }}>
      {children}
    </div>
  );
}

function Btn({ children, onClick, kind = "primary", disabled, small }) {
  const base = {
    fontFamily: MONO, fontWeight: 700, borderRadius: 4, cursor: disabled ? "default" : "pointer",
    fontSize: small ? 12 : 14, padding: small ? "6px 12px" : "12px 18px",
    border: "2px solid transparent", opacity: disabled ? 0.4 : 1, letterSpacing: 0.5,
  };
  const kinds = {
    primary: { background: C.ball, color: C.clay },
    ghost: { background: "transparent", color: C.line, border: `2px solid ${C.faint}` },
    danger: { background: "transparent", color: C.red, border: `2px solid rgba(232,96,76,0.4)` },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{ ...base, ...kinds[kind] }}>
      {children}
    </button>
  );
}

function Field({ label, value, onChange, type = "text", placeholder }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: C.mute, fontFamily: MONO, marginBottom: 6 }}>{label}</div>
      <input
        type={type} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", boxSizing: "border-box", background: C.clay, border: `1px solid ${C.faint}`, borderRadius: 4, color: C.line, padding: "12px 12px", fontSize: 16, fontFamily: "inherit" }}
      />
    </label>
  );
}

function SelectField({ label, value, onChange, options, placeholder }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: C.mute, fontFamily: MONO, marginBottom: 6 }}>{label}</div>
      <select
        value={value} onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", boxSizing: "border-box", background: C.clay, border: `1px solid ${C.faint}`, borderRadius: 4, color: C.line, padding: "12px 12px", fontSize: 16, fontFamily: "inherit" }}
      >
        <option value="">{placeholder || "Select…"}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function Toast({ msg, isError }) {
  if (!msg) return null;
  return (
    <div style={{ position: "fixed", bottom: 76, left: "50%", transform: "translateX(-50%)", background: isError ? C.red : C.ball, color: C.clay, fontFamily: MONO, fontWeight: 700, fontSize: 13, padding: "10px 18px", borderRadius: 4, zIndex: 60, maxWidth: "92vw", textAlign: "center" }}>
      {msg}
    </div>
  );
}

function Sheet({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 50, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.court, borderTop: `2px solid ${C.ball}`, borderRadius: "12px 12px 0 0", width: "100%", maxWidth: 560, maxHeight: "85vh", overflowY: "auto", padding: "20px 18px 32px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 16, color: C.line, textTransform: "uppercase", letterSpacing: 1 }}>{title}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.mute, fontSize: 22, cursor: "pointer", padding: 4 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---- LADDER ROW ----
function Movement({ n }) {
  if (!n) return <span style={{ color: C.mute, fontFamily: MONO, fontSize: 12 }}>–</span>;
  const up = n > 0;
  return (
    <span style={{ color: up ? C.ball : C.red, fontFamily: MONO, fontSize: 12, fontWeight: 700 }}>
      {up ? "▲" : "▼"}{Math.abs(n)}
    </span>
  );
}

function LadderRow({ p, meP, canChallenge, blockReason, openCh, onTap, onChallenge, onBlocked, act }) {
  const isMe = meP && p.id === meP.id;
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  return (
    <div
      onClick={onTap}
      style={{
        display: "flex", alignItems: "center", gap: 10, padding: "12px 12px",
        borderBottom: `1px solid ${C.faint}`, cursor: "pointer",
        background: isMe ? "rgba(216,245,41,0.07)" : "transparent",
        borderLeft: isMe ? `3px solid ${C.ball}` : "3px solid transparent",
      }}
    >
      <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 18, color: C.ball, width: 34, textAlign: "right" }}>{p.rank}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: C.line, fontSize: 15, fontWeight: isMe ? 700 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {p.name}{isMe ? " (you)" : ""}
        </div>
        <div style={{ fontSize: 11, color: C.mute, fontFamily: MONO, marginTop: 2 }}>
          {p.wins}–{p.losses}
          {p.streak !== 0 && (
            <span style={{ marginLeft: 8, color: p.streak > 0 ? C.ball : C.red }}>
              {p.streak > 0 ? "W" : "L"}{Math.abs(p.streak)}{p.streak >= 3 ? " 🔥" : ""}
            </span>
          )}
        </div>
      </div>
      <div style={{ width: 36, textAlign: "center" }}><Movement n={p.rank_change} /></div>
      {openCh && openCh.ch.status === "pending" && openCh.iAmOpponent && (
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={stop(() => act("accept", openCh.ch))}
            style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, background: C.ball, color: C.clay, border: "none", borderRadius: 3, padding: "6px 10px", cursor: "pointer" }}>
            ACCEPT
          </button>
          <button onClick={stop(() => act("decline", openCh.ch))}
            style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, background: "transparent", color: C.red, border: `1px solid rgba(232,96,76,0.5)`, borderRadius: 3, padding: "6px 8px", cursor: "pointer" }}>
            ✕
          </button>
        </div>
      )}
      {openCh && openCh.ch.status === "pending" && !openCh.iAmOpponent && (
        <button onClick={stop(() => act("cancel", openCh.ch))}
          style={{ fontFamily: MONO, fontSize: 10, background: "transparent", color: C.mute, border: `1px solid ${C.faint}`, borderRadius: 3, padding: "5px 8px", cursor: "pointer" }}>
          WITHDRAW
        </button>
      )}
      {openCh && openCh.ch.status === "accepted" && (
        <button onClick={stop(() => act("report", openCh.ch))}
          style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, background: C.ball, color: C.clay, border: "none", borderRadius: 3, padding: "6px 12px", cursor: "pointer" }}>
          SCORE
        </button>
      )}
      {openCh && openCh.ch.status === "reported" && (
        <div style={{ fontFamily: MONO, fontSize: 10, color: C.clay, background: C.ball, borderRadius: 3, padding: "3px 6px", fontWeight: 700 }}>VS</div>
      )}
      {canChallenge && !openCh && (
        <button onClick={stop(onChallenge)}
          style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, background: "transparent", color: C.ball, border: `1px solid rgba(216,245,41,0.4)`, borderRadius: 3, padding: "6px 10px", cursor: "pointer" }}>
          CHALLENGE
        </button>
      )}
      {!canChallenge && !openCh && blockReason && (() => {
        // A wildcard between these two isn't a fault state — it's an admin-made
        // match in progress — so it gets the ball-yellow treatment, not the red one.
        const wc = blockReason === "WILDCARD";
        return (
          <button onClick={stop(onBlocked)}
            style={{ fontFamily: MONO, fontSize: 10, background: "transparent",
              color: wc ? C.ball : C.red,
              border: `1px solid ${wc ? "rgba(216,245,41,0.4)" : "rgba(232,96,76,0.5)"}`,
              borderRadius: 3, padding: "6px 8px", cursor: "pointer" }}>
            {wc ? "WILDCARD" : "INELIGIBLE"}
          </button>
        );
      })()}
    </div>
  );
}

// ---- CHALLENGE CARD (Matches tab) ----
function ChallengeCard({ ch, meP, byId, act, logsByName, nPlayers }) {
  const opp = byId[ch.challenger_id === meP?.id ? ch.opponent_id : ch.challenger_id];
  const iAmChallenger = meP && ch.challenger_id === meP.id;
  const iAmOpponent = meP && ch.opponent_id === meP.id;
  if (!opp) return null;
  const wc = !!ch.is_wildcard;
  const label =
    ch.status === "pending" ? (iAmChallenger ? "Waiting on them to accept" : "They challenged you") :
    ch.status === "accepted" ? (wc ? "Wildcard match on — play + report" : "Match on — play + report") :
    ch.status === "reported" ? "Score recorded" : ch.status;
  return (
    <Card style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ color: C.line, fontWeight: 700, fontSize: 15 }}>
          {iAmChallenger ? "You" : opp.name} <span style={{ color: C.mute, fontWeight: 400 }}>vs</span> {iAmChallenger ? opp.name : "you"}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {wc && (
            <div style={{ fontFamily: MONO, fontSize: 10, color: C.ball, border: `1px solid rgba(216,245,41,0.4)`, borderRadius: 3, padding: "2px 7px" }}>
              WILDCARD
            </div>
          )}
          <div style={{ fontFamily: MONO, fontSize: 11, color: C.mute }}>#{opp.rank}</div>
        </div>
      </div>
      <div style={{ fontSize: 12, color: C.mute, marginTop: 4 }}>{label}</div>
      {["pending", "accepted"].includes(ch.status) && (
        <ChallengeOddsBlock
          pA={byId[ch.challenger_id]} pB={byId[ch.opponent_id]}
          logsByName={logsByName} ladderSize={nPlayers}
        />
      )}
      <div style={{ fontFamily: MONO, fontSize: 11, color: C.mute, marginTop: 4 }}>
        {ch.status === "pending" && <>accept within {daysLeft(ch.accept_by)}d ({fmtDate(ch.accept_by)})</>}
        {ch.status === "accepted" && <>play by {fmtDate(ch.play_by)} ({daysLeft(ch.play_by)}d left)</>}
        {ch.status === "reported" && <>score: {ch.score}</>}
      </div>
      {wc && ch.status === "accepted" && (
        <div style={{ fontSize: 11, color: C.mute, marginTop: 4 }}>
          Set up by an admin — outside the normal challenge range. Winner takes the loser's spot.
        </div>
      )}
      {ch.status === "accepted" && (opp.email || opp.phone) && (
        <div style={{ fontSize: 12, color: C.line, marginTop: 8, fontFamily: MONO }}>
          {opp.phone && <div>📞 <a href={`tel:${opp.phone}`} style={{ color: C.ball }}>{opp.phone}</a></div>}
          {opp.email && <div>✉️ <a href={`mailto:${opp.email}`} style={{ color: C.ball }}>{opp.email}</a></div>}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        {ch.status === "pending" && iAmOpponent && (
          <>
            <Btn small onClick={() => act("accept", ch)}>Accept</Btn>
            <Btn small kind="danger" onClick={() => act("decline", ch)}>Decline</Btn>
          </>
        )}
        {ch.status === "pending" && iAmChallenger && (
          <Btn small kind="ghost" onClick={() => act("cancel", ch)}>Cancel challenge</Btn>
        )}
        {ch.status === "accepted" && (
          <>
            <Btn small onClick={() => act("report", ch)}>Report score</Btn>
            {iAmChallenger && (
              <Btn small kind="ghost" onClick={() => act("cancel", ch)}>Withdraw</Btn>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

// ---- TOURNAMENT ----
// Data lives in the tournaments + tournament_matches tables (see
// supabase/migrations/2026-10-02-tournaments.sql). Before the bracket locks,
// the tab shows a projection from the live ladder; after the cutoff it shows
// the seeds saved at the cutoff. Tournament results never move ladder ranks.
// Bracket order, top half first: 1v8 + 4v5 meet in one semi, 2v7 + 3v6 in the other.
const TOURNEY_QF = [[1, 8], [4, 5], [2, 7], [3, 6]];
const TOURNEY_ROUND_NAMES = ["Quarterfinal", "Semifinal", "Final"];
const TOURNEY_FORMAT =
  "Best 2 of 3 full sets, with a normal tiebreak at 6-6 in every set. No 10-point tiebreak in place of a third set.";

const fmtET = (d, opts) => new Date(d).toLocaleString("en-US", { timeZone: "America/New_York", ...opts });
const etDay = (d) => fmtET(d, { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
const etYmd = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
// 11:59 PM ET on a YYYY-MM-DD date. ET is -04:00 or -05:00 depending on DST.
function etEndOfDay(ymd) {
  for (const off of ["-04:00", "-05:00"]) {
    const d = new Date(`${ymd}T23:59:00${off}`);
    if (fmtET(d, { hour: "numeric", hour12: false }) === "23") return d;
  }
  return new Date(`${ymd}T23:59:00-05:00`);
}

function notifyTourney(type, body) {
  // fire-and-forget; email failures never block the bracket
  fetch("/api/tourney", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ...body }),
  }).catch(() => {});
}

function Countdown({ to }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = to - now;
  if (ms <= 0) {
    return (
      <div style={{ fontFamily: MONO, fontSize: 13, color: C.ball, fontWeight: 700 }}>
        Cutoff passed — bracket is being locked
      </div>
    );
  }
  const s = Math.floor(ms / 1000);
  const parts = [
    [Math.floor(s / 86400), "days"],
    [Math.floor((s % 86400) / 3600), "hrs"],
    [Math.floor((s % 3600) / 60), "min"],
    [s % 60, "sec"],
  ];
  return (
    <div style={{ display: "flex", gap: 8 }}>
      {parts.map(([n, unit]) => (
        <div key={unit} style={{ flex: 1, textAlign: "center", background: C.clay, border: `1px solid ${C.faint}`, borderRadius: 4, padding: "8px 4px" }}>
          <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 700, color: C.ball, lineHeight: 1.1 }}>
            {String(n).padStart(2, "0")}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 2, color: C.mute, textTransform: "uppercase", marginTop: 2 }}>{unit}</div>
        </div>
      ))}
    </div>
  );
}

// won: true = this player won the match, false = lost, undefined = no result yet
function BracketSlot({ seed, p, meP, onPlayer, last, won }) {
  const isMe = meP && p && p.id === meP.id;
  return (
    <div
      onClick={p && p.rank ? () => onPlayer(p) : undefined}
      style={{
        display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
        borderBottom: last ? "none" : `1px solid ${C.faint}`,
        cursor: p && p.rank ? "pointer" : "default",
        background: isMe ? "rgba(216,245,41,0.07)" : "transparent",
        borderLeft: isMe ? `3px solid ${C.ball}` : "3px solid transparent",
      }}
    >
      <div style={{ fontFamily: MONO, fontSize: 10, color: C.mute, width: 18, textAlign: "right" }}>{seed || ""}</div>
      <div style={{
        flex: 1, minWidth: 0, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        color: !p ? C.mute : won === true ? C.ball : won === false ? C.mute : C.line,
        fontWeight: won === true || isMe ? 700 : 400,
      }}>
        {p ? `${p.name}${isMe ? " (you)" : ""}` : "TBD"}
      </div>
      {won === true && <div style={{ fontFamily: MONO, fontSize: 12, color: C.ball }}>✓</div>}
      {p && p.rank && p.active !== false && won === undefined && <div style={{ fontFamily: MONO, fontSize: 11, color: C.mute }}>#{p.rank}</div>}
    </div>
  );
}

function TournamentTab({ players, dropped, allNames, meP, onPlayer, tournaments, matches, say, reload }) {
  const isAdmin = !!meP?.is_admin;
  const visible = tournaments.filter((t) => isAdmin || !t.is_test);
  const [selId, setSelId] = useState(null);
  const [reporting, setReporting] = useState(null); // match being scored by a player
  const [managing, setManaging] = useState(null);   // match open in the admin sheet
  const [busy, setBusy] = useState(false);
  const t = visible.find((x) => x.id === selId) || visible.find((x) => !x.is_test) || visible[0];

  // Wraps every RPC: one at a time, toast on error, reload after.
  async function run(fn) {
    if (busy) return false;
    setBusy(true);
    try { await fn(); await reload(); return true; }
    catch (e) { say(e.message, true); return false; }
    finally { setBusy(false); }
  }

  async function createTest() {
    let id;
    const ok = await run(async () => { id = await rpc("admin_tourney_create_test"); });
    if (ok) { setSelId(id); say("Test tournament created. Only admins can see it."); }
  }

  if (!t) {
    return (
      <>
        <Eyebrow>Tournament</Eyebrow>
        <Card><div style={{ color: C.mute, fontSize: 14 }}>No tournament scheduled right now.</div></Card>
        {isAdmin && <div style={{ marginTop: 12 }}><Btn small kind="ghost" onClick={createTest}>New test tournament</Btn></div>}
      </>
    );
  }

  const tm = matches.filter((m) => m.tournament_id === t.id);
  const at = (r, s) => tm.find((m) => m.round === r && m.slot === s);
  const rounds = t.rounds || [];
  const pastCutoff = Date.now() >= new Date(t.cutoff_at).getTime();
  const draft = t.status === "draft";

  // Any player id -> something BracketSlot can show. Players off the ladder
  // still show by name; they just can't be tapped for a report.
  const everyone = [...players, ...dropped];
  const lookup = (id, fallbackName) => {
    if (!id) return null;
    return everyone.find((p) => p.id === id) ||
      { id, name: allNames?.get(id) || fallbackName || "Unknown" };
  };
  const seedOf = new Map();
  for (const m of tm.filter((x) => x.round === 1)) {
    if (m.player_a) seedOf.set(m.player_a, m.seed_a);
    if (m.player_b) seedOf.set(m.player_b, m.seed_b);
  }

  // Seeds while in draft: the cutoff snapshot once it exists, otherwise the live ladder.
  const ranked = [...players].sort((a, b) => a.rank - b.rank);
  const seedList = draft && pastCutoff && t.seeds_snapshot
    ? t.seeds_snapshot.map((s) => ({ ...lookup(s.id, s.name), rank: s.rank }))
    : ranked.slice(0, t.size + 2);
  const seeds = seedList.slice(0, t.size);
  const bubble = seedList.slice(t.size, t.size + 2);

  const roundHead = (i) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "18px 0 10px" }}>
      <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", color: C.mute, fontFamily: MONO }}>
        {rounds[i]?.name || `${TOURNEY_ROUND_NAMES[i]}s`}
      </div>
      {rounds[i] && (
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.mute }}>
          {fmtET(rounds[i].starts, { month: "short", day: "numeric" })}–{fmtET(rounds[i].ends, { month: "short", day: "numeric" })}
        </div>
      )}
    </div>
  );

  const isOpen = (m) => m && m.player_a && m.player_b && !m.winner_id;
  const inMatch = (m) => meP && m && (m.player_a === meP.id || m.player_b === meP.id);
  const myMatch = t.status === "locked" ? tm.find((m) => isOpen(m) && inMatch(m)) : null;

  function matchStatus(m) {
    if (m.winner_id) {
      if (m.result_type === "walkover") return { text: "Walkover", col: C.mute };
      return { text: m.score && m.score !== "n/a" ? m.score : "Final", col: C.line };
    }
    if (m.player_a && m.player_b && m.play_by) {
      const left = new Date(m.play_by) - Date.now();
      if (left <= 0) return { text: `Past deadline (${etDay(m.play_by)}) · admin deciding`, col: C.red };
      return { text: `Play by ${etDay(m.play_by)} · ${daysLeft(m.play_by)}d left`, col: C.mute };
    }
    return { text: "Waiting on the earlier round", col: C.mute };
  }

  const MatchCard = ({ m, gapAfter }) => {
    const st = matchStatus(m);
    const won = (id) => (m.winner_id ? m.winner_id === id : undefined);
    return (
      <Card style={{ padding: 0, marginBottom: gapAfter ? 16 : 8 }}>
        <BracketSlot seed={seedOf.get(m.player_a)} p={lookup(m.player_a)} meP={meP} onPlayer={onPlayer} won={m.player_a ? won(m.player_a) : undefined} />
        <BracketSlot seed={seedOf.get(m.player_b)} p={lookup(m.player_b)} meP={meP} onPlayer={onPlayer} won={m.player_b ? won(m.player_b) : undefined} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px" }}>
          <div style={{ flex: 1, fontFamily: MONO, fontSize: 11, color: st.col }}>{st.text}</div>
          {t.status === "locked" && isOpen(m) && inMatch(m) && (
            <Btn small onClick={() => setReporting(m)}>Report score</Btn>
          )}
          {isAdmin && t.status !== "draft" && (
            <Btn small kind="ghost" onClick={() => setManaging(m)}>Manage</Btn>
          )}
        </div>
      </Card>
    );
  };

  const placeholder = (a, b, key) => (
    <Card key={key} style={{ padding: "10px 14px", marginBottom: 8 }}>
      <div style={{ fontFamily: MONO, fontSize: 12, color: C.mute }}>
        {a} <span style={{ color: C.faint }}>vs</span> {b}
      </div>
    </Card>
  );

  const champ = t.champion_id ? lookup(t.champion_id) : null;

  return (
    <>
      {isAdmin && visible.length > 1 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {visible.map((x) => (
            <button key={x.id} onClick={() => setSelId(x.id)}
              style={{ fontFamily: MONO, fontSize: 11, borderRadius: 3, padding: "5px 9px", cursor: "pointer",
                background: x.id === t.id ? C.ball : "transparent", color: x.id === t.id ? C.clay : C.mute,
                border: `1px solid ${x.id === t.id ? C.ball : C.faint}` }}>
              {x.is_test ? `TEST · ${fmtET(x.created_at, { month: "short", day: "numeric" })}` : x.name}
            </button>
          ))}
        </div>
      )}

      {isAdmin && (
        <TourneyAdminCard t={t} tm={tm} pastCutoff={pastCutoff} run={run} say={say}
          onCreateTest={createTest} onDeleted={() => setSelId(null)} />
      )}

      <Eyebrow>{t.is_test ? "Test tournament" : t.name}</Eyebrow>

      {draft && (
        <Card style={{ marginBottom: 6, border: `1px solid ${C.ball}` }}>
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 2, color: C.ball, textTransform: "uppercase", marginBottom: 10 }}>
            {pastCutoff ? "Final seeding — bracket locks soon" : `Projected — bracket locks ${etDay(t.cutoff_at)}`}
          </div>
          <Countdown to={new Date(t.cutoff_at)} />
          <div style={{ fontSize: 12, color: C.mute, marginTop: 10, lineHeight: 1.5 }}>
            Top {t.size} on the ladder at {fmtET(t.cutoff_at, { hour: "numeric", minute: "2-digit" })} ET {etDay(t.cutoff_at)} qualify.
            Scores reported after that don't count toward seeding. {TOURNEY_FORMAT} Tournament results don't move ladder ranks.
          </div>
        </Card>
      )}

      {!draft && champ && (
        <Card style={{ marginBottom: 12, border: `1px solid ${C.ball}`, textAlign: "center" }}>
          <div style={{ fontSize: 30 }}>🏆</div>
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 2, color: C.ball, textTransform: "uppercase", marginTop: 4 }}>Champion</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: C.line, marginTop: 4 }}>{champ.name}</div>
        </Card>
      )}

      {!draft && !champ && (
        <Card style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: C.line, lineHeight: 1.55 }}>{TOURNEY_FORMAT}</div>
          <div style={{ fontSize: 12, color: C.mute, marginTop: 6, lineHeight: 1.5 }}>
            Either player reports the score. Can't get your match played by the deadline? Contact an admin.
            Tournament results don't move ladder ranks.
          </div>
        </Card>
      )}

      {myMatch && (() => {
        const opp = lookup(myMatch.player_a === meP.id ? myMatch.player_b : myMatch.player_a);
        const late = new Date(myMatch.play_by) <= Date.now();
        return (
          <Card style={{ marginBottom: 12, border: `1px solid ${C.ball}` }}>
            <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 2, color: C.ball, textTransform: "uppercase", marginBottom: 6 }}>
              Your {TOURNEY_ROUND_NAMES[myMatch.round - 1]?.toLowerCase()}
            </div>
            <div style={{ color: C.line, fontWeight: 700, fontSize: 15 }}>
              You <span style={{ color: C.mute, fontWeight: 400 }}>vs</span> {opp?.name}
              {seedOf.get(opp?.id) ? <span style={{ color: C.mute, fontWeight: 400 }}> ({seedOf.get(opp.id)} seed)</span> : null}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 11, color: late ? C.red : C.mute, marginTop: 4 }}>
              {late ? `Past deadline (${etDay(myMatch.play_by)}). Contact an admin.` : `Play by ${etDay(myMatch.play_by)} (${daysLeft(myMatch.play_by)}d left)`}
            </div>
            {(opp?.phone || opp?.email) && (
              <div style={{ fontSize: 12, color: C.line, marginTop: 8, fontFamily: MONO }}>
                {opp.phone && <div>📞 <a href={`tel:${opp.phone}`} style={{ color: C.ball }}>{opp.phone}</a></div>}
                {opp.email && <div>✉️ <a href={`mailto:${opp.email}`} style={{ color: C.ball }}>{opp.email}</a></div>}
              </div>
            )}
            <div style={{ marginTop: 12 }}><Btn small onClick={() => setReporting(myMatch)}>Report score</Btn></div>
          </Card>
        );
      })()}

      {roundHead(0)}
      {draft
        ? TOURNEY_QF.map(([hi, lo], i) => (
            <Card key={hi} style={{ padding: 0, marginBottom: i === 1 ? 16 : 8 }}>
              <BracketSlot seed={hi} p={seeds[hi - 1]} meP={meP} onPlayer={onPlayer} />
              <BracketSlot seed={lo} p={seeds[lo - 1]} meP={meP} onPlayer={onPlayer} last />
            </Card>
          ))
        : [1, 2, 3, 4].map((s) => at(1, s) && <MatchCard key={s} m={at(1, s)} gapAfter={s === 2} />)}

      {roundHead(1)}
      {draft
        ? [placeholder("Winner 1v8", "Winner 4v5", "sf1"), placeholder("Winner 2v7", "Winner 3v6", "sf2")]
        : [1, 2].map((s) => at(2, s) && <MatchCard key={s} m={at(2, s)} />)}

      {roundHead(2)}
      {draft
        ? placeholder("Winner SF1", "Winner SF2", "f")
        : at(3, 1) && <MatchCard m={at(3, 1)} />}

      {draft && bubble.length > 0 && (
        <>
          <div style={{ marginTop: 18 }}><Eyebrow>On the bubble</Eyebrow></div>
          <Card style={{ padding: 0 }}>
            {bubble.map((p, i) => {
              const out = i + 1; // spots below the last qualifying spot (9th = 1, 10th = 2)
              const isMe = meP && p.id === meP.id;
              return (
                <div
                  key={p.id}
                  onClick={p.rank ? () => onPlayer(p) : undefined}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "12px 12px",
                    borderBottom: i === bubble.length - 1 ? "none" : `1px solid ${C.faint}`, cursor: "pointer",
                    background: isMe ? "rgba(216,245,41,0.07)" : "transparent",
                    borderLeft: isMe ? `3px solid ${C.ball}` : "3px solid transparent",
                  }}
                >
                  <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 18, color: C.ball, width: 34, textAlign: "right" }}>{p.rank}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: C.line, fontSize: 15, fontWeight: isMe ? 700 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {p.name}{isMe ? " (you)" : ""}
                    </div>
                    <div style={{ fontSize: 11, color: C.mute, fontFamily: MONO, marginTop: 2 }}>
                      {out} spot{out === 1 ? "" : "s"} from qualifying
                    </div>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 10, color: C.ball, border: `1px solid rgba(216,245,41,0.4)`, borderRadius: 3, padding: "2px 7px" }}>
                    ON THE BUBBLE
                  </div>
                </div>
              );
            })}
          </Card>
        </>
      )}

      <TourneyReportSheet m={reporting} lookup={lookup} busy={busy} onClose={() => setReporting(null)}
        onSubmit={async (winnerId, score) => {
          const m = reporting;
          const ok = await run(() => rpc("tourney_report_score", { p_match: m.id, p_winner: winnerId, p_score: score }));
          if (ok) { notifyTourney("result", { matchId: m.id }); say("Score recorded — bracket updated"); setReporting(null); }
        }} />

      {isAdmin && (
        <TourneyManageSheet m={managing && tm.find((x) => x.id === managing.id)} t={t} lookup={lookup}
          everyone={everyone} players={players} dropped={dropped} run={run} say={say} busy={busy}
          onClose={() => setManaging(null)} />
      )}
    </>
  );
}

function TourneyAdminCard({ t, tm, pastCutoff, run, say, onCreateTest, onDeleted }) {
  const hasResults = tm.some((m) => m.winner_id);
  const canLock = t.status === "draft" && (pastCutoff || t.is_test);

  async function lock() {
    if (!confirm(`Lock the bracket for ${t.is_test ? "this TEST tournament" : t.name}?\n\nSeeds come from the ladder at the cutoff. ${t.is_test ? "One sample congrats email goes to the admins." : "The 8 qualifiers get their congrats email right away."}`)) return;
    const ok = await run(() => rpc("admin_tourney_lock", { p_id: t.id }));
    if (ok) { notifyTourney("qualified", { tournamentId: t.id }); say("Bracket locked — congrats emails on the way"); }
  }
  async function unlock() {
    if (!confirm("Unlock the bracket and go back to the projected view? The matchups are removed (they'll be rebuilt from the same seeds when you lock again).")) return;
    if (await run(() => rpc("admin_tourney_unlock", { p_id: t.id }))) say("Bracket unlocked");
  }
  async function resendQualified() {
    notifyTourney("qualified", { tournamentId: t.id });
    say("Sending the congrats emails");
  }
  async function deleteTest() {
    if (!confirm("Delete this test tournament and all its matches?")) return;
    if (await run(() => rpc("admin_tourney_delete_test", { p_id: t.id }))) { onDeleted(); say("Test tournament deleted"); }
  }

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 2, color: C.ball, textTransform: "uppercase", marginBottom: 6 }}>
        Admin{t.is_test ? " · test" : ""}
      </div>
      <div style={{ fontSize: 12, color: C.mute, fontFamily: MONO, lineHeight: 1.6, marginBottom: 10 }}>
        Status: {t.status === "draft" ? "not locked" : t.status === "locked" ? "bracket locked" : "complete"}
        <br />Cutoff: {etDay(t.cutoff_at)} {fmtET(t.cutoff_at, { hour: "numeric", minute: "2-digit" })} ET
        {t.seeds_snapshot && t.snapshot_at && <><br />Seeds saved {etDay(t.snapshot_at)} {fmtET(t.snapshot_at, { hour: "numeric", minute: "2-digit" })} ET</>}
        {t.is_test && <><br />Only admins see test tournaments. All their emails go to admins.</>}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {t.status === "draft" && <Btn small onClick={lock} disabled={!canLock}>Lock bracket</Btn>}
        {t.status === "locked" && !t.qualified_emailed_at && <Btn small onClick={resendQualified}>Send congrats emails</Btn>}
        {t.status === "locked" && !hasResults && <Btn small kind="ghost" onClick={unlock}>Unlock</Btn>}
        {t.is_test
          ? <Btn small kind="danger" onClick={deleteTest}>Delete test</Btn>
          : <Btn small kind="ghost" onClick={onCreateTest}>New test tournament</Btn>}
      </div>
      {t.status === "draft" && !canLock && (
        <div style={{ fontSize: 11, color: C.mute, marginTop: 8 }}>Lock opens after the cutoff.</div>
      )}
      {t.status !== "draft" && (
        <div style={{ fontSize: 11, color: C.mute, marginTop: 8, lineHeight: 1.5 }}>
          Tap <b>Manage</b> on any match to enter or change a score, record a walkover, extend the deadline, or swap a player.
        </div>
      )}
    </Card>
  );
}

function TourneyReportSheet({ m, lookup, busy, onClose, onSubmit }) {
  const [winnerId, setWinnerId] = useState(null);
  const [score, setScore] = useState("");
  useEffect(() => { setWinnerId(null); setScore(""); }, [m?.id]);
  if (!m) return null;
  const submit = () => {
    const w = lookup(winnerId)?.name || "This player";
    if (!confirm(`${w} won${score.trim() ? `, ${score.trim()}` : ""}? This is final — the bracket updates right away.`)) return;
    onSubmit(winnerId, score.trim());
  };
  return (
    <Sheet open onClose={onClose} title={`Report ${TOURNEY_ROUND_NAMES[m.round - 1]?.toLowerCase()}`}>
      <div style={{ fontSize: 12, color: C.mute, fontFamily: MONO, marginBottom: 8, textTransform: "uppercase", letterSpacing: 2 }}>Who won?</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {[m.player_a, m.player_b].map((pid) => (
          <button key={pid} onClick={() => setWinnerId(pid)}
            style={{ flex: 1, padding: "14px 8px", borderRadius: 4, cursor: "pointer", fontFamily: MONO, fontWeight: 700, fontSize: 14, background: winnerId === pid ? C.ball : "transparent", color: winnerId === pid ? C.clay : C.line, border: `2px solid ${winnerId === pid ? C.ball : C.faint}` }}>
            {lookup(pid)?.name || "?"}
          </button>
        ))}
      </div>
      <Field label="Score (winner first)" value={score} onChange={setScore} placeholder="e.g. 6-4, 3-6, 7-6" />
      <div style={{ fontSize: 12, color: C.mute, marginBottom: 14 }}>
        Either player can report. The winner moves on right away. Entered it wrong? Contact an admin.
      </div>
      <Btn onClick={submit} disabled={!winnerId || busy}>{busy ? "Saving…" : "Submit score"}</Btn>
    </Sheet>
  );
}

function TourneyManageSheet({ m, t, lookup, players, dropped, run, say, busy, onClose }) {
  const [winnerId, setWinnerId] = useState(null);
  const [score, setScore] = useState("");
  const [walkover, setWalkover] = useState(false);
  const [deadline, setDeadline] = useState("");
  const [pa, setPa] = useState("");
  const [pb, setPb] = useState("");
  useEffect(() => {
    if (!m) return;
    setWinnerId(m.winner_id); setScore(m.result_type === "walkover" ? "" : (m.score && m.score !== "n/a" ? m.score : ""));
    setWalkover(m.result_type === "walkover");
    setDeadline(m.play_by ? etYmd(m.play_by) : "");
    setPa(m.player_a || ""); setPb(m.player_b || "");
  }, [m?.id, m?.winner_id, m?.play_by, m?.player_a, m?.player_b]);
  if (!m) return null;

  const rn = TOURNEY_ROUND_NAMES[m.round - 1];
  const both = m.player_a && m.player_b;
  const options = [
    ...[...players].sort((a, b) => a.rank - b.rank).map((p) => ({ value: p.id, label: `#${p.rank} ${p.name}` })),
    ...dropped.map((p) => ({ value: p.id, label: `${p.name} (temp drop)` })),
  ];
  // Keep a player who is no longer on either list selectable, so the select shows them.
  for (const id of [m.player_a, m.player_b]) {
    if (id && !options.some((o) => o.value === id)) options.push({ value: id, label: lookup(id)?.name || "Unknown" });
  }
  const laterNote = m.round < 3 ? " If the winner already played their next match, that result is cleared too." : "";

  async function saveResult() {
    const w = lookup(winnerId)?.name;
    const msg = walkover
      ? `Record a walkover: ${w} advances?`
      : `Record: ${w} won${score.trim() ? `, ${score.trim()}` : ""}?`;
    if (!confirm(`${msg}${m.winner_id && m.winner_id !== winnerId ? laterNote : ""}`)) return;
    const ok = await run(() => rpc("admin_tourney_set_result", { p_match: m.id, p_winner: winnerId, p_score: score.trim(), p_walkover: walkover }));
    if (ok) { notifyTourney("result", { matchId: m.id }); say("Result saved"); onClose(); }
  }
  async function clearResult() {
    if (!confirm(`Clear the result of this ${rn.toLowerCase()}?${laterNote}`)) return;
    if (await run(() => rpc("admin_tourney_clear_result", { p_match: m.id }))) say("Result cleared");
  }
  async function saveDeadline() {
    if (!deadline) return;
    if (!confirm(`Set the deadline to 11:59 PM ET on ${etDay(etEndOfDay(deadline))}? Nobody is emailed. The 3-day reminder re-arms for the new date.`)) return;
    if (await run(() => rpc("admin_tourney_extend", { p_match: m.id, p_play_by: etEndOfDay(deadline).toISOString() }))) say("Deadline updated");
  }
  async function savePlayers() {
    const changes = [["a", m.player_a, pa], ["b", m.player_b, pb]].filter(([, cur, next]) => (cur || "") !== next);
    if (!changes.length) return;
    if (!confirm(`Save the new lineup for this ${rn.toLowerCase()}?${m.winner_id ? " Its result is cleared because the lineup changed." + laterNote : ""} Both players get a "your match is set" email.`)) return;
    const ok = await run(async () => {
      // Empty the changed spots first, so swapping the two players' sides works.
      for (const [spot] of changes) await rpc("admin_tourney_set_player", { p_match: m.id, p_spot: spot, p_player: null });
      for (const [spot, , next] of changes) {
        if (next) await rpc("admin_tourney_set_player", { p_match: m.id, p_spot: spot, p_player: next });
      }
    });
    if (ok) { notifyTourney("sweep", { tournamentId: t.id }); say("Lineup saved"); }
  }

  const label = { fontFamily: MONO, fontSize: 11, letterSpacing: 2, color: C.ball, textTransform: "uppercase", margin: "4px 0 10px" };
  const section = { borderTop: `1px solid ${C.faint}`, paddingTop: 14, marginTop: 16 };

  return (
    <Sheet open onClose={onClose} title={`Manage ${rn.toLowerCase()}${m.round < 3 ? ` ${m.slot}` : ""}`}>
      <div style={label}>Result</div>
      {both ? (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {[m.player_a, m.player_b].map((pid) => (
              <button key={pid} onClick={() => setWinnerId(pid)}
                style={{ flex: 1, padding: "12px 8px", borderRadius: 4, cursor: "pointer", fontFamily: MONO, fontWeight: 700, fontSize: 13, background: winnerId === pid ? C.ball : "transparent", color: winnerId === pid ? C.clay : C.line, border: `2px solid ${winnerId === pid ? C.ball : C.faint}` }}>
                {lookup(pid)?.name}
              </button>
            ))}
          </div>
          <Field label="Score (winner first)" value={score} onChange={setScore} placeholder={walkover ? "optional" : "6-4, 3-6, 7-6"} />
          <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={walkover} onChange={(e) => setWalkover(e.target.checked)} />
            <span style={{ fontSize: 13, color: C.line }}>Walkover (not played; the winner advances)</span>
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn small onClick={saveResult} disabled={!winnerId || busy}>Save result</Btn>
            {m.winner_id && <Btn small kind="danger" onClick={clearResult} disabled={busy}>Clear result</Btn>}
          </div>
        </>
      ) : (
        <div style={{ fontSize: 13, color: C.mute }}>Needs both players before a result can be entered.</div>
      )}

      <div style={section}>
        <div style={label}>Deadline</div>
        <div style={{ fontSize: 12, color: C.mute, marginBottom: 8 }}>
          Currently {m.play_by ? `${etDay(m.play_by)}, 11:59 PM ET` : "not set"}. Changing it emails nobody.
        </div>
        <Field label="New deadline (11:59 PM ET that day)" type="date" value={deadline} onChange={setDeadline} />
        <Btn small kind="ghost" onClick={saveDeadline} disabled={!deadline || busy}>Set deadline</Btn>
      </div>

      <div style={section}>
        <div style={label}>Players</div>
        <SelectField label="Top spot" value={pa} onChange={setPa} options={options.filter((o) => o.value !== pb)} placeholder="Empty (TBD)" />
        <SelectField label="Bottom spot" value={pb} onChange={setPb} options={options.filter((o) => o.value !== pa)} placeholder="Empty (TBD)" />
        <Btn small kind="ghost" onClick={savePlayers} disabled={busy || ((m.player_a || "") === pa && (m.player_b || "") === pb)}>Save lineup</Btn>
      </div>
    </Sheet>
  );
}

// ---- MAIN APP ----
function App() {
  const [session, setSession] = useState(null);
  const [players, setPlayers] = useState([]);
  const [challenges, setChallenges] = useState([]);
  const [dropped, setDropped] = useState([]);
  const [settings, setSettings] = useState(null);
  // ?tab=tournament (used by the tournament emails) opens straight to that tab.
  const [tab, setTab] = useState(() => {
    try {
      const t = new URLSearchParams(window.location.search).get("tab");
      return ["ladder", "matches", "tournament", "stats", "rules"].includes(t) ? t : "ladder";
    } catch { return "ladder"; }
  });
  const [tournaments, setTournaments] = useState([]);
  const [tMatches, setTMatches] = useState([]);
  const [legacyLogs, setLegacyLogs] = useState(null);   // frozen TennisRungs archive
  const [allNames, setAllNames] = useState(null);       // id -> name for every player row ever
  const [reportPlayer, setReportPlayer] = useState(null); // player whose report is open
  const [showInstall, setShowInstall] = useState(false);
  const [installEvt, setInstallEvt] = useState(null);

  // "Add to Home Screen" nudge: shown only in a mobile browser tab, never
  // when already installed, and stays dismissed once closed.
  useEffect(() => {
    const standalone =
      window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone;
    const dismissed = localStorage.getItem("installNudgeDismissed");
    const mobile = /iphone|ipad|ipod|android/i.test(navigator.userAgent);
    if (!standalone && !dismissed && mobile) setShowInstall(true);
    const onPrompt = (e) => { e.preventDefault(); setInstallEvt(e); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const dismissInstall = () => {
    localStorage.setItem("installNudgeDismissed", "1");
    setShowInstall(false);
  };
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);

  // If the page reloads while someone is off fetching their code (email app
  // switch on some phones), restore the "enter your code" screen instead of
  // dumping them back at the start.
  const pendingLogin = (() => { try { return localStorage.getItem("pendingLoginEmail") || ""; } catch { return ""; } })();
  const [loginEmail, setLoginEmail] = useState(pendingLogin);
  const [loginSent, setLoginSent] = useState(!!pendingLogin);
  const [loginCode, setLoginCode] = useState("");
  const [showLogin, setShowLogin] = useState(!!pendingLogin);
  const [showJoin, setShowJoin] = useState(false);
  const [joinName, setJoinName] = useState("");
  const [joinEmail, setJoinEmail] = useState("");
  const [joinPhone, setJoinPhone] = useState("");
  const [joinNote, setJoinNote] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);

  const [target, setTarget] = useState(null);      // player being challenged
  const [reporting, setReporting] = useState(null); // challenge being scored
  const [winnerId, setWinnerId] = useState(null);
  const [score, setScore] = useState("");

  const say = (msg, isError) => {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), 3500);
  };

  const [refreshing, setRefreshing] = useState(false);
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try { await loadAll(); say("Up to date"); }
    catch { say("Refresh failed — check your connection", true); }
    setRefreshing(false);
  }

  const meP = useMemo(() => {
    const email = session?.user?.email?.toLowerCase();
    if (!email) return null;
    return players.find((p) => p.email?.toLowerCase() === email) ||
      dropped.find((p) => p.email?.toLowerCase() === email) || null;
  }, [session, players, dropped]);

  const byId = useMemo(() => Object.fromEntries(players.map((p) => [p.id, p])), [players]);

  // Full career logs (live challenges + TennisRungs archive), per player name.
  const logsByName = useMemo(() => {
    if (!legacyLogs) return null; // still loading the archive
    const nameById = allNames || new Map([...players, ...dropped].map((p) => [p.id, p.name]));
    const rankByName = new Map(players.map((p) => [p.name, p.rank]));
    return mergeLogs(buildLiveLogs(challenges, nameById, rankByName), legacyLogs);
  }, [players, dropped, challenges, legacyLogs, allNames]);


  async function loadAll() {
    try { await supabase.rpc("tick"); } catch {}
    const [p, d, c, s, tt, tmm] = await Promise.all([
      supabase.from("players").select("*").eq("active", true).order("rank"),
      supabase.from("players").select("*").eq("dropped", true).order("name"),
      supabase.from("challenges").select("*").order("created_at", { ascending: false }),
      supabase.from("settings").select("*").eq("id", 1).single(),
      supabase.from("tournaments").select("*").order("created_at", { ascending: false }),
      supabase.from("tournament_matches").select("*").order("round").order("slot"),
    ]);
    if (p.data) setPlayers(p.data);
    if (d.data) setDropped(d.data);
    if (c.data) setChallenges(c.data);
    if (s.data) setSettings(s.data);
    if (tt.data) setTournaments(tt.data);
    if (tmm.data) setTMatches(tmm.data);
    setLoading(false);
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    loadAll();
    fetchLegacyLogs(supabase).then(setLegacyLogs).catch(() => setLegacyLogs(new Map()));
    fetchAllPlayerNames(supabase).then(setAllNames).catch(() => setAllNames(null));
    return () => sub.subscription.unsubscribe();
  }, []);

  const open = challenges.filter((c) => ["pending", "accepted", "reported"].includes(c.status));
  const myOpen = meP ? open.filter((c) => c.challenger_id === meP.id || c.opponent_id === meP.id) : [];
  // Sort by when the match was actually reported, not when the challenge
  // was issued — the list displays reported_at, so it must sort by it too.
  const completed = challenges
    .filter((c) => c.status === "completed")
    .sort((a, b) => new Date(b.reported_at || b.created_at) - new Date(a.reported_at || a.created_at));
  // Wildcard matches are admin-arranged and sit outside every limit:
  // they never count toward a player's active challenges, never block an
  // opponent's incoming slot, and never trip the rematch cooldown.
  const notWc = (c) => !c.is_wildcard;
  const openWith = (pid) => {
    if (!meP) return null;
    const ch = open.filter(notWc).find((c) =>
      (c.challenger_id === meP.id && c.opponent_id === pid) ||
      (c.challenger_id === pid && c.opponent_id === meP.id));
    return ch ? { ch, iAmOpponent: ch.opponent_id === meP.id } : null;
  };
  // An open wildcard between me and this player. Wildcards sit outside every
  // LIMIT (slots, incoming, cooldown) but there can still only be one live match
  // per pair, so this blocks a normal challenge until the wildcard resolves.
  const wildcardWith = (pid) => {
    if (!meP) return null;
    return open.find((c) =>
      c.is_wildcard &&
      ((c.challenger_id === meP.id && c.opponent_id === pid) ||
       (c.challenger_id === pid && c.opponent_id === meP.id))) || null;
  };
  const myActiveCount = meP ? open.filter((c) => c.challenger_id === meP.id && notWc(c)).length : 0;

  const rematchBlocked = (pid) => {
    if (!meP || !settings || !(settings.rematch_days > 0)) return false;
    const cutoff = Date.now() - settings.rematch_days * 86400000;
    return completed.some((c) =>
      notWc(c) &&
      ((c.challenger_id === meP.id && c.opponent_id === pid) ||
       (c.challenger_id === pid && c.opponent_id === meP.id)) &&
      c.reported_at && new Date(c.reported_at).getTime() > cutoff);
  };

  // A player can only be challenged by so many people at once (default 1)
  const incomingBusy = (pid) =>
    challenges.filter((c) => ["pending", "accepted"].includes(c.status) && notWc(c) &&
      c.opponent_id === pid && c.challenger_id !== (meP && meP.id)).length >=
    ((settings && settings.max_incoming_challenges) ?? 1);

  const canChallenge = (p) =>
    meP && settings && p.id !== meP.id && p.rank < meP.rank &&
    meP.rank - p.rank <= settings.challenge_range &&
    myActiveCount < settings.max_active_challenges && !openWith(p.id) &&
    !wildcardWith(p.id) && !rematchBlocked(p.id) && !incomingBusy(p.id);

  // Why can't I challenge this otherwise-in-range player? (for the red chip)
  const blockReason = (p) => {
    if (!meP || !settings || p.id === meP.id || p.rank >= meP.rank) return null;
    if (meP.rank - p.rank > settings.challenge_range) return null;
    if (openWith(p.id)) return null; // row already shows the open-challenge UI
    if (wildcardWith(p.id)) return "WILDCARD";
    if (rematchBlocked(p.id)) return "COOLDOWN";
    if (incomingBusy(p.id)) return "CHALLENGED";
    if (myActiveCount >= settings.max_active_challenges) return "AT_CAP";
    return null;
  };

  // Tapping the red INELIGIBLE chip explains why (mobile has no hover tooltips)
  const explainBlock = (p) => {
    const r = blockReason(p);
    const first = p.name.split(" ")[0];
    if (r === "WILDCARD") say(`You already have a wildcard match against ${first}. Play it and report the score — then you can challenge them normally, with no cooldown.`);
    else if (r === "COOLDOWN") say(`You played ${first} in the last ${settings.rematch_days} days — rematch cooldown. Try again soon.`, true);
    else if (r === "CHALLENGED") say(`${first} already has an incoming challenge. Try again once it's resolved.`, true);
    else if (r === "AT_CAP") say(`You're at your limit of ${settings.max_active_challenges} active challenge${settings.max_active_challenges === 1 ? "" : "s"} — play or withdraw one first.`, true);
  };

  const myDeadlines = useMemo(() => {
    if (!meP) return [];
    return myOpen
      .map((c) => {
        if (c.status === "pending" && c.opponent_id === meP.id)
          return { verb: "ACCEPT", by: c.accept_by, who: byId[c.challenger_id]?.name };
        if (c.status === "accepted")
          return { verb: "PLAY", by: c.play_by, who: byId[c.challenger_id === meP.id ? c.opponent_id : c.challenger_id]?.name };
        return null;
      })
      .filter((d) => d && d.by)
      .sort((a, b) => new Date(a.by) - new Date(b.by));
  }, [meP, myOpen, byId]);

  // My unplayed match in the live (non-test) tournament, for the ladder banner.
  const myTourneyMatch = useMemo(() => {
    if (!meP) return null;
    const live = new Set(tournaments.filter((t) => t.status === "locked" && !t.is_test).map((t) => t.id));
    return tMatches.find((m) => live.has(m.tournament_id) && m.player_a && m.player_b && !m.winner_id &&
      (m.player_a === meP.id || m.player_b === meP.id)) || null;
  }, [meP, tournaments, tMatches]);

  // Player report opens in-place over the ladder; the browser keeps the
  // page's scroll position unless we manage it. Scroll to top when a
  // report opens, and put the user back where they were on BACK.
  const savedScroll = React.useRef(0);
  useEffect(() => {
    if (reportPlayer) {
      savedScroll.current = window.scrollY;
      window.scrollTo(0, 0);
    } else {
      window.scrollTo(0, savedScroll.current);
    }
  }, [reportPlayer]);

  // Same problem on tab switches: content swaps in place, scroll persists.
  // Every tab change starts at the top.
  useEffect(() => { window.scrollTo(0, 0); }, [tab]);

  function openJoin(prefillEmail) {
    if (prefillEmail && !joinEmail) setJoinEmail(prefillEmail);
    setShowLogin(false); setLoginSent(false);
    setShowJoin(true);
  }

  async function submitJoin() {
    if (joinBusy) return;
    setJoinBusy(true);
    try {
      const r = await fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: joinName, email: joinEmail, phone: joinPhone, note: joinNote }),
      });
      const out = await r.json();
      if (out.already) {
        say("You're already on the ladder — just sign in with that email.");
        setShowJoin(false); setLoginEmail(joinEmail.trim().toLowerCase()); setShowLogin(true);
        return;
      }
      if (out.duplicate) {
        say("You've already requested to join — Matt will be in touch.");
        setShowJoin(false);
        return;
      }
      if (!r.ok || out.error) throw new Error(out.error || "Could not send your request");
      setShowJoin(false);
      setJoinName(""); setJoinEmail(""); setJoinPhone(""); setJoinNote("");
      say("Request sent — Matt will review it and email you.");
    } catch (e) { say(e.message, true); }
    finally { setJoinBusy(false); }
  }

  async function sendLogin() {
    try {
      const email = loginEmail.trim().toLowerCase();
      if (!email) throw new Error("Enter your email");
      // Only players on the ladder can sign in. Everyone else gets routed to Matt.
      const { data: match, error: lookupErr } = await supabase
        .from("players")
        .select("id,active,dropped")
        .ilike("email", email)
        .limit(1);
      if (lookupErr) throw lookupErr;
      if (!match || match.length === 0) {
        say("That email isn't on the ladder yet — request to join below.", true);
        openJoin(email);
        return;
      }
      // Removed players can't sign in. Temp drops (vacation) still can.
      if (!match[0].active && !match[0].dropped) {
        say("This account is no longer on the ladder. Contact Matt Selwyn: 540-498-0799", true);
        return;
      }
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      try { localStorage.setItem("pendingLoginEmail", email); } catch {}
      setLoginSent(true);
    } catch (e) { say(e.message, true); }
  }

  async function verifyCode() {
    try {
      const { error } = await supabase.auth.verifyOtp({
        email: loginEmail.trim(),
        token: loginCode.trim(),
        type: "email",
      });
      if (error) throw error;
      try { localStorage.removeItem("pendingLoginEmail"); } catch {}
      setShowLogin(false); setLoginSent(false); setLoginCode("");
      say("Signed in — you'll stay signed in on this device");
      loadAll();
    } catch (e) { say(e.message, true); }
  }

  function confirmSignOut() {
    if (confirm("Sign out? You'll need a new code to get back in.")) {
      supabase.auth.signOut({ scope: "local" });
    }
  }

  // In-flight guard: a double-tap used to fire two issue_challenge calls that
  // both passed the server's count check and inserted twice. The DB now has a
  // unique index as the real backstop; this just stops the second request.
  const [sending, setSending] = useState(false);
  async function doChallenge() {
    if (sending) return;
    setSending(true);
    try {
      const cid = await rpc("issue_challenge", { p_opponent: target.id });
      notify("issued", cid);
      say(`Challenge sent to ${target.name}`);
      setTarget(null);
      loadAll();
    } catch (e) { say(e.message, true); }
    finally { setSending(false); }
  }

  async function act(kind, ch) {
    try {
      if (kind === "accept") { await rpc("accept_challenge", { p_id: ch.id }); notify("accepted", ch.id); say("Challenge accepted — contact info unlocked"); }
      if (kind === "decline") { if (!confirm("Decline this challenge?")) return; await rpc("decline_challenge", { p_id: ch.id }); notify("declined", ch.id); say("Challenge declined"); }
      if (kind === "cancel") { if (!confirm("Withdraw this challenge?")) return; await rpc("cancel_challenge", { p_id: ch.id }); notify("withdrawn", ch.id); say("Challenge withdrawn"); }
      if (kind === "report") { setReporting(ch); setWinnerId(null); setScore(""); return; }
      loadAll();
    } catch (e) { say(e.message, true); }
  }

  async function submitScore() {
    try {
      if (!winnerId) throw new Error("Pick who won");
      const wName = byId[winnerId]?.name || "This player";
      if (!confirm(`${wName} won${score.trim() ? `, ${score.trim()}` : ""}? This is final — the ladder updates immediately.`)) return;
      await rpc("report_score", { p_id: reporting.id, p_winner: winnerId, p_score: score.trim() || "n/a" });
      notify("reported", reporting.id);
      say("Score recorded — ladder updated");
      setReporting(null);
      loadAll();
    } catch (e) { say(e.message, true); }
  }

  async function tempDrop() {
    if (!confirm("Temp drop off the ladder? You'll lose your spot (everyone below moves up) and you'll need to contact Matt to re-join.")) return;
    try {
      await rpc("temp_drop");
      say("You're off the ladder. Contact Matt when you're ready to come back!");
      loadAll();
    } catch (e) { say(e.message, true); }
  }

  async function editScore(ch) {
    const a = byId[ch.challenger_id]?.name || "?", b = byId[ch.opponent_id]?.name || "?";
    const cur = ch.winner_id === ch.challenger_id ? "1" : "2";
    const w = prompt(`Winner?\n1 = ${a}\n2 = ${b}`, cur);
    if (w !== "1" && w !== "2") return;
    const score = prompt("Corrected score, winner first", ch.score === "n/a" ? "" : ch.score || "");
    if (score === null) return;
    const winnerId = w === "1" ? ch.challenger_id : ch.opponent_id;
    try { await rpc("admin_edit_score", { p_id: ch.id, p_winner: winnerId, p_score: score }); say("Match updated"); loadAll(); }
    catch (e) { say(e.message, true); }
  }

  async function deleteMatch(ch) {
    const w = byId[ch.winner_id]?.name || "?";
    const l = byId[ch.winner_id === ch.challenger_id ? ch.opponent_id : ch.challenger_id]?.name || "?";
    if (!confirm(`Delete this match (${w} def. ${l}${ch.score && ch.score !== "n/a" ? ` ${ch.score}` : ""})? It disappears from history and both players' W/L records and streaks recalculate automatically. Rank changes from this match are NOT undone — use the Rank button in Admin if a rank needs fixing.`)) return;
    try { await rpc("admin_delete_match", { p_id: ch.id }); say("Match deleted — records updated"); loadAll(); }
    catch (e) { say(e.message, true); }
  }

  const tabs = [
    ["ladder", "Ladder"],
    ["matches", `Matches${myOpen.length ? ` (${myOpen.length})` : ""}`],
    ["tournament", "Tourney"],
    ["stats", "Stats"],
    ["rules", "Rules"],
    ...(meP?.is_admin ? [["admin", "Admin"]] : []),
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.court, color: C.line, fontFamily: "system-ui, -apple-system, sans-serif", paddingBottom: 70 }}>
      {showInstall && (
        <div style={{ background: C.clay, borderBottom: `1px solid ${C.faint}`, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
          <span style={{ fontSize: 18 }}>🎾</span>
          <div style={{ flex: 1, color: C.line }}>
            {installEvt ? (
              <>Get the ladder as an app on your phone.</>
            ) : /iphone|ipad|ipod/i.test(navigator.userAgent) ? (
              <>Add the ladder to your Home Screen: tap <b>Share</b> → <b>Add to Home Screen</b>.</>
            ) : (
              <>Add the ladder to your Home Screen: browser menu ⋮ → <b>Add to Home Screen</b>.</>
            )}
          </div>
          {installEvt && (
            <button
              onClick={async () => { installEvt.prompt(); await installEvt.userChoice; dismissInstall(); }}
              style={{ background: C.ball, border: "none", color: C.court, borderRadius: 4, padding: "7px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}
            >Install</button>
          )}
          <button onClick={dismissInstall} aria-label="Dismiss"
            style={{ background: "none", border: "none", color: C.mute, fontSize: 16, cursor: "pointer", flexShrink: 0, padding: 4 }}>✕</button>
        </div>
      )}
      {/* header */}
      <div style={{ padding: "22px 16px 14px", paddingTop: "calc(22px + env(safe-area-inset-top))", borderBottom: `1px solid ${C.faint}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 3, color: C.mute, textTransform: "uppercase" }}>FXBG Singles</div>
          <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 22, color: C.ball, letterSpacing: 1 }}>THE LADDER</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={refresh}
              disabled={refreshing}
              aria-label="Refresh"
              style={{ background: "none", border: `1px solid ${C.faint}`, color: refreshing ? C.faint : C.mute, borderRadius: 4, padding: "6px 9px", fontSize: 12, fontFamily: MONO, cursor: refreshing ? "default" : "pointer", lineHeight: 1 }}
            >
              {refreshing ? "…" : "↻"}
            </button>
          </div>
          {session ? (
            <button onClick={confirmSignOut} style={{ background: "none", border: `1px solid ${C.faint}`, color: C.mute, borderRadius: 4, padding: "6px 10px", fontSize: 11, fontFamily: MONO, cursor: "pointer" }}>
              LOG OUT
            </button>
          ) : (
            <Btn small onClick={() => setShowLogin(true)}>Sign in</Btn>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 560, margin: "0 auto", padding: "14px 12px" }}>
        {loading && <div style={{ color: C.mute, fontFamily: MONO, padding: 30, textAlign: "center" }}>loading…</div>}

        {/* PLAYER REPORT (opens over any tab) */}
        {!loading && reportPlayer && (
          <PlayerReportView
            player={reportPlayer}
            logsByName={logsByName}
            onBack={() => setReportPlayer(null)}
            onChallenge={canChallenge(reportPlayer) ? () => { const p = reportPlayer; setReportPlayer(null); setTarget(p); } : null}
          />
        )}

        {/* LADDER */}
        {!loading && !reportPlayer && tab === "ladder" && (
          <>
            {meP && meP.dropped && (
              <Card style={{ marginBottom: 10, border: `1px solid ${C.ball}` }}>
                <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 2, color: C.ball, textTransform: "uppercase", marginBottom: 6 }}>
                  You're on a temp drop
                </div>
                <div style={{ fontSize: 14, lineHeight: 1.5 }}>
                  Please contact your admin Matt Selwyn to re-join when you are ready to play again!
                </div>
                <div style={{ marginTop: 8, fontFamily: MONO, fontSize: 13 }}>
                  <a href="tel:5404980799" style={{ color: C.ball, textDecoration: "none" }}>540-498-0799</a>
                  {" · "}
                  <a href="mailto:mselwyn20@gmail.com" style={{ color: C.ball, textDecoration: "none" }}>mselwyn20@gmail.com</a>
                </div>
              </Card>
            )}
            {myTourneyMatch && (() => {
              const m = myTourneyMatch;
              const oppId = m.player_a === meP.id ? m.player_b : m.player_a;
              const opp = players.find((p) => p.id === oppId) || dropped.find((p) => p.id === oppId);
              const late = new Date(m.play_by) <= Date.now();
              const col = late || daysLeft(m.play_by) <= 1 ? C.red : C.ball;
              const rn = ["QF", "SF", "FINAL"][m.round - 1] || "MATCH";
              return (
                <div
                  onClick={() => setTab("tournament")}
                  style={{ display: "flex", alignItems: "center", gap: 8, border: `1px solid ${col}`, borderRadius: 8, padding: "10px 12px", marginBottom: 10, cursor: "pointer", background: "rgba(216,245,41,0.05)" }}
                >
                  <span style={{ fontSize: 14 }}>🏆</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: col, letterSpacing: 1, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    TOURNAMENT {rn} · {late ? "PAST DEADLINE" : `PLAY BY ${etDay(m.play_by).replace(/^\w+ /, "").toUpperCase()}`}{opp ? ` · VS ${opp.name.toUpperCase()}` : ""}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 12, color: col }}>→</span>
                </div>
              );
            })()}
            {meP && !meP.dropped && myDeadlines.length > 0 && (() => {
              const d = myDeadlines[0];
              const dl = daysLeft(d.by);
              const urgent = dl <= 1;
              const col = urgent ? C.red : C.ball;
              return (
                <div
                  onClick={() => setTab("matches")}
                  style={{ display: "flex", alignItems: "center", gap: 8, border: `1px solid ${col}`, borderRadius: 8, padding: "10px 12px", marginBottom: 10, cursor: "pointer", background: urgent ? "rgba(232,96,76,0.08)" : "rgba(216,245,41,0.05)" }}
                >
                  <span style={{ fontSize: 14 }}>⏱</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: col, letterSpacing: 1, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {d.verb} BY {fmtDate(d.by).toUpperCase()} · {dl}D LEFT{d.who ? ` · VS ${d.who.toUpperCase()}` : ""}
                    {myDeadlines.length > 1 ? ` · +${myDeadlines.length - 1} MORE` : ""}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 12, color: col }}>→</span>
                </div>
              );
            })()}
            {meP && !meP.dropped && settings && (
              <div style={{ fontSize: 12, color: C.mute, fontFamily: MONO, marginBottom: 10 }}>
                You're #{meP.rank}. Challenge up to {settings.challenge_range} spots up · {settings.max_active_challenges - myActiveCount} challenge{settings.max_active_challenges - myActiveCount === 1 ? "" : "s"} left
              </div>
            )}
            {!session && (
              <div style={{ border: `2px solid ${C.ball}`, borderRadius: 8, padding: 16, marginBottom: 14, background: "rgba(216,245,41,0.07)" }}>
                <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 2, color: C.ball, textTransform: "uppercase", marginBottom: 8 }}>
                  New here?
                </div>
                <div style={{ fontSize: 13, color: C.line, lineHeight: 1.5, marginBottom: 14 }}>
                  The FXBG Singles Ladder is an open rec league. Send a request and Matt
                  will add you at the bottom of the ladder.
                </div>
                <button
                  onClick={() => openJoin("")}
                  style={{ display: "block", width: "100%", background: C.ball, color: C.clay, border: "2px solid transparent", borderRadius: 4, padding: "15px 18px", fontFamily: MONO, fontWeight: 700, fontSize: 15, letterSpacing: 0.5, cursor: "pointer" }}
                >
                  REQUEST TO JOIN
                </button>
                <div style={{ fontSize: 12, color: C.mute, fontFamily: MONO, marginTop: 12, textAlign: "center" }}>
                  Already on the ladder?{" "}
                  <button onClick={() => setShowLogin(true)} style={{ background: "none", border: "none", padding: 0, color: C.ball, fontFamily: MONO, fontSize: 12, fontWeight: 700, cursor: "pointer", textDecoration: "underline" }}>
                    Sign in
                  </button>
                </div>
              </div>
            )}
            <Card style={{ padding: 0 }}>
              {players.map((p) => (
                <LadderRow
                  key={p.id} p={p} meP={meP}
                  canChallenge={canChallenge(p)}
                  blockReason={blockReason(p)}
                  openCh={openWith(p.id)}
                  onTap={() => setReportPlayer(p)}
                  onChallenge={() => setTarget(p)}
                  onBlocked={() => explainBlock(p)}
                  act={act}
                />
              ))}
              {players.length === 0 && (
                <div style={{ padding: 24, color: C.mute, fontSize: 14 }}>
                  No players yet. An admin can import the roster from the Admin tab.
                </div>
              )}
            </Card>
            {dropped.length > 0 && (
              <div style={{ marginTop: 12, padding: "10px 14px", border: `1px solid ${C.faint}`, borderRadius: 8 }}>
                <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 2, color: C.mute, textTransform: "uppercase", marginBottom: 4 }}>
                  Temp drops ({dropped.length})
                </div>
                <div style={{ fontSize: 13, color: C.mute, lineHeight: 1.6 }}>
                  {dropped.map((p) => p.name).join(" · ")}
                </div>
              </div>
            )}
            {meP && !meP.dropped && (
              <button
                onClick={tempDrop}
                style={{
                  display: "block", width: "100%", textAlign: "center", marginTop: 12,
                  padding: "13px 14px", border: `2px solid ${C.red}`, borderRadius: 8,
                  background: "transparent", cursor: "pointer",
                  fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: 1, color: C.red,
                }}
              >
                NEED A BREAK? TEMP DROP OFF THE LADDER
              </button>
            )}
          </>
        )}

        {/* MATCHES */}
        {!loading && !reportPlayer && tab === "matches" && (
          <>
            <Eyebrow>Your open matches</Eyebrow>
            {!session && <Card><div style={{ color: C.mute, fontSize: 14 }}>Sign in to see your matches.</div></Card>}
            {session && myOpen.length === 0 && (
              <Card><div style={{ color: C.mute, fontSize: 14 }}>Nothing open. Tap a player on the ladder to challenge them.</div></Card>
            )}
            {myOpen.map((ch) => (
              <ChallengeCard key={ch.id} ch={ch} meP={meP} byId={byId} act={act} logsByName={logsByName} nPlayers={players.length} />
            ))}
            {session && open.filter((c) => !myOpen.includes(c)).length > 0 && (
              <>
                <Eyebrow>Elsewhere on the ladder</Eyebrow>
                {open.filter((c) => !myOpen.includes(c)).map((ch) => {
                  const a = byId[ch.challenger_id], b = byId[ch.opponent_id];
                  if (!a || !b) return null;
                  return (
                    <div key={ch.id} style={{ padding: "8px 4px", borderBottom: `1px solid ${C.faint}` }}>
                      <div style={{ fontSize: 13, color: C.mute, fontFamily: MONO }}>
                        #{a.rank} {a.name} → #{b.rank} {b.name} · {ch.status}
                      </div>
                      {["pending", "accepted"].includes(ch.status) && (
                        <ChallengeOddsBlock pA={a} pB={b} logsByName={logsByName} ladderSize={players.length} compact />
                      )}
                    </div>
                  );
                })}
                <OddsExplainer />
              </>
            )}
          </>
        )}

        {/* STATS (leaderboards, player reports, league match history) */}
        {!loading && !reportPlayer && tab === "stats" && (
          <>
            <StatsTab players={players} logsByName={logsByName} onPlayer={setReportPlayer} />
            <Eyebrow>League match history</Eyebrow>
            {completed.length === 0 && <Card><div style={{ color: C.mute, fontSize: 14 }}>No completed matches yet.</div></Card>}
            {completed.map((ch) => {
              const w = byId[ch.winner_id];
              const l = byId[ch.winner_id === ch.challenger_id ? ch.opponent_id : ch.challenger_id];
              if (!w || !l) return null;
              return (
                <div key={ch.id} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "10px 4px", borderBottom: `1px solid ${C.faint}` }}>
                  <div style={{ fontFamily: MONO, fontSize: 11, color: C.mute, width: 52, flexShrink: 0 }}>{fmtDate(ch.reported_at || ch.created_at)}</div>
                  <div style={{ fontSize: 14, flex: 1 }}>
                    <span style={{ color: C.ball, fontWeight: 700 }}>{w.name}</span>
                    <span style={{ color: C.mute }}> def. </span>
                    <span style={{ color: C.line }}>{l.name}</span>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 12, color: C.mute }}>{ch.score}</div>
                  {meP?.is_admin && (
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button onClick={() => editScore(ch)} title="Edit score"
                        style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, background: "transparent", color: C.mute, border: `1px solid ${C.faint}`, borderRadius: 3, padding: "3px 8px", cursor: "pointer" }}>EDIT</button>
                      <button onClick={() => deleteMatch(ch)} title="Delete match"
                        style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, background: "transparent", color: C.red, border: `1px solid rgba(232,96,76,0.5)`, borderRadius: 3, padding: "3px 8px", cursor: "pointer" }}>DEL</button>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* RULES */}
        {!loading && !reportPlayer && tab === "rules" && settings && (
          <>
            <Eyebrow>Ladder rules</Eyebrow>
            <Card>
              {[
                ["Challenging", `Challenge anyone up to ${settings.challenge_range} spots above you. You can have ${settings.max_active_challenges} challenges out at a time, and only one open challenge between the same two players.`],
                ["Being challenged", `A player can only have ${(settings.max_incoming_challenges ?? 1) === 1 ? "one open incoming challenge" : `${settings.max_incoming_challenges} open incoming challenges`} at a time. If you see a red CHALLENGED tag, someone beat you to them — wait until that match wraps up.`],
                ...(settings.rematch_days > 0 ? [["Rematches", `Once a score is reported, you and that opponent can't challenge each other again for ${settings.rematch_days} days — even if the rankings change. Keeps the ladder fresh.`]] : []),
                ["Accepting", `You have ${settings.accept_days} day${settings.accept_days === 1 ? "" : "s"} to accept or decline a challenge. After that it expires.`],
                ["Playing", `Once accepted, you have ${settings.play_days} day${settings.play_days === 1 ? "" : "s"} to play the match. Winner or loser reports the score in the app.`],
                ["Scores & ranking", `Either player — winner or loser — reports the score, and it's final immediately: the winner takes the loser's spot and everyone in between slides down one. Misreported a score? Contact Matt.`],
                ...(settings.decay_enabled ? [["Staying active", `If you go ${settings.decay_days} days without playing a match or issuing a challenge, you drop one spot (unless you're already last). Keep playing to hold your rank!`]] : []),
                ["Taking a break", `Use the temp drop button at the bottom of the ladder. You give up your spot, and everyone below you moves up. When you're ready to come back, contact Matt and you'll re-join at the bottom.`],
              ].map(([title, body]) => (
                <div key={title} style={{ marginBottom: 16 }}>
                  <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 2, color: C.ball, textTransform: "uppercase", marginBottom: 4 }}>{title}</div>
                  <div style={{ fontSize: 14, lineHeight: 1.55, color: C.line }}>{body}</div>
                </div>
              ))}
              <div style={{ borderTop: `1px solid ${C.faint}`, paddingTop: 14, marginTop: 4 }}>
                <div style={{ fontSize: 14, lineHeight: 1.55, color: C.line }}>
                  Questions? Contact your admin, Matt Selwyn
                </div>
                <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 13 }}>
                  <a href="tel:5404980799" style={{ color: C.ball, textDecoration: "none" }}>540-498-0799</a>
                  {" · "}
                  <a href="mailto:mselwyn20@gmail.com" style={{ color: C.ball, textDecoration: "none" }}>mselwyn20@gmail.com</a>
                </div>
              </div>
            </Card>
          </>
        )}

        {/* TOURNAMENT */}
        {!loading && !reportPlayer && tab === "tournament" && (
          <TournamentTab
            players={players} dropped={dropped} allNames={allNames} meP={meP} onPlayer={setReportPlayer}
            tournaments={tournaments} matches={tMatches} say={say} reload={loadAll}
          />
        )}

        {/* ADMIN */}
        {!loading && !reportPlayer && tab === "admin" && meP?.is_admin && (
          <AdminPanel players={players} dropped={dropped} challenges={challenges} settings={settings} say={say} reload={loadAll} meP={meP} />
        )}
      </div>

      {/* bottom tab bar */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.clay, borderTop: `1px solid ${C.faint}`, display: "flex", zIndex: 40, paddingBottom: "env(safe-area-inset-bottom)" }}>
        {tabs.map(([key, label]) => (
          <button key={key} onClick={() => { setReportPlayer(null); setTab(key); }}
            style={{ flex: 1, background: "none", border: "none", padding: "14px 4px", cursor: "pointer", fontFamily: MONO, fontSize: 12, letterSpacing: 1, textTransform: "uppercase", color: tab === key ? C.ball : C.mute, fontWeight: tab === key ? 700 : 400, borderTop: tab === key ? `2px solid ${C.ball}` : "2px solid transparent" }}>
            {label}
          </button>
        ))}
      </div>

      {/* sign-in sheet */}
      <Sheet open={showLogin} onClose={() => { try { localStorage.removeItem("pendingLoginEmail"); } catch {} setShowLogin(false); setLoginSent(false); }} title="Sign in">
        {loginSent ? (
          <>
            <div style={{ color: C.line, fontSize: 14, lineHeight: 1.5, marginBottom: 14 }}>
              We emailed a 6-digit code to <b>{loginEmail}</b>. The code is right in the email's subject line — you can read it from the notification. Type it below. You'll only ever do this once on this device.
            </div>
            <Field label="Code from the email" value={loginCode} onChange={setLoginCode} placeholder="6-digit code" />
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={verifyCode} disabled={loginCode.trim().length < 6}>Sign in</Btn>
              <Btn kind="ghost" onClick={() => { try { localStorage.removeItem("pendingLoginEmail"); } catch {} setLoginSent(false); setLoginCode(""); }}>Different email</Btn>
            </div>
            <div style={{ color: C.mute, fontSize: 12, marginTop: 12 }}>
              You'll stay signed in on this device until you sign out.
            </div>
          </>
        ) : (
          <>
            <div style={{ color: C.mute, fontSize: 13, marginBottom: 14 }}>
              Use the email you're registered on the ladder with. No password — we'll email you a 6-digit code. You only sign in once per device.
            </div>
            <Field label="Email" type="email" value={loginEmail} onChange={setLoginEmail} placeholder="you@example.com" />
            <Btn onClick={sendLogin} disabled={!loginEmail.includes("@")}>Email me a code</Btn>
            <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${C.faint}` }}>
              <div style={{ fontSize: 13, color: C.mute, marginBottom: 10 }}>Not on the ladder yet?</div>
              <button
                onClick={() => openJoin(loginEmail)}
                style={{ display: "block", width: "100%", background: "transparent", color: C.ball, border: `2px solid ${C.ball}`, borderRadius: 4, padding: "13px 18px", fontFamily: MONO, fontWeight: 700, fontSize: 14, letterSpacing: 0.5, cursor: "pointer" }}
              >
                REQUEST TO JOIN
              </button>
            </div>
          </>
        )}
      </Sheet>

      {/* request to join sheet */}
      <Sheet open={showJoin} onClose={() => setShowJoin(false)} title="Request to join">
        <div style={{ color: C.mute, fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>
          The FXBG Singles Ladder is an open rec league. Send this over and Matt
          will add you at the bottom of the ladder — you'll get an email when
          you're in, then you sign in with this same address.
        </div>
        <Field label="Name" value={joinName} onChange={setJoinName} placeholder="First and last" />
        <Field label="Email" type="email" value={joinEmail} onChange={setJoinEmail} placeholder="you@example.com" />
        <Field label="Phone (optional)" value={joinPhone} onChange={setJoinPhone} placeholder="540-555-0123" />
        <Field label="Anything else? (optional)" value={joinNote} onChange={setJoinNote} placeholder="NTRP rating, who referred you, when you play" />
        <Btn onClick={submitJoin} disabled={joinBusy || !joinName.trim() || !joinEmail.includes("@")}>
          {joinBusy ? "Sending…" : "Send request"}
        </Btn>
        <div style={{ color: C.mute, fontSize: 12, marginTop: 12 }}>
          Questions? Matt Selwyn · 540-498-0799
        </div>
      </Sheet>

      {/* challenge sheet */}
      <Sheet open={!!target} onClose={() => setTarget(null)} title="Issue challenge">
        {target && meP && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: MONO, fontSize: 28, fontWeight: 700, color: C.line }}>#{meP.rank}</div>
                <div style={{ fontSize: 12, color: C.mute }}>{meP.name.split(" ")[0]}</div>
              </div>
              <div style={{ fontFamily: MONO, color: C.ball, fontSize: 18 }}>→</div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: MONO, fontSize: 28, fontWeight: 700, color: C.ball }}>#{target.rank}</div>
                <div style={{ fontSize: 12, color: C.mute }}>{target.name.split(" ")[0]}</div>
              </div>
            </div>
            <div style={{ fontSize: 13, color: C.mute, lineHeight: 1.5, marginBottom: 16 }}>
              {target.name} gets an email and has {settings?.accept_days} days to accept.
              Once accepted you'll see each other's contact info and have {settings?.play_days} days to play and report.
              Win and you take #{target.rank}.
            </div>
            <Btn onClick={doChallenge} disabled={sending}>{sending ? "Sending..." : "Send challenge"}</Btn>
          </>
        )}
      </Sheet>

      {/* report score sheet */}
      <Sheet open={!!reporting} onClose={() => setReporting(null)} title="Report score">
        {reporting && (
          <>
            <div style={{ fontSize: 12, color: C.mute, fontFamily: MONO, marginBottom: 8, textTransform: "uppercase", letterSpacing: 2 }}>Who won?</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {[reporting.challenger_id, reporting.opponent_id].map((pid) => (
                <button key={pid} onClick={() => setWinnerId(pid)}
                  style={{ flex: 1, padding: "14px 8px", borderRadius: 4, cursor: "pointer", fontFamily: MONO, fontWeight: 700, fontSize: 14, background: winnerId === pid ? C.ball : "transparent", color: winnerId === pid ? C.clay : C.line, border: `2px solid ${winnerId === pid ? C.ball : C.faint}` }}>
                  {byId[pid]?.name || "?"}
                </button>
              ))}
            </div>
            <Field label="Score" value={score} onChange={setScore} placeholder="e.g. 6-4, 7-5" />
            <div style={{ fontSize: 12, color: C.mute, marginBottom: 14 }}>
              Either player can report — winner or loser. The score is final and the ladder updates the moment you submit.
            </div>
            <Btn onClick={submitScore} disabled={!winnerId}>Submit score</Btn>
          </>
        )}
      </Sheet>

      <Toast msg={toast?.msg} isError={toast?.isError} />

      <div style={{ textAlign: "center", padding: "24px 0 90px", fontFamily: MONO, fontSize: 11, color: C.mute }}>
        © Tyler Selwyn 2026
        <div style={{ marginTop: 8 }}>
          Help keep the site running 🎾 ·{" "}
          <a href={VENMO_URL} target="_blank" rel="noopener noreferrer" style={{ color: C.ball, textDecoration: "none" }}>
            Venmo @{VENMO_USER}
          </a>
        </div>
      </div>
    </div>
  );
}

// ---- ADMIN PANEL ----
function AdminPanel({ players, dropped = [], challenges = [], settings, say, reload, meP }) {
  const [s, setS] = useState(settings || {});
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [rmWinner, setRmWinner] = useState("");
  const [rmLoser, setRmLoser] = useState("");
  const [rmScore, setRmScore] = useState("");
  const [rmBump, setRmBump] = useState(true);
  const [wcA, setWcA] = useState("");
  const [wcB, setWcB] = useState("");
  const [wcDays, setWcDays] = useState(String(settings?.play_days ?? 10));
  const [joinReqs, setJoinReqs] = useState([]);

  useEffect(() => { if (settings) setS(settings); }, [settings]);

  async function loadJoinReqs() {
    try { setJoinReqs((await rpc("list_join_requests")) || []); } catch { setJoinReqs([]); }
  }
  useEffect(() => { loadJoinReqs(); }, []);

  async function handleJoinReq(r, approve) {
    const msg = approve
      ? `Approve ${r.name}? They go to the bottom of the ladder and can sign in with ${r.email}.`
      : `Deny ${r.name}? They are not added and not emailed.`;
    if (!confirm(msg)) return;
    try {
      await rpc(approve ? "approve_join_request" : "deny_join_request", { p_id: r.id });
      if (approve && r.email) notify("welcome", null, { email: r.email });
      say(approve ? `${r.name} added to the bottom of the ladder — welcome email sent` : `Request from ${r.name} denied`);
      loadJoinReqs();
      if (approve) reload();
    } catch (e) { say(e.message, true); }
  }

  async function addPlayer() {
    try {
      await rpc("admin_upsert_player", { p_name: name, p_email: email, p_phone: phone });
      if (email.trim()) notify("welcome", null, { email: email.trim() });
      say(`${name} added to the bottom of the ladder${email.trim() ? " — welcome email sent" : ""}`);
      setName(""); setEmail(""); setPhone("");
      reload();
    } catch (e) { say(e.message, true); }
  }

  async function recordMatch() {
    const w = players.find((p) => p.id === rmWinner);
    const l = players.find((p) => p.id === rmLoser);
    if (!w || !l) { say("Pick a winner and a loser", true); return; }
    if (w.id === l.id) { say("Pick two different players", true); return; }
    const bumpNote = rmBump
      ? (w.rank > l.rank
          ? ` ${w.name} takes over rank #${l.rank}.`
          : " Ranks stay the same (winner already ranked higher).")
      : " Ranks will NOT change.";
    if (!confirm(`Record: ${w.name} def. ${l.name}${rmScore.trim() ? ` ${rmScore.trim()}` : ""}?${bumpNote} W/L records and streaks update immediately, and both players are emailed.`)) return;
    try {
      const id = await rpc("admin_record_match", { p_winner: w.id, p_loser: l.id, p_score: rmScore.trim() || "n/a", p_bump: rmBump });
      if (id) notify("reported", id);
      say("Match recorded — ladder updated");
      setRmWinner(""); setRmLoser(""); setRmScore("");
      reload();
    } catch (e) { say(e.message, true); }
  }

  async function createWildcard() {
    const a = players.find((p) => p.id === wcA);
    const b = players.find((p) => p.id === wcB);
    if (!a || !b) { say("Pick both players", true); return; }
    if (a.id === b.id) { say("Pick two different players", true); return; }
    const days = Math.max(1, parseInt(wcDays, 10) || (settings?.play_days ?? 10));
    const lo = a.rank > b.rank ? a : b;   // lower-ranked = challenger
    const hi = a.rank > b.rank ? b : a;
    if (!confirm(`Set up a wildcard match: ${lo.name} (#${lo.rank}) vs. ${hi.name} (#${hi.rank})?\n\nBoth players are emailed with each other's contact info and have ${days} day${days === 1 ? "" : "s"} to play. Either one can report the score. If ${lo.name} wins, they take #${hi.rank}.\n\nThis does not count against either player's challenge limits.`)) return;
    try {
      const id = await rpc("admin_create_wildcard", { p_a: a.id, p_b: b.id, p_play_days: days });
      if (id) notify("wildcard", id);
      say("Wildcard match created — both players emailed");
      setWcA(""); setWcB("");
      reload();
    } catch (e) { say(e.message, true); }
  }

  async function saveSettings() {
    try {
      await rpc("admin_update_settings", { p: s });
      say("Settings saved");
      reload();
    } catch (e) { say(e.message, true); }
  }

  async function setRank(p) {
    const v = prompt(`New rank for ${p.name} (currently #${p.rank}):`, p.rank);
    if (!v) return;
    try { await rpc("admin_set_rank", { p_player: p.id, p_rank: parseInt(v, 10) }); say("Rank updated"); reload(); }
    catch (e) { say(e.message, true); }
  }

  async function removePlayer(p) {
    if (!confirm(`Remove ${p.name} from the ladder? Everyone below moves up one.`)) return;
    try { await rpc("admin_remove_player", { p_player: p.id }); say(`${p.name} removed`); reload(); }
    catch (e) { say(e.message, true); }
  }

  // Permanently remove someone who temp dropped and isn't coming back.
  // admin_remove_player also clears the dropped flag, so they leave this list.
  async function removeDropped(p) {
    if (!confirm(`Remove ${p.name} from the ladder for good?\n\nThey come off the Temp drops list entirely. Reinstating them later means adding them back as a new player at the bottom.`)) return;
    try { await rpc("admin_remove_player", { p_player: p.id }); say(`${p.name} removed from the ladder`); reload(); }
    catch (e) { say(e.message, true); }
  }

  async function adminTempDrop(p) {
    if (!confirm(`Temp drop ${p.name} (vacation etc.)? They lose their spot, everyone below moves up, and any open challenges are cancelled. Reinstate them from the Temp drops list when they're back.`)) return;
    try { await rpc("admin_temp_drop", { p_player: p.id }); say(`${p.name} is on a temp drop`); reload(); }
    catch (e) { say(e.message, true); }
  }

  const chalName = (id) =>
    players.find((p) => p.id === id)?.name ||
    dropped.find((p) => p.id === id)?.name || "Unknown";

  async function adminScore(c) {
    const a = chalName(c.challenger_id), b = chalName(c.opponent_id);
    const w = prompt(`Who won?\n1 = ${a}\n2 = ${b}`);
    if (w !== "1" && w !== "2") return;
    const score = prompt("Score, winner first (e.g. 6-4, 6-2) — blank for n/a", "");
    if (score === null) return;
    const winnerId = w === "1" ? c.challenger_id : c.opponent_id;
    if (!confirm(`Record: ${w === "1" ? a : b} def. ${w === "1" ? b : a}${score ? ` ${score}` : ""}? The ladder updates immediately.`)) return;
    try { await rpc("admin_force_score", { p_id: c.id, p_winner: winnerId, p_score: score }); notify("reported", c.id); say("Score recorded — ladder updated"); reload(); }
    catch (e) { say(e.message, true); }
  }

  async function adminWithdraw(c) {
    if (!confirm(`Withdraw the ${chalName(c.challenger_id)} vs. ${chalName(c.opponent_id)} challenge?`)) return;
    try { await rpc("cancel_challenge", { p_id: c.id }); notify("withdrawn", c.id); say("Challenge withdrawn"); reload(); }
    catch (e) { say(e.message, true); }
  }

  async function toggleAdmin(p) {
    if (meP && p.id === meP.id) {
      say("You can't remove your own admin — ask the other admin to do it", true);
      return;
    }
    const verb = p.is_admin ? "Remove admin from" : "Make";
    if (!confirm(`${verb} ${p.name}${p.is_admin ? "" : " an admin"}?`)) return;
    try { await rpc("admin_set_admin", { p_player: p.id, p_is: !p.is_admin }); say(`${p.name} ${p.is_admin ? "is no longer" : "is now"} an admin`); reload(); }
    catch (e) { say(e.message, true); }
  }

  const num = (k) => ({
    label: k.replace(/_/g, " "),
    value: s[k] ?? "",
    onChange: (v) => setS({ ...s, [k]: v === "" ? "" : parseInt(v, 10) || 0 }),
    type: "number",
  });

  return (
    <>
      {joinReqs.length > 0 && (
        <>
          <Eyebrow>Join requests ({joinReqs.length})</Eyebrow>
          <Card style={{ padding: 0, marginBottom: 16 }}>
            {joinReqs.map((r, i) => (
              <div key={r.id} style={{ padding: "12px 14px", borderTop: i ? `1px solid ${C.faint}` : "none" }}>
                <div style={{ fontWeight: 700, color: C.line }}>{r.name}</div>
                <div style={{ fontSize: 12, color: C.mute, fontFamily: MONO, marginTop: 3 }}>
                  {r.email}{r.phone ? ` · ${r.phone}` : ""}
                </div>
                {r.note && <div style={{ fontSize: 13, color: C.line, marginTop: 6, lineHeight: 1.4 }}>{r.note}</div>}
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <Btn small onClick={() => handleJoinReq(r, true)}>Approve</Btn>
                  <Btn small kind="ghost" onClick={() => handleJoinReq(r, false)}>Deny</Btn>
                </div>
              </div>
            ))}
          </Card>
        </>
      )}

      <Eyebrow>Roster</Eyebrow>
      <Card style={{ marginBottom: 16 }}>
        <Field label="Name" value={name} onChange={setName} placeholder="First Last" />
        <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="them@example.com" />
        <Field label="Phone" value={phone} onChange={setPhone} placeholder="540-555-0100" />
        <Btn onClick={addPlayer} disabled={!name.trim()}>Add player</Btn>
      </Card>

      <Eyebrow>Record a match</Eyebrow>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: C.mute, marginBottom: 12 }}>
          Enter a result for any two players — no challenge needed, range rules don't apply. Use this when a match happened outside the app.
        </div>
        <SelectField label="Winner" value={rmWinner} onChange={setRmWinner} placeholder="Select winner…"
          options={[...players].sort((a, b) => a.rank - b.rank).map((p) => ({ value: p.id, label: `#${p.rank} ${p.name}` }))} />
        <SelectField label="Loser" value={rmLoser} onChange={setRmLoser} placeholder="Select loser…"
          options={[...players].sort((a, b) => a.rank - b.rank).filter((p) => p.id !== rmWinner).map((p) => ({ value: p.id, label: `#${p.rank} ${p.name}` }))} />
        <Field label="Score (winner first)" value={rmScore} onChange={setRmScore} placeholder="6-4, 6-2 — blank for n/a" />
        <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={rmBump} onChange={(e) => setRmBump(e.target.checked)} />
          <span style={{ fontSize: 13, color: C.line }}>Apply rank bump (winner takes loser's spot if ranked below them)</span>
        </label>
        <Btn onClick={recordMatch} disabled={!rmWinner || !rmLoser}>Record match</Btn>
      </Card>

      <Eyebrow>Set up wildcard match</Eyebrow>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: C.mute, marginBottom: 12 }}>
          Arrange a match between any two players, any distance apart. Both are emailed
          right away with each other's contact info — no accept step. Either player reports
          the score, and the winner takes the loser's spot. It does not count against
          anyone's challenge limits, so both players can still challenge as normal.
        </div>
        <SelectField label="Player 1" value={wcA} onChange={setWcA} placeholder="Select player…"
          options={[...players].sort((a, b) => a.rank - b.rank).filter((p) => p.id !== wcB).map((p) => ({ value: p.id, label: `#${p.rank} ${p.name}` }))} />
        <SelectField label="Player 2" value={wcB} onChange={setWcB} placeholder="Select player…"
          options={[...players].sort((a, b) => a.rank - b.rank).filter((p) => p.id !== wcA).map((p) => ({ value: p.id, label: `#${p.rank} ${p.name}` }))} />
        <Field label="Days to play" type="number" value={wcDays} onChange={setWcDays} placeholder={String(settings?.play_days ?? 10)} />
        <Btn onClick={createWildcard} disabled={!wcA || !wcB}>Create wildcard match</Btn>
      </Card>

      <Eyebrow>Rules</Eyebrow>
      <Card style={{ marginBottom: 16 }}>
        <Field {...num("challenge_range")} />
        <Field {...num("max_active_challenges")} />
        <Field {...num("max_incoming_challenges")} />
        <Field {...num("accept_days")} />
        <Field {...num("play_days")} />
        <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={!!s.decay_enabled} onChange={(e) => setS({ ...s, decay_enabled: e.target.checked })} />
          <span style={{ fontSize: 13, color: C.line }}>Inactivity decay (drop 1 spot per {s.decay_days || 30} idle days)</span>
        </label>
        <Field {...num("decay_days")} />
        <Field {...num("rematch_days")} />
        <Btn onClick={saveSettings}>Save settings</Btn>
      </Card>

      {(() => {
        const nameOf = chalName;
        const open = challenges.filter((c) => c.status === "pending" || c.status === "accepted");
        return (
          <>
            <Eyebrow>Open challenges ({open.length})</Eyebrow>
            <Card style={{ padding: 0, marginBottom: 16 }}>
              {open.length === 0 && (
                <div style={{ padding: "12px", fontSize: 13, color: C.mute }}>No open challenges.</div>
              )}
              {open.map((c) => (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: `1px solid ${C.faint}` }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: C.line, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span>{nameOf(c.challenger_id)} <span style={{ color: C.mute }}>vs.</span> {nameOf(c.opponent_id)}</span>
                      {c.is_wildcard && (
                        <span style={{ fontFamily: MONO, fontSize: 10, color: C.ball, border: `1px solid rgba(216,245,41,0.4)`, borderRadius: 3, padding: "2px 6px" }}>
                          WILDCARD
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: C.mute, fontFamily: MONO }}>
                      {c.status === "pending"
                        ? `pending — accept by ${fmtDate(c.accept_by)} (${daysLeft(c.accept_by)}d left)`
                        : `${c.is_wildcard ? "wildcard" : "accepted"} — play by ${fmtDate(c.play_by)} (${daysLeft(c.play_by)}d left)`}
                    </div>
                    <div style={{ fontSize: 11, color: C.mute, fontFamily: MONO }}>
                      issued {fmtDate(c.created_at)} — open {Math.max(0, Math.floor((Date.now() - new Date(c.created_at)) / 86400000))}d
                    </div>
                  </div>
                  <Btn small kind="ghost" onClick={() => adminScore(c)}>Score</Btn>
                  <Btn small kind="danger" onClick={() => adminWithdraw(c)}>✕</Btn>
                </div>
              ))}
            </Card>
          </>
        );
      })()}

      <Eyebrow>Players ({players.length})</Eyebrow>
      <Card style={{ padding: 0, marginBottom: 16 }}>
        {players.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: `1px solid ${C.faint}` }}>
            <div style={{ fontFamily: MONO, color: C.ball, fontWeight: 700, width: 30, textAlign: "right" }}>{p.rank}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, color: C.line, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {p.name}{p.is_admin ? " ★" : ""}
              </div>
              <div style={{ fontSize: 11, color: C.mute, fontFamily: MONO }}>{p.email || "no email — can't sign in"}</div>
            </div>
            <Btn small kind="ghost" onClick={() => setRank(p)}>Rank</Btn>
            <Btn small kind="ghost" onClick={() => adminTempDrop(p)} title="Temp drop (vacation)">⏸</Btn>
            <Btn small kind="danger" onClick={() => removePlayer(p)}>✕</Btn>
          </div>
        ))}
      </Card>

      {dropped.length > 0 && (
        <>
          <Eyebrow>Temp drops ({dropped.length})</Eyebrow>
          <Card style={{ padding: 0 }}>
            {dropped.map((p) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: `1px solid ${C.faint}` }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: C.line, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: C.mute, fontFamily: MONO }}>{p.email || "no email"}</div>
                </div>
                <Btn small onClick={async () => {
                  try {
                    await rpc("admin_reinstate_player", { p_player: p.id });
                    say(`${p.name} is back on the ladder at the bottom`);
                    reload();
                  } catch (e) { say(e.message, true); }
                }}>Reinstate</Btn>
                <Btn small kind="danger" onClick={() => removeDropped(p)}>&#10005;</Btn>
              </div>
            ))}
          </Card>
        </>
      )}
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);
