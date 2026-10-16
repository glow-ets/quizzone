const $ = id => document.getElementById(id);
let S = null, connected = false, lastKey = "";
const C = 2 * Math.PI * 45;       // ring circumference for r=45 in a 100x100 viewBox

function remainingMs() {
  if (!S || !S.timer) return 0;
  if (S.phase !== "open") return 0;
  return Math.max(0, S.timer.remaining_ms - (performance.now() - S._at));
}
function lampsHtml(s) {
  const res = {};
  if (s.phase === "reveal" && s.reveal) s.reveal.results.forEach(r => res[r.slot] = r);
  return s.teams.map(tm => {
    let cls = "lamp";
    if (!tm.online && s.phase !== "final") cls += " off";
    if (s.phase === "open" || s.phase === "closed") { if (tm.answered) cls += " lit"; }
    const r = res[tm.slot];
    let d = "";
    if (r && r.correct !== null) { cls += r.correct ? " up" : " down"; d = (r.delta > 0 ? "+" : "") + r.delta; }
    else if (r) cls += " lamp-none";
    return `<div class="${cls}"><div class="dot"></div><div class="nm">${esc(teamName(tm))}</div><div class="sc" data-d="${esc(d)}">${tm.score}</div></div>`;
  }).join("");
}
/* ---- final scoreboard ---- */
const MEDAL = { 1: "gold", 2: "silver", 3: "bronze" };
const CONFETTI = ["--a", "--b", "--c", "--d", "--e"];
function trophySvg(kind) {
  return `<svg class="trophy-svg" viewBox="0 0 100 118" aria-hidden="true">
    <path d="M24 16H10c0 22 8 34 22 40M76 16h14c0 22-8 34-22 40" fill="none" stroke="var(--ink)" stroke-width="9" stroke-linecap="round"/>
    <path d="M24 16H10c0 22 8 34 22 40M76 16h14c0 22-8 34-22 40" fill="none" stroke="url(#g-${kind})" stroke-width="4.5" stroke-linecap="round"/>
    <path d="M22 6h56v34c0 24-12 38-28 38S22 64 22 40z" fill="url(#g-${kind})" stroke="var(--ink)" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M30 14v26c0 14 5 24 11 29" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="5" stroke-linecap="round"/>
    <path d="M50 20l5.2 10.6 11.7 1.7-8.5 8.2 2 11.6L50 46.600l-10.400 5.500 2-11.600-8.500-8.200 11.700-1.700z" fill="#fff" fill-opacity=".85"/>
    <path d="M44 76h12v14H44z" fill="url(#g-${kind})" stroke="var(--ink)" stroke-width="3.5" stroke-linejoin="round"/>
    <rect x="28" y="90" width="44" height="9" rx="3" fill="url(#g-${kind})" stroke="var(--ink)" stroke-width="3.5"/>
    <rect x="21" y="99" width="58" height="13" rx="4" fill="var(--ink)"/>
    <rect x="24" y="102" width="52" height="7" rx="2.500" fill="url(#g-${kind})"/>
  </svg>`;
}
function confettiHtml() {
  let h = "";
  for (let i = 0; i < 26; i++) {                       // fixed pseudo-random layout: no flicker between repaints
    const x = (i * 37 + 11) % 100, d = (i * 53) % 90 / 10, size = 1.3 + (i * 7) % 5 * .35, dur = 8 + (i * 13) % 7;
    h += `<i style="left:${x}%;width:${size}vmin;height:${size * (i % 3 ? 1 : .45)}vmin;background:var(${CONFETTI[i % 5]});animation-duration:${dur}s;animation-delay:-${d}s;--spin:${(i % 2 ? 1 : -1) * (180 + i * 20)}deg"></i>`;
  }
  return `<div class="confetti" aria-hidden="true">${h}</div>`;
}
function finalHtml(s) {
  const rows = [...s.podium].sort((a, b) => a.rank - b.rank || a.slot - b.slot);
  const maxRank = Math.max(1, ...rows.map(r => r.rank));
  const top = rows.filter(r => r.rank <= 3);
  const heroes = top.length && top.length <= 4 ? top : [];          // a long run of ties for the medals: plain list instead
  const rest = rows.filter(r => !heroes.includes(r));
  const classic = heroes.length === 3 && heroes[0].rank === 1 && heroes[1].rank === 2 && heroes[2].rank === 3;
  const ordered = classic ? [heroes[1], heroes[0], heroes[2]] : heroes;
  const hueOf = r => 340 - 140 * Math.min(1, Math.max(0, (r.rank - 4) / Math.max(1, maxRank - 4)));   // pink -> violet -> blue
  const hero = r => `<div class="hero ${MEDAL[r.rank]} r${r.rank}"><div class="trophy">${trophySvg(MEDAL[r.rank])}</div>
      <div class="hrank">${r.rank}</div><div class="hname">${esc(teamName(r))}</div><div class="hpt">${r.score}</div></div>`;
  const per = Math.min(6, rest.length), cols = Math.max(1, Math.ceil(rest.length / Math.max(1, per)));
  const row = r => `<div class="prow ${MEDAL[r.rank] || ""}" style="--h:${hueOf(r)}">
      <span class="rk">${r.rank}</span><span class="nm">${esc(teamName(r))}</span><span class="pt">${r.score}</span></div>`;
  return `${confettiHtml()}
    <div class="ftitle"><span>${esc(t("screen.final"))}</span></div>
    ${heroes.length ? `<div class="heroes ${classic ? "classic" : ""}">${ordered.map(hero).join("")}</div>` : ""}
    <div class="podium" style="--rows:${per};--cols:${cols}">${rest.map(row).join("")}</div>`;
}
function render() {
  if (!S) return;
  $("ttl").textContent = S.title + (S.series ? " · " + S.series : "");
  $("prog").textContent = S.question && !S.question.test ? t("screen.progress", { n: S.cursor + 1, total: S.total }) : "";
  $("net").classList.toggle("hidden", S.link_ok && connected);
  const nT = S.teams.length, lampRows = nT <= 8 ? 1 : 2;
  $("lamps").style.setProperty("--cols", Math.max(1, Math.ceil(nT / lampRows)));      // 15 teams: 8 + 7, all boxes the same width
  $("lamps").innerHTML = S.phase === "final" ? "" : lampsHtml(S);
  const q = S.question, st = $("stage");
  $("root").classList.toggle("is-lobby", S.phase === "lobby" || (!q && S.phase !== "final"));
  // Structure changes only when the phase/question changes; timers update separately.
  const key = [S.phase, q && q.id, S.reveal ? 1 : 0, S.lang].join("|");
  if (key === lastKey) { updateLive(); return; }
  lastKey = key;
  if (S.phase === "lobby" || (!q && S.phase !== "final")) {
    st.className = "stage center";
    const word = S.series || S.title;
    const letters = [...word].map((ch, i) => ch === " " ? `<i class="sp"></i>` : `<span style="--i:${i}">${esc(ch)}</span>`).join("");
    st.innerHTML = `<div class="wordart" role="img" aria-label="${esc(word)}">${letters}</div>
      ${S.series ? `<h1>${esc(S.title)}</h1>` : ""}
      <div class="sub">${esc(t("screen.lobby", { n: S.teams.filter(x => x.online).length }))}</div>`;
    return;
  }
  if (S.phase === "final") {
    st.className = "stage final";
    st.innerHTML = finalHtml(S);
    return;
  }
  const reveal = S.phase === "reveal";
  st.className = "stage" + (reveal ? " reveal" : "");
  const ans = q.answers.map((a, i) => `<div class="ans ${reveal && i === q.correct ? "right" : ""}"><span class="key">${LETTERS[i]}</span><span>${esc(a)}</span><span class="count"></span><i class="bar"></i></div>`).join("");
  st.innerHTML = `<div class="qrow"><div>${q.category ? `<p class="qcat">${esc(q.category)}</p>` : ""}<h2 class="qtext">${esc(q.text || "")}</h2></div>
      <div class="timer" id="timer"><svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="45" fill="none" stroke-width="7"/><circle class="arc" id="arc" cx="50" cy="50" r="45" fill="none" stroke-width="7" stroke-dasharray="${C}" stroke-dashoffset="0"/></svg><div class="num" id="num"></div></div></div>
      <div><div class="answers">${ans}</div>${reveal && q.explanation ? `<p class="explain">${esc(q.explanation)}</p>` : ""}</div>`;
  updateLive();
}
function updateLive() {
  if (!S || !S.question) return;
  const tm = $("timer");
  if (tm) {
    const rem = remainingMs(), lim = S.timer ? S.timer.limit_ms : 1;
    const secs = fmtTime(rem);
    $("num").textContent = S.phase === "ready" ? "" : secs;
    $("arc").style.strokeDashoffset = String(C * (1 - (S.phase === "open" ? rem / lim : 0)));
    tm.classList.toggle("low", S.phase === "open" && secs <= 5);
    tm.classList.toggle("done", S.phase !== "open");
  }
  if (S.phase === "reveal" && S.reveal) {
    const mx = Math.max(1, ...S.reveal.counts);
    document.querySelectorAll(".ans").forEach((el, i) => {
      el.querySelector(".count").textContent = S.reveal.counts[i];
      el.querySelector(".bar").style.width = (100 * S.reveal.counts[i] / mx) + "%";
    });
  }
}
function frame() { updateLive(); requestAnimationFrame(frame); }
(async function () {
  await loadLang("it");
  connect("screen", async s => {
    if (s.lang !== CUR_LANG) { await loadLang(s.lang); lastKey = ""; }
    S = s; render();
  }, up => { connected = up; render(); });
  requestAnimationFrame(frame);
})();
