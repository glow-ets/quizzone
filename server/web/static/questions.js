/* Read-only list of all questions and answers.
   Leak protection: nothing is fetched until the operator presses "Show"; hiding (button, Esc, inactivity,
   tab switch) removes the content from the page AND drops the data, so it is not left in the DOM or memory. */
const $ = id => document.getElementById(id);
const AUTOHIDE_S = Math.min(600, Math.max(3, parseInt(Q.get("autohide") || "60", 10) || 60));
let DATA = null, shown = false, idleLeft = 0, tick = null, contentLang = "";

$("back").href = "/control" + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "");

async function fetchQuestions(lang) {
  const r = await fetch("/api/questions" + (lang ? `?lang=${encodeURIComponent(lang)}` : "") + (TOKEN ? `${lang ? "&" : "?"}token=${encodeURIComponent(TOKEN)}` : ""), { cache: "no-store" });
  if (!r.ok) throw new Error(r.status === 401 ? "err.unauthorized" : "err.network");
  return r.json();
}
function render() {
  if (!shown || !DATA) return;
  $("p-opts").textContent = t("ctl.options", { n: DATA.max_options });
  const sel = $("lang");
  sel.innerHTML = DATA.languages.map(l => `<option value="${esc(l)}" ${l === DATA.lang ? "selected" : ""}>${esc(l)}</option>`).join("");
  sel.disabled = false;
  $("list").innerHTML = DATA.questions.map(q => {
    const meta = [q.category, t("q.meta", { s: q.time_s, p: q.points, n: q.penalty })].filter(Boolean).join(" · ");
    const ans = q.answers.map((a, i) => `<li class="${i === q.correct ? "right" : ""}"><span class="key">${LETTERS[i]}</span><span>${esc(a)}</span>${i === q.correct ? `<b class="tick" title="${esc(t("q.correct"))}">✓ ${esc(t("q.correct"))}</b>` : ""}</li>`).join("");
    return `<article class="qcard ${q.too_many_options ? "toomany" : ""}">
      <div class="qhead"><span class="qnum">${q.index + 1}</span><span class="muted">${esc(meta)}</span>${q.too_many_options ? `<span class="pill bad">${esc(t("q.too_many", { n: DATA.max_options }))}</span>` : ""}</div>
      <h2>${esc(q.text)}</h2><ol class="qans">${ans}</ol>${q.explanation ? `<p class="muted">${esc(q.explanation)}</p>` : ""}</article>`;
  }).join("");
}
function paintState() {
  $("toggle").textContent = t(shown ? "q.hide" : "q.show");
  $("toggle").classList.toggle("primary", !shown);
  $("list").classList.toggle("hidden", !shown);
  $("veil").classList.toggle("hidden", shown);
  $("note").textContent = shown ? t("q.autohide", { s: idleLeft }) : t("q.warning");
}
function hide() {
  shown = false; DATA = null;
  clearInterval(tick); tick = null;
  $("list").innerHTML = "";                       // content gone from the DOM, not just invisible
  const sel = $("lang"); sel.innerHTML = ""; sel.disabled = true;
  $("p-opts").textContent = "";
  paintState();
}
function touch() { if (shown) { idleLeft = AUTOHIDE_S; paintState(); } }
async function show(lang) {
  try {
    DATA = await fetchQuestions(lang);
  } catch (e) { $("note").textContent = t(e.message); return; }
  shown = true; idleLeft = AUTOHIDE_S;
  if (DATA.lang !== CUR_LANG) await loadLang(DATA.lang);
  render(); paintState();
  clearInterval(tick);
  tick = setInterval(() => { idleLeft--; if (idleLeft <= 0) hide(); else paintState(); }, 1000);
}
$("toggle").onclick = () => (shown ? hide() : show());
$("lang").onchange = () => show($("lang").value);
["mousemove", "keydown", "scroll", "touchstart", "click", "wheel"].forEach(ev => window.addEventListener(ev, touch, { passive: true }));
window.addEventListener("keydown", e => { if (e.key === "Escape") hide(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) hide(); });
(async function () { await loadLang("it"); paintState(); })();
