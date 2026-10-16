const $ = id => document.getElementById(id);
let S = null, rendered = {}, toastTimer = null;
document.getElementById("csv").href = "/api/export.csv" + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "");

function toast(msg) {
  const el = $("toast"); el.textContent = msg; el.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add("hidden"), 4000);
}
async function run(name, args, confirmKey) {
  if (confirmKey && !confirm(t(confirmKey))) return;
  try { await api(name, args); } catch (e) { toast(t(e.key, e.params)); }
}
/* Re-render a panel only when its data changed and the operator is not typing in it. */
function paint(id, html) {
  const el = $(id);
  if (rendered[id] === html) return;
  if (el.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
  rendered[id] = html; el.innerHTML = html;
}
const PHASE = { lobby: "phase.lobby", ready: "phase.ready", open: "phase.open", closed: "phase.closed", reveal: "phase.reveal", final: "phase.final" };

function render() {
  const s = S; if (!s) return;
  $("h-title").textContent = `${s.title} · ${t("ctl.title")}`;
  const link = $("p-link");
  link.textContent = s.link_ok ? t("ctl.link_ok", { d: s.link.detail }) : t("ctl.link_down", { d: s.link.detail || "" });
  link.className = "pill " + (s.link_ok ? "ok" : "bad");
  const b = $("p-base");
  if (s.base) {
    const bad = s.base.group !== s.config.expected_group || s.base.band !== s.config.expected_band;
    b.textContent = t("ctl.base", { g: s.base.group, b: s.base.band, o: s.base.overflow });
    b.className = "pill " + (bad || s.base.overflow > 0 ? "warn" : "ok");
  } else { b.textContent = t("ctl.base_none"); b.className = "pill warn"; }
  $("p-opts").textContent = t("ctl.options", { n: s.max_options });
  const sel = $("lang");
  if (!sel.dataset.ready) { sel.innerHTML = s.languages.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join(""); sel.dataset.ready = 1; sel.onchange = () => run("set_lang", { lang: sel.value }); }
  if (document.activeElement !== sel) sel.value = s.lang;

  $("p-phase").textContent = t(PHASE[s.phase]);
  $("progress").textContent = s.question && !s.question.test ? t("screen.progress", { n: s.cursor + 1, total: s.total }) : t("ctl.total", { total: s.total });
  $("answered").textContent = ["open", "closed"].includes(s.phase) ? t("ctl.answered", { n: s.answered_count, of: s.expected_count }) : "";
  $("qtext").textContent = s.question ? (s.question.test ? t("ctl.test_running") : s.question.text) : "";
  paint("actions", actionsHtml(s));
  $("hint").textContent = s.unsynced && s.unsynced.length && ["lobby", "ready", "reveal"].includes(s.phase) ? t("ctl.unsynced", { teams: s.unsynced.join(", ") }) :
    s.phase === "closed" && !s.settled ? t("ctl.waiting_final") :
    (s.unconfirmed && s.unconfirmed.length && s.phase === "closed" ? t("ctl.unconfirmed", { teams: s.unconfirmed.join(", ") }) : "");

  paint("teams", teamsHtml(s));
  paint("devices", devicesHtml(s));
  paint("dev-extra", deviceExtraHtml(s));
  paint("cfg", cfgHtml(s));
  paint("report", reportHtml(s));
  paint("log", s.log.slice().reverse().map(l => `<div class="${l.l === "warn" ? "warn" : ""}">${new Date(l.t * 1000).toLocaleTimeString()} ${esc(t(l.k, l.a))}</div>`).join(""));
}
function actionsHtml(s) {
  const B = (id, label, cls = "", dis = false) => `<button class="btn ${cls}" data-act="${id}" ${dis ? "disabled" : ""}>${esc(t(label))}</button>`;
  let h = "";
  if (s.phase === "lobby" || s.phase === "reveal") h += B("next", s.cursor + 1 >= s.total ? "act.finish" : "act.next", "primary");
  if (s.phase === "ready") h += B("open", "act.open", "primary");
  if (s.phase === "open") h += B("close", "act.close", "primary");
  if (s.phase === "closed") h += B("reveal", "act.reveal", "primary", !s.settled) + (!s.settled ? B("reveal_force", "act.force") : "");
  if (["ready", "open", "closed"].includes(s.phase)) h += B("skip", "act.skip");
  if (["open", "closed", "reveal"].includes(s.phase) && !(s.question && s.question.test)) h += B("redo", "act.redo");
  if (["lobby", "reveal", "final"].includes(s.phase)) h += `<label class="muted">${esc(t("act.goto"))} <input class="n" type="number" id="goto" min="1" max="${s.total}" value="${Math.min(s.total, s.cursor + 2)}"></label><button class="btn" data-act="goto">${esc(t("act.go"))}</button>`;
  return h;
}
function teamsHtml(s) {
  const rows = s.teams.map(tm => `<tr><td>${tm.slot + 1}</td>
    <td><input type="text" class="name" data-name="${tm.slot}" value="${esc(tm.name || "")}" placeholder="${esc(t("team.default", { n: tm.slot + 1 }))}" maxlength="40" aria-label="${esc(t("ctl.team_name"))}"></td>
    <td class="num"><b>${tm.score}</b></td>
    <td><button class="btn" data-adj="${tm.slot}:50">+50</button> <button class="btn" data-adj="${tm.slot}:-50">−50</button></td>
    <td><span class="pill ${tm.online ? "ok" : ""}">${esc(tm.online ? t("ctl.online") : (tm.serial ? t("ctl.offline") : t("ctl.free")))}</span> ${tm.answered ? "●" : ""}</td></tr>`).join("");
  return `<table><thead><tr><th>#</th><th>${esc(t("ctl.team_name"))}</th><th>${esc(t("ctl.score"))}</th><th>${esc(t("ctl.adjust"))}</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}
function devicesHtml(s) {
  if (!s.devices.length) return `<p class="muted">${esc(t("ctl.no_devices"))}</p>`;
  const opts = cur => `<option value="">–</option>` + s.teams.map(x => `<option value="${x.slot}" ${cur === x.slot ? "selected" : ""}>${x.slot + 1}</option>`).join("");
  const rows = s.devices.map(d => `<tr><td><code>${d.serial}</code></td>
    <td><select data-assign="${d.serial}" aria-label="${esc(t("ctl.team"))}">${opts(d.slot)}</select></td>
    <td><span class="pill ${d.online ? "ok" : "bad"}">${d.online ? d.rssi + " dBm" : esc(t("ctl.offline"))}</span></td>
    <td class="num ${d.loss_pct > 20 ? "warn" : ""}">${d.loss_pct}%</td><td class="num">${d.presses}</td><td class="num">${d.bmiss}</td>
    <td>${d.locked ? "🔒" : ""}${d.synced ? "" : " ⚠"}</td>
    <td><button class="btn" data-ident="${d.serial}">${esc(t("ctl.identify"))}</button>${d.online ? "" : ` <button class="btn danger" data-forget="${d.serial}">${esc(t("ctl.forget"))}</button>`}</td></tr>`).join("");
  return `<table><thead><tr><th>ID</th><th>${esc(t("ctl.team"))}</th><th>${esc(t("ctl.signal"))}</th><th>${esc(t("ctl.loss"))}</th><th>${esc(t("ctl.presses"))}</th><th>${esc(t("ctl.bounces"))}</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}
function deviceExtraHtml(s) {
  const team = x => `<option value="${x.slot}">${x.slot + 1}</option>`;
  const dismissed = (s.dismissed || []).map(d => `<tr><td><code>${esc(d.serial)}</code></td>
    <td>${d.slot === null || d.slot === undefined ? "" : esc(t("ctl.team") + " " + (d.slot + 1))}</td>
    <td><button class="btn" data-restore="${esc(d.serial)}">${esc(t("ctl.restore"))}</button></td></tr>`).join("");
  return `${dismissed ? `<h3>${esc(t("ctl.dismissed"))}</h3><table><tbody>${dismissed}</tbody></table>` : ""}
    <h3>${esc(t("ctl.add_device"))}</h3>
    <div class="row"><input type="text" id="add-serial" class="name" maxlength="8" placeholder="${esc(t("ctl.serial_hint"))}" aria-label="${esc(t("ctl.serial"))}" autocomplete="off">
    <select id="add-slot" aria-label="${esc(t("ctl.team"))}"><option value="">–</option>${s.teams.map(team).join("")}</select>
    <button class="btn" id="add-btn">${esc(t("ctl.add"))}</button></div>`;
}
function cfgHtml(s) {
  const c = s.config;
  const chk = (k) => `<label class="row"><input type="checkbox" data-cfg="${k}" ${c[k] ? "checked" : ""}> ${esc(t("cfg." + k))}</label>`;
  const num = (k, min, max) => `<label class="row">${esc(t("cfg." + k))} <input class="n" type="number" data-cfgnum="${k}" min="${min}" max="${max}" value="${c[k]}"></label>`;
  return chk("close_when_all_answered") + chk("read_first") + chk("allow_negative") + chk("auto_assign") +
    num("teams", 1, 16) + num("no_answer_penalty", 0, 100000) + num("tolerance_ms", 0, 2000) + num("settle_max_ms", 500, 10000);
}
function reportHtml(s) {
  const r = s.test_report; if (!r) return "";
  const l = r.latency_ms;
  return `<dl class="kv" style="margin-top:10px"><dt>${esc(t("rep.result"))}</dt><dd><span class="pill ${r.ok ? "ok" : "bad"}">${esc(t(r.ok ? "rep.ok" : "rep.fail"))}</span></dd>
    <dt>${esc(t("rep.answered"))}</dt><dd>${r.answered.length} / ${r.expected.length}</dd>
    <dt>${esc(t("rep.missing"))}</dt><dd>${r.missing.length ? esc(r.missing.join(", ")) : "–"}</dd>
    <dt>${esc(t("rep.latency"))}</dt><dd>${l.min ?? "–"} / ${l.p50 ?? "–"} / ${l.max ?? "–"} ms</dd></dl>`;
}

document.addEventListener("click", ev => {
  const b = ev.target.closest("button"); if (!b) return;
  if (b.dataset.act) {
    const a = b.dataset.act;
    if (a === "reveal_force") return run("reveal", { force: true });
    if (a === "goto") return run("goto", { index: parseInt($("goto").value, 10) - 1 });
    if (a === "skip") return run("skip", {}, "confirm.skip");
    if (a === "redo") return run("redo", {}, "confirm.redo");
    return run(a);
  }
  if (b.dataset.adj) { const [sl, d] = b.dataset.adj.split(":").map(Number); return run("adjust", { slot: sl, delta: d }); }
  if (b.dataset.ident) return run("identify", { serial: b.dataset.ident });
  if (b.dataset.forget) return run("forget_device", { serial: b.dataset.forget }, "confirm.forget");
  if (b.dataset.restore) return run("restore_device", { serial: b.dataset.restore });
  if (b.id === "add-btn") {
    const slot = $("add-slot").value;
    return run("add_device", { serial: $("add-serial").value, slot: slot === "" ? null : +slot }).then(() => { rendered = {}; });
  }
  if (b.id === "auto") return run("auto_assign");
  if (b.id === "blast") return run("test", { seconds: 6 });
  if (b.id === "reset") { if (confirm(t("confirm.reset"))) run("reset_game", { confirm: true }); }
});
document.addEventListener("change", ev => {
  const el = ev.target;
  if (el.dataset.name !== undefined) run("rename", { slot: +el.dataset.name, name: el.value });
  else if (el.dataset.assign) { if (el.value !== "") run("assign", { serial: el.dataset.assign, slot: +el.value }); else run("unassign", { serial: el.dataset.assign }); }
  else if (el.dataset.cfg) run("config", { [el.dataset.cfg]: el.checked });
  else if (el.dataset.cfgnum) run("config", { [el.dataset.cfgnum]: parseInt(el.value, 10) });
  rendered = {};      // force repaint from the next snapshot
});
(async function () {
  await loadLang("it");
  connect("control", async s => { if (s.lang !== CUR_LANG) await loadLang(s.lang); S = s; render(); },
    up => { if (!up) { $("p-link").textContent = t("ctl.server_lost"); $("p-link").className = "pill bad"; } });
})();
