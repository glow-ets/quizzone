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
function sceneSvg() {
  const S = (c, w = 4) => `fill="${c}" stroke="var(--ink)" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;
  const star = (x, y, r, c) => `<path transform="translate(${x} ${y}) scale(${r})" d="M0-1l.3.62 .68.1-.5.48.12.68L0 .54l-.6.34.12-.68-.5-.48.68-.1z" ${S(c, 4 / r)}/>`;
  return `<svg viewBox="0 0 1600 260" preserveAspectRatio="xMidYMax meet">
    <path d="M0 246H1600" stroke="var(--ink)" stroke-width="5" stroke-linecap="round"/>
    <g transform="translate(150 0)">                      <!-- flask -->
      <path d="M-26 70v70L-78 226c-8 14 0 20 14 20h128c14 0 22-6 14-20L26 140V70z" ${S("#fff")}/>
      <path d="M-52 190h104l24 36c8 14 0 20-14 20h-124c-14 0-22-6-14-20z" ${S("var(--d)")}/>
      <rect x="-34" y="56" width="68" height="16" rx="6" ${S("#fff")}/>
      <circle cx="-10" cy="168" r="7" fill="#fff" stroke="var(--ink)" stroke-width="3"/><circle cx="14" cy="128" r="9" fill="#fff" stroke="var(--ink)" stroke-width="3"/><circle cx="-4" cy="96" r="6" fill="#fff" stroke="var(--ink)" stroke-width="3"/>
    </g>
    <g transform="translate(420 140)">                    <!-- atom -->
      <ellipse rx="96" ry="34" ${S("none", 5)} />
      <ellipse rx="96" ry="34" transform="rotate(60)" ${S("none", 5)}/>
      <ellipse rx="96" ry="34" transform="rotate(120)" ${S("none", 5)}/>
      <circle r="24" ${S("var(--a)")}/><circle cx="-8" cy="-8" r="7" fill="#fff" fill-opacity=".7"/>
      <circle cx="96" cy="0" r="12" ${S("var(--b)")}/><circle cx="-48" cy="-83" r="12" ${S("var(--d)")}/><circle cx="-48" cy="83" r="12" ${S("#00b198")}/>
    </g>
    <g transform="translate(700 0)">                      <!-- light bulb -->
      <path d="M0 38c-50 0-80 34-80 76 0 34 20 50 32 70 6 10 8 18 8 30h80c0-12 2-20 8-30 12-20 32-36 32-70 0-42-30-76-80-76z" ${S("#ffe27a")}/>
      <path d="M-46 110c4-30 22-44 44-48" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="8" stroke-linecap="round"/>
      <path d="M-24 150l24 30 24-30M0 180v30" fill="none" stroke="var(--ink)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="-36" y="212" width="72" height="14" rx="5" ${S("#c9d2dc")}/><rect x="-28" y="228" width="56" height="14" rx="5" ${S("#aab4c0")}/>
      <path d="M-74 44l-18-18M74 44l18-18M-96 110h-24M96 110h24M0 24V0" stroke="var(--ink)" stroke-width="6" stroke-linecap="round"/>
    </g>
    <g transform="translate(990 112) rotate(35)">         <!-- rocket -->
      <path d="M-34 20L-72 74l-2 28 40-14zM34 20l38 54 2 28-40-14z" ${S("var(--a)")}/>
      <path d="M0-110c-40 30-52 80-46 150h92c6-70-6-120-46-150z" ${S("#fff")}/>
      <path d="M0-110c-20 14-34 32-42 54h84c-8-22-22-40-42-54z" ${S("var(--a)")}/>
      <circle cy="-18" r="22" ${S("#9fe0f5")}/><path d="M-28 40h56l-10 36h-36z" ${S("var(--b)")}/>
      <path d="M-24 76c-4 30 6 52 24 70 18-18 28-40 24-70z" ${S("#ffb400")}/><path d="M-10 78c-2 20 2 34 10 44 8-10 12-24 10-44z" fill="#fff4b0"/>
    </g>
    <g transform="translate(1260 0)">                     <!-- beaker -->
      <path d="M-56 70v150c0 16 10 26 26 26h60c16 0 26-10 26-26V70z" ${S("#fff")}/>
      <path d="M-56 150h112v70c0 16-10 26-26 26h-60c-16 0-26-10-26-26z" ${S("#00b198")}/>
      <path d="M-66 70h132" stroke="var(--ink)" stroke-width="8" stroke-linecap="round"/>
      <path d="M-56 110h22M-56 150h30M-56 190h22" stroke="var(--ink)" stroke-width="4" stroke-linecap="round"/>
      <circle cx="0" cy="186" r="8" fill="#fff" stroke="var(--ink)" stroke-width="3"/><circle cx="22" cy="164" r="6" fill="#fff" stroke="var(--ink)" stroke-width="3"/><circle cx="10" cy="120" r="9" fill="#fff" stroke="var(--ink)" stroke-width="3"/>
    </g>
    ${star(1460, 90, 44, "#ffd54a")}${star(1530, 170, 28, "var(--b)")}${star(1390, 190, 22, "var(--a)")}${star(560, 46, 24, "#ffd54a")}${star(850, 36, 18, "var(--b)")}${star(60, 80, 26, "var(--a)")}
  </svg>`;
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
  // rest of the teams: as few columns as keep them at most 6 tall, and the same number of names in each (15 -> 5+5+5, 16 -> 6+5+5)
  const cols = Math.min(4, Math.max(1, Math.ceil(rest.length / 6))), base = Math.floor(rest.length / cols), extra = rest.length % cols;
  const row = r => `<div class="prow ${MEDAL[r.rank] || ""}" style="--h:${hueOf(r)}">
      <span class="rk">${r.rank}</span><span class="nm">${esc(teamName(r))}</span><span class="pt">${r.score}</span></div>`;
  let at = 0;
  const columns = Array.from({ length: cols }, (_, c) => {
    const n = base + (c < extra ? 1 : 0), part = rest.slice(at, at + n); at += n;
    return `<div class="pcol">${part.map(row).join("")}</div>`;
  }).join("");
  return `${confettiHtml()}
    <div class="ftitle"><span>${esc(t("screen.final"))}</span></div>
    ${heroes.length ? `<div class="heroes ${classic ? "classic" : ""}">${ordered.map(hero).join("")}</div>` : ""}
    ${rest.length ? `<div class="podium" style="--cols:${cols}">${columns}</div>` : ""}
    <div class="scene" aria-hidden="true">${sceneSvg()}</div>`;
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
    st.innerHTML = `<div class="wordart" role="img" aria-label="${esc(word)}" style="--n:${[...word].length}">${letters}</div>
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
