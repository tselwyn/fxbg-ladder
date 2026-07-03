import React, { useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";

// ================================================================
// FXBG SINGLES LADDER — the ladder itself (system of record)
// Companion app to Rally Report. Same court, same colors.
// ================================================================

// ---- CONFIG (pencil-edit these, or set env vars in Vercel) ----
const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || "PASTE_YOUR_SUPABASE_URL_HERE";
const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY || "PASTE_YOUR_SUPABASE_ANON_KEY_HERE";
// Same published Google Sheet Rally Report uses (roster import):
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

function notify(type, challengeId) {
  // fire-and-forget; email failures never block the app
  fetch("/api/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, challengeId }),
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

function LadderRow({ p, meP, canChallenge, hasOpen, onTap }) {
  const isMe = meP && p.id === meP.id;
  return (
    <div
      onClick={onTap}
      style={{
        display: "flex", alignItems: "center", gap: 10, padding: "12px 12px",
        borderBottom: `1px solid ${C.faint}`, cursor: canChallenge ? "pointer" : "default",
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
              {p.streak > 0 ? "W" : "L"}{Math.abs(p.streak)}
            </span>
          )}
        </div>
      </div>
      <div style={{ width: 36, textAlign: "center" }}><Movement n={p.rank_change} /></div>
      {hasOpen && (
        <div style={{ fontFamily: MONO, fontSize: 10, color: C.clay, background: C.ball, borderRadius: 3, padding: "3px 6px", fontWeight: 700 }}>VS</div>
      )}
      {canChallenge && !hasOpen && (
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.ball, border: `1px solid rgba(216,245,41,0.4)`, borderRadius: 3, padding: "3px 8px" }}>
          CHALLENGE
        </div>
      )}
    </div>
  );
}

// ---- CHALLENGE CARD (Matches tab) ----
function ChallengeCard({ ch, meP, byId, act }) {
  const opp = byId[ch.challenger_id === meP?.id ? ch.opponent_id : ch.challenger_id];
  const iAmChallenger = meP && ch.challenger_id === meP.id;
  const iAmOpponent = meP && ch.opponent_id === meP.id;
  if (!opp) return null;
  const label =
    ch.status === "pending" ? (iAmChallenger ? "Waiting on them to accept" : "They challenged you") :
    ch.status === "accepted" ? "Match on — play + report" :
    ch.status === "reported" ? "Score reported — needs confirming" : ch.status;
  return (
    <Card style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ color: C.line, fontWeight: 700, fontSize: 15 }}>
          {iAmChallenger ? "You" : opp.name} <span style={{ color: C.mute, fontWeight: 400 }}>vs</span> {iAmChallenger ? opp.name : "you"}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.mute }}>#{opp.rank}</div>
      </div>
      <div style={{ fontSize: 12, color: C.mute, marginTop: 4 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 11, color: C.mute, marginTop: 4 }}>
        {ch.status === "pending" && <>accept within {daysLeft(ch.accept_by)}d ({fmtDate(ch.accept_by)})</>}
        {ch.status === "accepted" && <>play by {fmtDate(ch.play_by)} ({daysLeft(ch.play_by)}d left)</>}
        {ch.status === "reported" && <>score: {ch.score} · auto-confirms in {hoursLeft(ch.confirm_by)}h</>}
      </div>
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
          <Btn small onClick={() => act("report", ch)}>Report score</Btn>
        )}
        {ch.status === "reported" && meP && ch.winner_id !== meP.id && (iAmChallenger || iAmOpponent) && (
          <Btn small onClick={() => act("confirm", ch)}>Confirm score</Btn>
        )}
      </div>
    </Card>
  );
}

// ---- MAIN APP ----
function App() {
  const [session, setSession] = useState(null);
  const [players, setPlayers] = useState([]);
  const [challenges, setChallenges] = useState([]);
  const [settings, setSettings] = useState(null);
  const [tab, setTab] = useState("ladder");
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);

  const [loginEmail, setLoginEmail] = useState("");
  const [loginSent, setLoginSent] = useState(false);
  const [loginCode, setLoginCode] = useState("");
  const [showLogin, setShowLogin] = useState(false);

  const [target, setTarget] = useState(null);      // player being challenged
  const [reporting, setReporting] = useState(null); // challenge being scored
  const [winnerId, setWinnerId] = useState(null);
  const [score, setScore] = useState("");

  const say = (msg, isError) => {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), 3500);
  };

  const meP = useMemo(() => {
    const email = session?.user?.email?.toLowerCase();
    return email ? players.find((p) => p.email?.toLowerCase() === email) : null;
  }, [session, players]);

  const byId = useMemo(() => Object.fromEntries(players.map((p) => [p.id, p])), [players]);

  async function loadAll() {
    try { await supabase.rpc("tick"); } catch {}
    const [p, c, s] = await Promise.all([
      supabase.from("players").select("*").eq("active", true).order("rank"),
      supabase.from("challenges").select("*").order("created_at", { ascending: false }),
      supabase.from("settings").select("*").eq("id", 1).single(),
    ]);
    if (p.data) setPlayers(p.data);
    if (c.data) setChallenges(c.data);
    if (s.data) setSettings(s.data);
    setLoading(false);
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    loadAll();
    return () => sub.subscription.unsubscribe();
  }, []);

  const open = challenges.filter((c) => ["pending", "accepted", "reported"].includes(c.status));
  const myOpen = meP ? open.filter((c) => c.challenger_id === meP.id || c.opponent_id === meP.id) : [];
  const completed = challenges.filter((c) => c.status === "completed");
  const openWith = (pid) =>
    meP && open.some((c) =>
      (c.challenger_id === meP.id && c.opponent_id === pid) ||
      (c.challenger_id === pid && c.opponent_id === meP.id));
  const myActiveCount = meP ? open.filter((c) => c.challenger_id === meP.id).length : 0;

  const canChallenge = (p) =>
    meP && settings && p.id !== meP.id && p.rank < meP.rank &&
    meP.rank - p.rank <= settings.challenge_range &&
    myActiveCount < settings.max_active_challenges && !openWith(p.id);

  async function sendLogin() {
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: loginEmail.trim(),
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
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
      setShowLogin(false); setLoginSent(false); setLoginCode("");
      say("Signed in — you'll stay signed in on this device");
      loadAll();
    } catch (e) { say(e.message, true); }
  }

  function confirmSignOut() {
    if (confirm("Sign out? You'll need a new code to get back in.")) {
      supabase.auth.signOut();
    }
  }

  async function doChallenge() {
    try {
      const cid = await rpc("issue_challenge", { p_opponent: target.id });
      notify("issued", cid);
      say(`Challenge sent to ${target.name}`);
      setTarget(null);
      loadAll();
    } catch (e) { say(e.message, true); }
  }

  async function act(kind, ch) {
    try {
      if (kind === "accept") { await rpc("accept_challenge", { p_id: ch.id }); notify("accepted", ch.id); say("Challenge accepted — contact info unlocked"); }
      if (kind === "decline") { await rpc("decline_challenge", { p_id: ch.id }); say("Challenge declined"); }
      if (kind === "cancel") { await rpc("cancel_challenge", { p_id: ch.id }); say("Challenge cancelled"); }
      if (kind === "confirm") { await rpc("confirm_score", { p_id: ch.id }); say("Score confirmed — ladder updated"); }
      if (kind === "report") { setReporting(ch); setWinnerId(null); setScore(""); return; }
      loadAll();
    } catch (e) { say(e.message, true); }
  }

  async function submitScore() {
    try {
      if (!winnerId) throw new Error("Pick who won");
      await rpc("report_score", { p_id: reporting.id, p_winner: winnerId, p_score: score.trim() || "n/a" });
      notify("reported", reporting.id);
      say("Score reported — waiting on confirmation");
      setReporting(null);
      loadAll();
    } catch (e) { say(e.message, true); }
  }

  const tabs = [
    ["ladder", "Ladder"],
    ["matches", `Matches${myOpen.length ? ` (${myOpen.length})` : ""}`],
    ["history", "History"],
    ...(meP?.is_admin ? [["admin", "Admin"]] : []),
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.court, color: C.line, fontFamily: "system-ui, -apple-system, sans-serif", paddingBottom: 70 }}>
      {/* header */}
      <div style={{ padding: "22px 16px 14px", paddingTop: "calc(22px + env(safe-area-inset-top))", borderBottom: `1px solid ${C.faint}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 3, color: C.mute, textTransform: "uppercase" }}>FXBG Singles</div>
          <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 22, color: C.ball, letterSpacing: 1 }}>THE LADDER</div>
        </div>
        {session ? (
          <button onClick={confirmSignOut} style={{ background: "none", border: `1px solid ${C.faint}`, color: C.mute, borderRadius: 4, padding: "6px 10px", fontSize: 11, fontFamily: MONO, cursor: "pointer" }}>
            {meP ? meP.name.split(" ")[0].toUpperCase() : "SIGNED IN"} · OUT
          </button>
        ) : (
          <Btn small onClick={() => setShowLogin(true)}>Sign in</Btn>
        )}
      </div>

      <div style={{ maxWidth: 560, margin: "0 auto", padding: "14px 12px" }}>
        {loading && <div style={{ color: C.mute, fontFamily: MONO, padding: 30, textAlign: "center" }}>loading…</div>}

        {/* LADDER */}
        {!loading && tab === "ladder" && (
          <>
            {meP && settings && (
              <div style={{ fontSize: 12, color: C.mute, fontFamily: MONO, marginBottom: 10 }}>
                You're #{meP.rank}. Challenge up to {settings.challenge_range} spots up · {settings.max_active_challenges - myActiveCount} challenge{settings.max_active_challenges - myActiveCount === 1 ? "" : "s"} left
              </div>
            )}
            {!session && (
              <div style={{ fontSize: 12, color: C.mute, fontFamily: MONO, marginBottom: 10 }}>
                Sign in to issue challenges and report scores.
              </div>
            )}
            <Card style={{ padding: 0 }}>
              {players.map((p) => (
                <LadderRow
                  key={p.id} p={p} meP={meP}
                  canChallenge={canChallenge(p)}
                  hasOpen={openWith(p.id)}
                  onTap={() => canChallenge(p) && setTarget(p)}
                />
              ))}
              {players.length === 0 && (
                <div style={{ padding: 24, color: C.mute, fontSize: 14 }}>
                  No players yet. An admin can import the roster from the Admin tab.
                </div>
              )}
            </Card>
          </>
        )}

        {/* MATCHES */}
        {!loading && tab === "matches" && (
          <>
            <Eyebrow>Your open matches</Eyebrow>
            {!session && <Card><div style={{ color: C.mute, fontSize: 14 }}>Sign in to see your matches.</div></Card>}
            {session && myOpen.length === 0 && (
              <Card><div style={{ color: C.mute, fontSize: 14 }}>Nothing open. Tap a player on the ladder to challenge them.</div></Card>
            )}
            {myOpen.map((ch) => (
              <ChallengeCard key={ch.id} ch={ch} meP={meP} byId={byId} act={act} />
            ))}
            {session && open.filter((c) => !myOpen.includes(c)).length > 0 && (
              <>
                <Eyebrow>Elsewhere on the ladder</Eyebrow>
                {open.filter((c) => !myOpen.includes(c)).map((ch) => {
                  const a = byId[ch.challenger_id], b = byId[ch.opponent_id];
                  if (!a || !b) return null;
                  return (
                    <div key={ch.id} style={{ fontSize: 13, color: C.mute, padding: "6px 4px", fontFamily: MONO }}>
                      #{a.rank} {a.name} → #{b.rank} {b.name} · {ch.status}
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}

        {/* HISTORY */}
        {!loading && tab === "history" && (
          <>
            <Eyebrow>Match history</Eyebrow>
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
                </div>
              );
            })}
          </>
        )}

        {/* ADMIN */}
        {!loading && tab === "admin" && meP?.is_admin && (
          <AdminPanel players={players} settings={settings} say={say} reload={loadAll} meP={meP} />
        )}
      </div>

      {/* bottom tab bar */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.clay, borderTop: `1px solid ${C.faint}`, display: "flex", zIndex: 40, paddingBottom: "env(safe-area-inset-bottom)" }}>
        {tabs.map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{ flex: 1, background: "none", border: "none", padding: "14px 4px", cursor: "pointer", fontFamily: MONO, fontSize: 12, letterSpacing: 1, textTransform: "uppercase", color: tab === key ? C.ball : C.mute, fontWeight: tab === key ? 700 : 400, borderTop: tab === key ? `2px solid ${C.ball}` : "2px solid transparent" }}>
            {label}
          </button>
        ))}
      </div>

      {/* sign-in sheet */}
      <Sheet open={showLogin} onClose={() => { setShowLogin(false); setLoginSent(false); }} title="Sign in">
        {loginSent ? (
          <>
            <div style={{ color: C.line, fontSize: 14, lineHeight: 1.5, marginBottom: 14 }}>
              We emailed a 6-digit code to <b>{loginEmail}</b>. Type it here — no need to leave this screen.
            </div>
            <Field label="6-digit code" value={loginCode} onChange={setLoginCode} placeholder="123456" />
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={verifyCode} disabled={loginCode.trim().length < 6}>Sign in</Btn>
              <Btn kind="ghost" onClick={() => { setLoginSent(false); setLoginCode(""); }}>Different email</Btn>
            </div>
            <div style={{ color: C.mute, fontSize: 12, marginTop: 12 }}>
              You'll stay signed in on this device until you sign out.
            </div>
          </>
        ) : (
          <>
            <div style={{ color: C.mute, fontSize: 13, marginBottom: 14 }}>
              Use the email you're registered on the ladder with. No password — we'll email you a sign-in code.
            </div>
            <Field label="Email" type="email" value={loginEmail} onChange={setLoginEmail} placeholder="you@example.com" />
            <Btn onClick={sendLogin} disabled={!loginEmail.includes("@")}>Email me a code</Btn>
          </>
        )}
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
            <Btn onClick={doChallenge}>Send challenge</Btn>
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
              The other player confirms, or it auto-confirms in {settings?.confirm_hours} hours. The bump applies on confirmation.
            </div>
            <Btn onClick={submitScore} disabled={!winnerId}>Submit score</Btn>
          </>
        )}
      </Sheet>

      <Toast msg={toast?.msg} isError={toast?.isError} />

      <div style={{ textAlign: "center", padding: "24px 0 90px", fontFamily: MONO, fontSize: 11, color: C.mute }}>
        © Tyler Selwyn 2026
      </div>
    </div>
  );
}

// ---- ADMIN PANEL ----
function AdminPanel({ players, settings, say, reload, meP }) {
  const [s, setS] = useState(settings || {});
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (settings) setS(settings); }, [settings]);

  async function importRoster() {
    setBusy(true);
    try {
      const res = await fetch(ROSTER_CSV_URL);
      const rows = parseSheet(await res.text());
      const withEmail = rows.filter((r) => r.email);
      if (withEmail.length === 0) throw new Error("No rows with emails found in the sheet");
      const added = await rpc("admin_import_players", { p_rows: withEmail });
      say(`Imported ${added} new player${added === 1 ? "" : "s"} (${withEmail.length} rows checked)`);
      reload();
    } catch (e) { say(e.message, true); }
    setBusy(false);
  }

  async function addPlayer() {
    try {
      await rpc("admin_upsert_player", { p_name: name, p_email: email, p_phone: phone });
      say(`${name} added to the bottom of the ladder`);
      setName(""); setEmail(""); setPhone("");
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
      <Eyebrow>Roster</Eyebrow>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: C.mute, marginBottom: 12, lineHeight: 1.5 }}>
          Pulls the same Google Sheet Rally Report uses. New players (rows with an email that aren't on the ladder yet) get added to the bottom. Existing players are untouched.
        </div>
        <Btn onClick={importRoster} disabled={busy}>{busy ? "Importing…" : "Import roster from sheet"}</Btn>
      </Card>

      <Card style={{ marginBottom: 16 }}>
        <Field label="Name" value={name} onChange={setName} placeholder="First Last" />
        <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="them@example.com" />
        <Field label="Phone" value={phone} onChange={setPhone} placeholder="540-555-0100" />
        <Btn onClick={addPlayer} disabled={!name.trim()}>Add player</Btn>
      </Card>

      <Eyebrow>Rules</Eyebrow>
      <Card style={{ marginBottom: 16 }}>
        <Field {...num("challenge_range")} />
        <Field {...num("max_active_challenges")} />
        <Field {...num("accept_days")} />
        <Field {...num("play_days")} />
        <Field {...num("confirm_hours")} />
        <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={!!s.decay_enabled} onChange={(e) => setS({ ...s, decay_enabled: e.target.checked })} />
          <span style={{ fontSize: 13, color: C.line }}>Inactivity decay (drop 1 spot per {s.decay_days || 30} idle days)</span>
        </label>
        <Field {...num("decay_days")} />
        <Btn onClick={saveSettings}>Save settings</Btn>
      </Card>

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
            <Btn small kind="ghost" onClick={() => toggleAdmin(p)}>★</Btn>
            <Btn small kind="danger" onClick={() => removePlayer(p)}>✕</Btn>
          </div>
        ))}
      </Card>
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);
