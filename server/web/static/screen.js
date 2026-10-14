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
function render() {
  if (!S) return;
  $("ttl").textContent = S.title + (S.series ? " · " + S.series : "");
  $("prog").textContent = S.question && !S.question.test ? t("screen.progress", { n: S.cursor + 1, total: S.total }) : "";
  $("net").classList.toggle("hidden", S.link_ok && connected);
  $("lamps").innerHTML = S.phase === "final" ? "" : lampsHtml(S);
  const q = S.question, st = $("stage");
  // Structure changes only when the phase/question changes; timers update separately.
  const key = [S.phase, q && q.id, S.reveal ? 1 : 0, S.lang].join("|");
  if (key === lastKey) { updateLive(); return; }
  lastKey = key;
  if (S.phase === "lobby" || (!q && S.phase !== "final")) {
    st.className = "stage center";
    st.innerHTML = `<div class="halo"></div><div class="series">${esc(S.series)}</div><h1>${esc(S.title)}</h1>
      <div class="sub">${esc(t("screen.lobby", { n: S.teams.filter(x => x.online).length }))}</div>`;
    return;
  }
  if (S.phase === "final") {
    st.className = "stage";
    const rows = [...S.podium].sort((a, b) => a.rank - b.rank || a.slot - b.slot);
    st.innerHTML = `<div class="center"><div class="series">${esc(t("screen.final"))}</div></div>
      <div class="podium ${rows.length > 7 ? "two" : ""}">${rows.map(r => `<div class="prow ${r.rank === 1 ? "first" : ""}"><span class="rk">${r.rank}</span><span>${esc(teamName(r))}</span><span class="pt">${r.score}</span></div>`).join("")}</div>`;
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
