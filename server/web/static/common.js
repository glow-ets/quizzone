/* Shared by screen and control: i18n, snapshot stream, helpers. */
const Q = new URLSearchParams(location.search);
const TOKEN = Q.get("token") || "";
let STR = {}, FALLBACK = {}, CUR_LANG = null;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function t(key, params) {
  let s = STR[key] ?? FALLBACK[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
  return s;
}
async function loadLang(lang) {
  if (lang === CUR_LANG) return false;
  const get = async l => { try { const r = await fetch(`/i18n/${l}.json`); return r.ok ? await r.json() : {}; } catch { return {}; } };
  if (!Object.keys(FALLBACK).length) FALLBACK = await get("it");
  STR = lang === "it" ? FALLBACK : await get(lang);
  CUR_LANG = lang;
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i]").forEach(el => { el.textContent = t(el.dataset.i); });
  return true;
}
function fmtTime(ms) { return Math.max(0, Math.ceil(ms / 1000)); }
function teamName(tm) { return tm.name || t("team.default", { n: tm.slot + 1 }); }

/* Snapshot stream. onSnap(snap) is called for every update; onState(connected) on change. */
function connect(role, onSnap, onState) {
  let es = null, lastOk = 0, up = null;
  const setUp = v => { if (v !== up) { up = v; onState && onState(v); } };
  const open = () => {
    es = new EventSource(`/api/events?role=${role}` + (TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ""));
    es.onmessage = ev => { lastOk = performance.now(); setUp(true); const s = JSON.parse(ev.data); s._at = lastOk; onSnap(s); };
    es.onerror = () => setUp(false);
  };
  open();
  // watchdog: the server sends something every second; silence means the link is dead even if the browser says open
  setInterval(() => { if (performance.now() - lastOk > 3500) { setUp(false); es.close(); open(); } }, 1500);
}
async function api(name, args) {
  const r = await fetch("/api/cmd" + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, args: args || {} }) });
  let j = {};
  try { j = await r.json(); } catch { }
  if (!r.ok) throw Object.assign(new Error(j.key || "err.network"), { key: j.key || (r.status === 401 ? "err.unauthorized" : "err.network"), params: j.params });
  return j;
}
const LETTERS = "ABCDE";
