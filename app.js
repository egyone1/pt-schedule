import { createStore } from "./store.js?v=4";
import { ADMIN_EMAIL } from "./config.js?v=4";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ls = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const ROW = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row")) || 26;
const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fmtTime = m => { const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, "0"); const h12 = ((h + 11) % 12) + 1; return `${h12}:${mm} ${h < 12 ? "AM" : "PM"}`; };
const arDate = (iso, opts = { weekday: "long", day: "numeric", month: "long" }) =>
  new Date(iso + "T12:00:00").toLocaleDateString("ar-EG-u-nu-latn", opts);
const shortDate = iso => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const idName = n => String(n || "").toLowerCase().replace(/[^a-z؀-ۿ]+/g, " ").trim();

const state = {
  store: null, admin: false, view: "today",
  openDays: [], day: null, viewDate: null, unsubDay: null,
  stats: [], section: "all", me: ls.get("meKey", ""), meName: ls.get("me", ""),
  settings: { depts: {}, assign: {} }, dept: "all",
  statsMonth: "", period: "month", charts: [], metric: ls.get("metric", "sessions"),
};

/* ---------------- ui helpers ---------------- */
let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600);
}
function modal(title, html, { ok = "تمام", cancel = "إلغاء", danger = false } = {}) {
  return new Promise(res => {
    const d = $("#modal");
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = html;
    $("#modalOk").textContent = ok;
    $("#modalOk").className = danger ? "danger" : "primary";
    $("#modalCancel").textContent = cancel;
    $("#modalCancel").hidden = !cancel;
    d.onclose = () => res(d.returnValue === "ok" ? d : null);
    d.showModal();
    d.querySelector("input")?.focus();
  });
}

/* ---------------- tabs ---------------- */
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => setView(b.dataset.view));
function setView(v) {
  state.view = v;
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === v));
  document.querySelectorAll(".view").forEach(s => s.hidden = s.id !== "view-" + v);
  render();
}
function render() {
  if (state.view === "today") renderToday();
  else if (state.view === "stats") renderStats();
  else renderAnalysis();
}

/* ---------------- admin ---------------- */
$("#adminBtn").onclick = async () => {
  if (state.admin) {
    if (await modal("تسجيل خروج الأدمن", "عايز تخرج من وضع الأدمن؟", { ok: "خروج" })) await state.store.logout();
    return;
  }
  const d = await modal("دخول الأدمن",
    `الأدمن بس يقدر يعدّل بعد ما الدكتور يعمل Submit أو بعد ما اليوم يتقفل.
     <input id="pw" type="password" placeholder="الباسورد" autocomplete="current-password">
     ${state.store.demo ? '<div style="margin-top:6px;font-size:12px">نسخة التجربة: الباسورد <b>demo</b></div>' : ""}`,
    { ok: "دخول" });
  if (!d) return;
  try { await state.store.login(ADMIN_EMAIL, d.querySelector("#pw").value); toast("أهلاً يا أدمن ✓"); }
  catch { toast("الباسورد غلط"); }
};

/* ---------------- day subscription ---------------- */
function watchDay(date) {
  if (state.unsubDay) state.unsubDay();
  state.viewDate = date; state.day = null;
  if (!date) { state.unsubDay = null; render(); return; }
  state.unsubDay = state.store.onDay(date, d => { state.day = d; if (state.view === "today") renderToday(); });
}
function onOpenDays(days) {
  state.openDays = days;
  const stillValid = state.viewDate && (days.some(d => d.date === state.viewDate) || state.admin);
  if (!stillValid) watchDay(days[0]?.date || null);
  else if (state.view === "today") renderToday();
}

/* ---------------- departments (admin) ---------------- */
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
// the department the admin put the doctor in, else the section from the sheet
const deptOf = d => (state.settings.assign || {})[idName(d.name)] || d.section || "—";
const deptColor = name => (state.settings.depts || {})[name] || "";
const dcStyle = name => deptColor(name) ? `style="--dc:${deptColor(name)}"` : "";

async function saveSettings(patch) {
  const next = { depts: { ...(state.settings.depts || {}) }, assign: { ...(state.settings.assign || {}) }, ...patch };
  try { await state.store.saveSettings(next); }
  catch (e) { console.error(e); toast("محصلش حفظ — جرّب تاني"); }
}
async function assignDept(name, value) {
  const assign = { ...(state.settings.assign || {}) }, depts = { ...(state.settings.depts || {}) };
  if (value === "__new") {
    const d = await modal("قسم جديد", `اسم القسم:<input id="deptName" placeholder="مثلاً Ortho">`, { ok: "ضيف" });
    const nm = d?.querySelector("#deptName").value.trim();
    if (!nm) { renderToday(); return; }
    if (!depts[nm]) depts[nm] = PALETTE[Object.keys(depts).length % PALETTE.length];
    value = nm;
  }
  if (value) assign[idName(name)] = value; else delete assign[idName(name)];
  await saveSettings({ depts, assign });
  toast(value ? `${name} اتحط في ${value}` : `${name} رجع لقسم الشيت`);
}
async function manageDepts() {
  const depts = { ...(state.settings.depts || {}) };
  const names = Object.keys(depts);
  const rows = names.map((n, i) => `<div style="display:flex;align-items:center;gap:8px;margin:6px 0">
      <span class="dot" style="background:${depts[n]}"></span><b style="flex:1;direction:ltr;text-align:right">${esc(n)}</b>
      <select data-color="${i}">${PALETTE.map((c, j) => `<option value="${c}" ${c === depts[n] ? "selected" : ""}>لون ${j + 1}</option>`).join("")}</select>
      <label style="font-size:12px"><input type="checkbox" data-del="${i}" style="width:auto;margin:0"> امسح</label></div>`).join("");
  const d = await modal("الأقسام وألوانها",
    `${names.length ? rows : "لسه مفيش أقسام. اختار القسم من فوق عمود أي دكتور في تاب اليوم."}
     <p style="font-size:12.5px;margin-top:10px">الألوان: ${PALETTE.map((c, j) => `<span class="dot" style="background:${c}"></span> ${j + 1}`).join(" &nbsp;")}</p>`,
    { ok: "احفظ" });
  if (!d || !names.length) return;
  const assign = { ...(state.settings.assign || {}) };
  names.forEach((n, i) => {
    if (d.querySelector(`[data-del="${i}"]`).checked) {
      delete depts[n];
      for (const k of Object.keys(assign)) if (assign[k] === n) delete assign[k];
    } else depts[n] = d.querySelector(`[data-color="${i}"]`).value;
  });
  await saveSettings({ depts, assign });
  toast("الأقسام اتحفظت ✓");
}

/* ---------------- TODAY ---------------- */
const canEdit = doc => state.admin || (state.day?.status === "open" && !doc.submitted);

function doctorsOf(day) {
  return Object.entries(day.doctors || {}).map(([key, d]) => ({ key, ...d }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
function counts(doc) {
  const s = doc.sessions || [];
  return {
    att: s.filter(x => x.status === 1).reduce((a, x) => a + (x.units || 1), 0),
    ns: s.filter(x => x.status === 2).length,
    un: s.filter(x => !x.status).length,
  };
}
function sessHTML(doc, s, top, height) {
  const style = top == null ? "" : `style="top:${top}px;height:${height}px"`;
  const locked = canEdit(doc) ? "" : " locked";
  const two = s.units > 1 ? `<span class="x2" title="أكتر من ساعة وربع = جلستين">×2</span>` : "";
  return `<button class="sess s${s.status || 0}${locked}" data-key="${esc(doc.key)}" data-id="${esc(s.id)}" ${style}
    title="${esc(s.patient)} — ${esc(s.details)}">
    ${two}<span class="p">${esc(s.patient)}</span>
    <span class="t">${fmtTime(toMin(s.start))} – ${fmtTime(toMin(s.end))}</span>
    ${s.details ? `<span class="d">${esc(s.details)}</span>` : ""}</button>`;
}
function submitBtn(doc) {
  if (doc.submitted)
    return state.admin
      ? `<button class="ghost" data-unsubmit="${esc(doc.key)}">✓ اتعمل Submit · إلغاء</button>`
      : `<button class="ghost" disabled>✓ اتعمل Submit</button>`;
  const dis = state.day.status !== "open" && !state.admin ? "disabled" : "";
  return `<button class="primary" data-submit="${esc(doc.key)}" ${dis}>Submit</button>`;
}

function renderToday() {
  const el = $("#view-today");
  const day = state.day;
  const adminBar = state.admin ? adminDayBar() : "";
  if (!day) {
    el.innerHTML = adminBar + `<div class="empty"><div class="big">🗓️</div>
      <h2>مفيش جدول مفتوح دلوقتي</h2>
      <p>جدول اليوم بيتعمل أوتوماتيك كل يوم الساعة <b>9 بالليل</b> من شيت السكرتارية.<br>
      لما كل الدكاترة يعملوا Submit الجدول بيتقفل والأرقام بتروح لتاب الإحصائيات.</p></div>`;
    bindAdminBar();
    return;
  }
  const docs = doctorsOf(day);
  const sections = [...new Set(docs.map(deptOf))];
  const submitted = docs.filter(d => d.submitted).length;
  // pick by key (two doctors can share a name), fall back to the name on a new day
  const mine = docs.find(d => d.key === state.me) || (state.meName && docs.find(d => idName(d.name) === idName(state.meName)));
  const visible = docs.filter(d => state.section === "all" || deptOf(d) === state.section);
  // keep the scroll position across re-renders
  const oldBoard = el.querySelector(".board");
  const keep = { left: oldBoard?.scrollLeft, top: oldBoard?.scrollTop, y: window.scrollY };

  const statusLine = day.status === "open"
    ? `مفتوح · اتسحب من تاب «${esc(day.sheet)}»`
    : `<b style="color:var(--brand)">مقفول ✓</b>${day.autoClosed ? " (اتقفل أوتوماتيك)" : ""}`;

  el.innerHTML = `${adminBar}
    ${day.status === "closed" && state.admin ? `<div class="banner">ده يوم مقفول — إنت بتعدّل كأدمن، والإحصائيات بتتحدّث لوحدها.</div>` : ""}
    <div class="toolbar">
      <div class="day-title"><h2>${arDate(day.date)}</h2><div class="sub">${statusLine}</div></div>
      <div class="progress">
        <div class="lbl"><span>عملوا Submit</span><b>${submitted} / ${docs.length}</b></div>
        <div class="bar"><i style="width:${docs.length ? submitted / docs.length * 100 : 0}%"></i></div>
      </div>
      <div class="spacer"></div>
      <label class="field">أنا:
        <select id="meSel"><option value="">كل الدكاترة</option>
          ${docs.map(d => `<option value="${esc(d.key)}" ${mine && mine.key === d.key ? "selected" : ""}>${esc(d.name)} · ${esc(deptOf(d))}</option>`).join("")}
        </select></label>
    </div>
    <div class="toolbar">
      ${mine ? "" : `<div class="chips">${["all", ...sections].map(s =>
        `<button class="chip ${state.section === s ? "active" : ""}" data-sec="${esc(s)}">${s !== "all" && deptColor(s) ? `<span class="dot" style="background:${deptColor(s)}"></span>` : ""}${s === "all" ? "الكل" : esc(s)}</button>`).join("")}</div>`}
      <div class="spacer"></div>
      <div class="legend">
        <span><i class="sw"></i>لسه</span>
        <span><i class="sw g"></i>دوسة = حضر</span>
        <span><i class="sw r"></i>دوستين = محضرش</span>
        <span><b style="font-size:11px;background:var(--text);color:var(--surface);border-radius:6px;padding:0 5px">×2</b> أكتر من ساعة وربع</span>
      </div>
    </div>
    ${mine ? mineHTML(mine) : gridHTML(visible)}`;

  const board = el.querySelector(".board");
  if (board && keep.left != null) { board.scrollLeft = keep.left; board.scrollTop = keep.top; }
  if (keep.y) window.scrollTo(0, keep.y);

  bindAdminBar();
  $("#meSel").onchange = e => {
    state.me = e.target.value;
    state.meName = docs.find(d => d.key === state.me)?.name || "";
    ls.set("meKey", state.me); ls.set("me", state.meName);
    renderToday();
  };
  el.querySelectorAll("[data-dept]").forEach(s => s.onchange = () => assignDept(s.dataset.dept, s.value));
  el.querySelectorAll("[data-sec]").forEach(b => b.onclick = () => { state.section = b.dataset.sec; renderToday(); });
  el.querySelectorAll(".sess").forEach(b => b.onclick = () => cycle(b.dataset.key, b.dataset.id));
  el.querySelectorAll("[data-submit]").forEach(b => b.onclick = () => submit(b.dataset.submit));
  el.querySelectorAll("[data-unsubmit]").forEach(b => b.onclick = () => unsubmit(b.dataset.unsubmit));
}

function gridHTML(docs) {
  if (!docs.length) return `<div class="empty"><h2>مفيش دكاترة في القسم ده</h2></div>`;
  const all = docs.flatMap(d => d.sessions);
  const start = Math.floor(Math.min(...all.map(s => toMin(s.start))) / 60) * 60;
  const end = Math.ceil(Math.max(...all.map(s => toMin(s.end))) / 60) * 60;
  const row = ROW(), h = (end - start) / 15 * row;
  const hours = []; for (let m = start; m < end; m += 60) hours.push(m);
  const cols = docs.map(d => {
    const c = counts(d);
    return `<div class="col" data-col="${esc(d.key)}">
      <div class="col-head ${d.submitted ? "done" : ""} ${deptColor(deptOf(d)) ? "dc" : ""}" ${dcStyle(deptOf(d))}>
        <div class="nm" title="${esc(d.name)}">${esc(d.name)}</div>
        ${state.admin ? deptSelect(d) : `<div class="sec">${esc(deptOf(d))} ${d.submitted ? '<span class="badge">· Submit ✓</span>' : ""}</div>`}
        <div class="cnt"><span style="color:var(--good)">✓ <b>${c.att}</b></span><span style="color:var(--bad)">✗ <b>${c.ns}</b></span><span>لسه <b>${c.un}</b></span></div>
      </div>
      <div class="slots slot-bg" style="height:${h}px">
        ${d.sessions.map(s => sessHTML(d, s, (toMin(s.start) - start) / 15 * row + 1, s.minutes / 15 * row - 3)).join("")}
      </div>
      <div class="col-foot">${submitBtn(d)}</div>
    </div>`;
  }).join("");
  return `<div class="board"><div class="grid">
    <div class="timecol"><div class="time-head"></div>
      <div class="slots slot-bg" style="height:${h}px">${hours.map(m => `<div class="tlabel">${fmtTime(m)}</div>`).join("")}</div>
      <div class="time-foot"></div></div>
    ${cols}</div></div>`;
}

function deptSelect(d) {
  const cur = (state.settings.assign || {})[idName(d.name)] || "";
  const opts = Object.keys(state.settings.depts || {}).map(n => `<option value="${esc(n)}" ${n === cur ? "selected" : ""}>${esc(n)}</option>`).join("");
  return `<select class="dept-sel" data-dept="${esc(d.name)}" title="القسم">
    <option value="">${esc(d.section || "—")} (من الشيت)</option>${opts}<option value="__new">+ قسم جديد…</option></select>`;
}

function mineHTML(d) {
  const c = counts(d);
  return `<div class="mine"><div class="card">
    <div class="hdr"><h3>${esc(d.name)}</h3>
      <span style="font-size:13px;color:var(--text-2)">✓ ${c.att} · ✗ ${c.ns} · لسه ${c.un}</span></div>
    <div class="list">${d.sessions.map(s => sessHTML(d, s)).join("")}</div>
  </div><div class="foot">${submitBtn(d)}</div></div>`;
}

async function cycle(key, id) {
  const day = state.day, doc = { key, ...day.doctors[key] };
  if (!canEdit(doc)) {
    toast(doc.submitted ? "اتعمل Submit — الأدمن بس يقدر يعدّل" : "اليوم ده مقفول — الأدمن بس يقدر يعدّل");
    return;
  }
  const sessions = doc.sessions.map(s => s.id === id ? { ...s, status: ((s.status || 0) + 1) % 3 } : s);
  day.doctors[key].sessions = sessions;          // instant feedback, without re-drawing the page
  const btn = document.querySelector(`.sess[data-key="${CSS.escape(key)}"][data-id="${CSS.escape(id)}"]`);
  const st = sessions.find(s => s.id === id).status;
  if (btn) btn.className = btn.className.replace(/\bs[012]\b/, "s" + st);
  const c = counts(day.doctors[key]);
  const cnt = document.querySelector(`[data-col="${CSS.escape(key)}"] .cnt`);
  if (cnt) cnt.innerHTML = `<span style="color:var(--good)">✓ <b>${c.att}</b></span><span style="color:var(--bad)">✗ <b>${c.ns}</b></span><span>لسه <b>${c.un}</b></span>`;
  const mc = document.querySelector(".mine .hdr span");
  if (mc) mc.textContent = `✓ ${c.att} · ✗ ${c.ns} · لسه ${c.un}`;
  try { await state.store.setSessions(day.date, key, sessions); }
  catch (e) { console.error(e); toast("محصلش حفظ — جرّب تاني"); }
}

async function submit(key) {
  const doc = state.day.doctors[key], c = counts(doc);
  const warn = c.un ? `<p style="background:var(--warn-bg);padding:8px 10px;border-radius:10px">فيه <b>${c.un}</b> مريض لسه أبيض — مش هيتحسبوا.</p>` : "";
  const ok = await modal(`Submit — ${doc.name}`,
    `${warn}<p>حضر: <b>${c.att}</b> جلسة · محضرش: <b>${c.ns}</b></p><p>بعد الـ Submit مش هتقدر تعدّل (الأدمن بس).</p>`,
    { ok: "Submit" });
  if (!ok) return;
  try {
    const closed = await state.store.setSubmitted(state.day.date, key, true);
    toast(closed ? "كل الدكاترة خلّصوا — اليوم اتقفل والأرقام اتحفظت ✓" : "اتعمل Submit ✓");
  } catch (e) { console.error(e); toast("محصلش حفظ — جرّب تاني"); }
}
async function unsubmit(key) {
  await state.store.setSubmitted(state.day.date, key, false);
  toast("اتلغى الـ Submit");
}

function adminDayBar() {
  const dates = [...new Set([...state.openDays.map(d => d.date), ...state.stats.map(s => s.date)])].sort().reverse();
  if (state.viewDate && !dates.includes(state.viewDate)) dates.unshift(state.viewDate);
  const st = state.day?.status;
  return `<div class="banner" style="background:var(--brand-soft)">
    <b>وضع الأدمن</b> — تقدر تفتح أي يوم وتعدّل أي حاجة.
    <label class="field">اليوم:
      <select id="adminDate">${dates.map(d => `<option value="${d}" ${d === state.viewDate ? "selected" : ""}>${arDate(d, { weekday: "short", day: "numeric", month: "short" })}</option>`).join("")}</select></label>
    ${state.day ? (st === "open"
      ? `<button class="ghost" id="closeDay">اقفل اليوم واحفظ الأرقام</button>`
      : `<button class="ghost" id="reopenDay">افتح اليوم تاني للدكاترة</button>`) : ""}
    <button class="ghost" id="deptsBtn">🎨 الأقسام</button>
    ${state.store.demo ? `<button class="ghost" id="resetDemo">رجّع التجربة من الأول</button>` : ""}
  </div>`;
}
function bindAdminBar() {
  if (!state.admin) return;
  $("#adminDate")?.addEventListener("change", e => watchDay(e.target.value));
  $("#closeDay")?.addEventListener("click", async () => {
    if (await modal("قفل اليوم", "اللي متعلّمش هيفضل مش متحسوب. تقفل؟", { ok: "اقفل" })) {
      await state.store.setStatus(state.day.date, "closed"); toast("اليوم اتقفل ✓");
    }
  });
  $("#reopenDay")?.addEventListener("click", async () => {
    await state.store.setStatus(state.day.date, "open"); toast("اليوم اتفتح تاني");
  });
  $("#resetDemo")?.addEventListener("click", () => state.store.resetDemo());
  $("#deptsBtn")?.addEventListener("click", manageDepts);
}

/* ---------------- aggregation ---------------- */
function rowsFrom(statsDocs) {
  // one row per doctor per day
  const rows = [];
  for (const s of statsDocs)
    for (const d of Object.values(s.doctors || {}))
      rows.push({ date: s.date, ...d, id: idName(d.name) });
  return rows;
}
// "sessions" = a session over 1h15 counts twice; "cases" = every attended patient counts once
const METRICS = { sessions: { one: "جلسة", many: "الجلسات" }, cases: { one: "حالة", many: "الحالات" } };
const valOf = r => state.metric === "cases" ? (r.cases ?? r.attended) : r.attended;
function metricChips() {
  return `<div class="chips">${Object.entries(METRICS).map(([k, m]) =>
    `<button class="chip ${state.metric === k ? "active" : ""}" data-metric="${k}">${m.many}</button>`).join("")}</div>`;
}
function bindMetric(el, rerender) {
  el.querySelectorAll("[data-metric]").forEach(b => b.onclick = () => { state.metric = b.dataset.metric; ls.set("metric", state.metric); rerender(); });
}

function byDoctor(rows) {
  const m = new Map();
  for (const r of rows) {
    const o = m.get(r.id) || { name: r.name, section: r.section, attended: 0, noShow: 0, booked: 0, days: 0, perDay: {} };
    o.section = r.section || o.section;            // rows are date-ordered -> latest section wins
    o.dept = deptOf(o);
    o.cases = (o.cases || 0) + (r.cases ?? r.attended);
    o.attended += valOf(r); o.noShow += r.noShow; o.booked += r.booked; o.days += 1;
    o.perDay[r.date] = (o.perDay[r.date] || 0) + valOf(r);
    if (!o.noShowDay) o.noShowDay = {};
    o.noShowDay[r.date] = (o.noShowDay[r.date] || 0) + r.noShow;
    m.set(r.id, o);
  }
  return [...m.values()].sort((a, b) => b.attended - a.attended);
}

/* ---------------- STATS ---------------- */
function renderStats() {
  const el = $("#view-stats");
  const months = [...new Set(state.stats.map(s => s.date.slice(0, 7)))].sort().reverse();
  if (!months.length) {
    el.innerHTML = `<div class="empty"><div class="big">📊</div><h2>لسه مفيش أيام مقفولة</h2><p>أول ما يوم يتقفل، عدد جلسات كل دكتور هيظهر هنا.</p></div>`;
    return;
  }
  if (!months.includes(state.statsMonth)) state.statsMonth = months[0];
  const docs = state.stats.filter(s => s.date.startsWith(state.statsMonth)).sort((a, b) => a.date.localeCompare(b.date));
  const dates = docs.map(s => s.date);
  const listAll = byDoctor(rowsFrom(docs));
  const deptNames = [...new Set(listAll.map(d => d.dept))].sort();
  const deptBar = deptChips(deptNames);
  const list = listAll.filter(d => inDept(d.dept));
  const tot = list.reduce((a, d) => ({ att: a.att + d.attended, ns: a.ns + d.noShow }), { att: 0, ns: 0 });
  const pct = (a, n) => a + n ? Math.round(a / (a + n) * 100) + "%" : "—";

  const M = METRICS[state.metric];
  el.innerHTML = `<div class="toolbar">
      <div class="day-title"><h2>الإحصائيات</h2><div class="sub">${state.metric === "cases"
        ? "عدد الحالات اللي حضرت لكل دكتور في كل يوم (كل مريض = حالة واحدة)"
        : "عدد الجلسات اللي حضرت لكل دكتور في كل يوم (الجلسة الأطول من ساعة وربع = جلستين)"}</div></div>
      <div class="spacer"></div>
      ${metricChips()}
      ${state.admin ? `<button class="danger" id="delBtn">🗑 مسح داتا</button>` : ""}
      <label class="field">الشهر:
        <select id="monthSel">${months.map(m => `<option value="${m}" ${m === state.statsMonth ? "selected" : ""}>${new Date(m + "-15").toLocaleDateString("ar-EG-u-nu-latn", { month: "long", year: "numeric" })}</option>`).join("")}</select></label>
      <button class="ghost" id="csvBtn">⬇ Excel (CSV)</button>
    </div>
    ${deptSummary(listAll, M)}
    <div class="toolbar"><span class="field">القسم:</span>${deptBar}</div>
    <div class="card"><div class="table-wrap"><table class="stats">
      <thead><tr><th class="nm">الدكتور</th><th>القسم</th>
        ${dates.map(d => `<th class="day ${state.admin ? "link" : ""}" data-date="${d}" title="${arDate(d)}">${shortDate(d)}</th>`).join("")}
        <th>إجمالي ${M.many}</th><th>غياب</th><th>نسبة الحضور</th></tr></thead>
      <tbody>${list.map(d => `<tr><td class="nm">${esc(d.name)}</td><td style="direction:ltr">${deptColor(d.dept) ? `<span class="dot" style="background:${deptColor(d.dept)}"></span>` : ""}${esc(d.dept)}</td>
        ${dates.map(dt => {
          const v = d.perDay[dt];
          return v == null ? `<td class="zero">·</td>` : `<td class="${v ? "" : "zero"}" title="غياب: ${d.noShowDay[dt] || 0}">${v}</td>`;
        }).join("")}
        <td class="tot">${d.attended}</td><td class="ns">${d.noShow || ""}</td><td>${pct(d.attended, d.noShow)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td class="nm">الإجمالي${state.dept === "all" ? "" : ` · ${esc(state.dept)}`}</td><td></td>
        ${dates.map(dt => `<td>${list.reduce((a, d) => a + (d.perDay[dt] || 0), 0)}</td>`).join("")}
        <td class="tot">${tot.att}</td><td class="ns">${tot.ns}</td><td>${pct(tot.att, tot.ns)}</td></tr></tfoot>
    </table></div></div>`;

  $("#monthSel").onchange = e => { state.statsMonth = e.target.value; renderStats(); };
  bindMetric(el, renderStats);
  bindDept(el, renderStats);
  $("#delBtn")?.addEventListener("click", deleteData);
  $("#csvBtn").onclick = () => {
    const head = ["Doctor", "Section", ...dates, "Total", "No-show"];
    const lines = [head, ...list.map(d => [d.name, d.dept, ...dates.map(dt => d.perDay[dt] ?? ""), d.attended, d.noShow])];
    const csv = "﻿" + lines.map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `sessions-${state.statsMonth}${state.dept === "all" ? "" : "-" + state.dept}.csv`; a.click();
  };
  if (state.admin) el.querySelectorAll("th.day").forEach(th => th.onclick = () => { watchDay(th.dataset.date); setView("today"); });
}

const inDept = name => state.dept === "all" || name === state.dept;
function deptChips(names) {
  if (state.dept !== "all" && !names.includes(state.dept)) state.dept = "all";
  return `<div class="chips">${["all", ...names].map(n => `<button class="chip ${state.dept === n ? "active" : ""}" data-dfilter="${esc(n)}">${n !== "all" && deptColor(n) ? `<span class="dot" style="background:${deptColor(n)}"></span>` : ""}${n === "all" ? "كل الأقسام" : esc(n)}</button>`).join("")}</div>`;
}
function bindDept(el, rerender) {
  el.querySelectorAll("[data-dfilter]").forEach(b => b.onclick = () => {
    state.dept = state.dept === b.dataset.dfilter && b.dataset.dfilter !== "all" ? "all" : b.dataset.dfilter;
    rerender();
  });
}

function deptSummary(list, M) {
  const by = {};
  for (const d of list) {
    const o = by[d.dept] || (by[d.dept] = { att: 0, ns: 0, docs: 0 });
    o.att += d.attended; o.ns += d.noShow; o.docs += 1;
  }
  const rows = Object.entries(by).sort((a, b) => b[1].att - a[1].att);
  return `<div class="dept-cards">${rows.map(([n, o]) => `
    <div class="card dept-card ${state.dept === n ? "active" : ""}" data-dfilter="${esc(n)}" role="button" title="اعرض القسم ده بس" ${dcStyle(n)}>
      <div class="k">${deptColor(n) ? `<span class="dot" style="background:${deptColor(n)}"></span>` : ""}<b dir="ltr">${esc(n)}</b></div>
      <div class="v">${o.att}</div>
      <div class="s">${M.many} · ${o.docs} دكتور · غياب ${o.ns}</div>
    </div>`).join("")}</div>`;
}

async function deleteData() {
  const all = [...new Set([...state.stats.map(s => s.date), ...state.openDays.map(d => d.date)])].sort();
  if (!all.length) { toast("مفيش داتا"); return; }
  const opt = d => `<option value="${d}">${arDate(d, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</option>`;
  const d = await modal("مسح داتا",
    `اختار الأيام اللي هتتمسح (الجدول + الأرقام بتوعها). <b>المسح مش بيرجع.</b>
     <div style="display:grid;gap:8px;margin-top:10px">
       <label class="field">من: <select id="delFrom" style="flex:1">${all.map(opt).join("")}</select></label>
       <label class="field">لحد: <select id="delTo" style="flex:1">${all.map(opt).join("")}</select></label>
     </div>`, { ok: "كمّل", danger: true });
  if (!d) return;
  let from = d.querySelector("#delFrom").value, to = d.querySelector("#delTo").value;
  if (from > to) [from, to] = [to, from];
  const dates = all.filter(x => x >= from && x <= to);
  const sure = await modal("متأكد؟",
    `هيتمسح <b>${dates.length}</b> يوم: من ${arDate(from)} لحد ${arDate(to)}.<br>اكتب <b>مسح</b> للتأكيد:<input id="confirmTxt">`,
    { ok: "امسح", danger: true });
  if (!sure || sure.querySelector("#confirmTxt").value.trim() !== "مسح") { toast("متمسحش حاجة"); return; }
  try { await state.store.deleteDays(dates); toast(`اتمسح ${dates.length} يوم ✓`); }
  catch (e) { console.error(e); toast("المسح فشل — جرّب تاني"); }
}

/* ---------------- ANALYSIS ---------------- */
function periodFilter(stats) {
  const today = new Date().toISOString().slice(0, 10);
  const back = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const thisM = today.slice(0, 7);
  const lastMd = new Date(); lastMd.setDate(1); lastMd.setMonth(lastMd.getMonth() - 1);
  const lastM = lastMd.toISOString().slice(0, 7);
  return {
    month: s => s.date.startsWith(thisM),
    last: s => s.date.startsWith(lastM),
    d30: s => s.date >= back(30),
    all: () => true,
  }[state.period] || (() => true);
}

function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function renderAnalysis() {
  state.charts.forEach(c => c.destroy()); state.charts = [];
  const el = $("#view-analysis");
  const stats = state.stats.filter(periodFilter(state.stats)).sort((a, b) => a.date.localeCompare(b.date));
  const periods = [["month", "الشهر ده"], ["last", "الشهر اللي فات"], ["d30", "آخر 30 يوم"], ["all", "كل الفترة"]];
  const M = METRICS[state.metric];
  const filters = `<div class="toolbar"><div class="day-title"><h2>Analysis</h2><div class="sub">الأرقام من الأيام المقفولة بس</div></div>
    <div class="spacer"></div>${metricChips()}<div class="chips">${periods.map(([k, l]) => `<button class="chip ${state.period === k ? "active" : ""}" data-p="${k}">${l}</button>`).join("")}</div></div>`;
  const bind = () => {
    el.querySelectorAll("[data-p]").forEach(b => b.onclick = () => { state.period = b.dataset.p; renderAnalysis(); });
    bindMetric(el, renderAnalysis);
    bindDept(el, renderAnalysis);
  };
  if (!stats.length) {
    el.innerHTML = filters + `<div class="empty"><div class="big">📈</div><h2>مفيش داتا في الفترة دي</h2><p>الأرقام بتبدأ من أول يوم الدكاترة يعملوا فيه Submit. جرّب «كل الفترة».</p></div>`;
    bind();
    return;
  }
  const rowsAll = rowsFrom(stats);
  const deptBar = deptChips([...new Set(rowsAll.map(deptOf))].sort());
  const rows = rowsAll.filter(r => inDept(deptOf(r)));
  if (!rows.length) {
    el.innerHTML = filters + `<div class="toolbar"><span class="field">القسم:</span>${deptBar}</div><div class="empty"><h2>مفيش داتا للقسم ده في الفترة دي</h2></div>`;
    bind();
    return;
  }
  const docs = byDoctor(rows);
  const att = docs.reduce((a, d) => a + d.attended, 0);
  const ns = docs.reduce((a, d) => a + d.noShow, 0);
  const cases = rows.reduce((a, r) => a + (r.cases ?? r.attended), 0);
  const rate = cases + ns ? Math.round(cases / (cases + ns) * 100) : 0;
  const perDay = stats.map(s => {
    const v = rows.filter(r => r.date === s.date);
    return { date: s.date, att: v.reduce((a, d) => a + valOf(d), 0), ns: v.reduce((a, d) => a + d.noShow, 0) };
  }).filter(d => d.att || d.ns);
  const best = perDay.reduce((a, b) => b.att > a.att ? b : a);
  const secMap = {};
  rows.forEach(r => { const k = deptOf(r); secMap[k] = (secMap[k] || 0) + valOf(r); });
  const secs = Object.entries(secMap).sort((a, b) => b[1] - a[1]);
  const nsRate = d => d.noShow / ((d.cases || d.attended) + d.noShow);
  const worstNs = [...docs].filter(d => d.attended + d.noShow >= 5).sort((a, b) => nsRate(b) - nsRate(a))[0];
  const avgDoc = Math.round(att / Math.max(1, rows.length) * 10) / 10;

  el.innerHTML = filters + `
    <div class="toolbar"><span class="field">القسم:</span>${deptBar}</div>
    <div class="kpis">
      <div class="card kpi"><div class="k">إجمالي ${M.many}</div><div class="v">${att}</div><div class="s">في ${perDay.length} يوم</div></div>
      <div class="card kpi"><div class="k">متوسط ${M.many} في اليوم</div><div class="v">${Math.round(att / Math.max(1, perDay.length))}</div><div class="s">أعلى يوم: ${best.att} (${shortDate(best.date)})</div></div>
      <div class="card kpi"><div class="k">متوسط الدكتور في اليوم</div><div class="v">${avgDoc}</div><div class="s">${M.one} · ${docs.length} دكتور اشتغلوا</div></div>
      <div class="card kpi"><div class="k">نسبة الحضور</div><div class="v">${rate}%</div><div class="s">${ns} مريض محضرش</div></div>
      <div class="card kpi"><div class="k">أكتر دكتور ${M.many}</div><div class="v" style="font-size:22px;direction:ltr;text-align:right">${esc(docs[0].name)}</div><div class="s">${docs[0].attended} ${M.one} · ${docs[0].days} يوم</div></div>
    </div>
    <div class="card explain">
      <b>إزاي تقرا الأرقام:</b> ${state.metric === "cases"
        ? `كل مريض الدكتور علّمه <b style="color:var(--good)">أخضر</b> بيتحسب <b>حالة واحدة</b> مهما كانت مدة الجلسة.`
        : `كل جلسة الدكتور علّمها <b style="color:var(--good)">أخضر</b> بتتحسب جلسة، ولو الجلسة أطول من ساعة وربع بتتحسب <b>جلستين</b>.`}
      الـ<b style="color:var(--bad)">أحمر</b> بيتحسب غياب، والأبيض اللي محدش علّمه مش بيتحسب. أي دكتور جديد يظهر في الشيت بيتضاف هنا لوحده.
      ${worstNs ? `أعلى نسبة غياب عند <b dir="ltr">${esc(worstNs.name)}</b> (${Math.round(nsRate(worstNs) * 100)}%).` : ""}
      أكبر قسم شغل: <b dir="ltr">${esc(secs[0][0])}</b> بـ ${secs[0][1]} ${M.one}.
    </div>
    <div class="charts">
      <div class="card chart-card" style="grid-row:span 2"><h3>${M.many} كل دكتور</h3><p>مترتبين من الأكتر للأقل · الأحمر = عدد اللي محضروش</p><div class="chart-box tall" style="height:${Math.max(320, docs.length * 24 + 40)}px"><canvas id="cDoc"></canvas></div></div>
      <div class="card chart-card"><h3>${M.many} كل يوم</h3><p>حضر وغاب في كل يوم</p><div class="chart-box"><canvas id="cDay"></canvas></div></div>
      <div class="card chart-card"><h3>${M.many} حسب القسم</h3><p>OT / Inpatient / Aqua / Outpatient ...</p><div class="chart-box"><canvas id="cSec"></canvas></div></div>
    </div>`;
  bind();

  if (!window.Chart) return;
  const C = window.Chart;
  const ink = cssVar("--text-2"), grid = cssVar("--line"), good = "#0ca30c", bad = "#d03b3b", blue = cssVar("--series-1");
  C.defaults.font.family = "Cairo, system-ui, sans-serif";
  C.defaults.color = ink;
  const base = {
    maintainAspectRatio: false, animation: { duration: 250 },
    plugins: { legend: { labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { rtl: true, intersect: false, mode: "index" } },
  };
  const bar = { borderRadius: 4, borderSkipped: "start", maxBarThickness: 18, borderColor: cssVar("--surface"), borderWidth: { top: 0, bottom: 0, left: 1, right: 1 } };

  state.charts.push(new C($("#cDoc"), {
    type: "bar",
    data: { labels: docs.map(d => d.name), datasets: [
      { label: "حضر", data: docs.map(d => d.attended), backgroundColor: good, ...bar, stack: "s" },
      { label: "محضرش", data: docs.map(d => d.noShow), backgroundColor: bad, ...bar, stack: "s" }] },
    options: { ...base, indexAxis: "y",
      scales: { x: { stacked: true, grid: { color: grid }, ticks: { precision: 0 } }, y: { stacked: true, grid: { display: false }, ticks: { autoSkip: false, font: { size: 11 } } } } },
  }));
  state.charts.push(new C($("#cDay"), {
    type: "bar",
    data: { labels: perDay.map(d => shortDate(d.date)), datasets: [
      { label: "حضر", data: perDay.map(d => d.att), backgroundColor: good, ...bar, stack: "s" },
      { label: "محضرش", data: perDay.map(d => d.ns), backgroundColor: bad, ...bar, stack: "s" }] },
    options: { ...base, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, grid: { color: grid }, ticks: { precision: 0 } } } },
  }));
  state.charts.push(new C($("#cSec"), {
    type: "bar",
    data: { labels: secs.map(s => s[0]), datasets: [{ label: METRICS[state.metric].many, data: secs.map(s => s[1]), backgroundColor: secs.map(s => deptColor(s[0]) || blue), ...bar }] },
    options: { ...base, plugins: { ...base.plugins, legend: { display: false } },
      scales: { x: { grid: { display: false } }, y: { grid: { color: grid }, ticks: { precision: 0 } } } },
  }));
}

/* ---------------- boot ---------------- */
(async function boot() {
  state.store = await createStore();
  $("#demoTag").hidden = !state.store.demo;
  state.store.onAuth(isAdmin => {
    state.admin = isAdmin;
    $("#adminBtn").classList.toggle("on", isAdmin);
    $("#adminBtn").textContent = isAdmin ? "🔓 أدمن" : "🔒 أدمن";
    if (!isAdmin && state.viewDate && !state.openDays.some(d => d.date === state.viewDate)) watchDay(state.openDays[0]?.date || null);
    render();
  });
  state.store.onSettings(s => { state.settings = { depts: {}, assign: {}, ...s }; render(); });
  state.store.onOpenDays(onOpenDays);
  state.store.onStats(s => { state.stats = s; if (state.view !== "today") render(); else if (state.admin) renderToday(); });
  render();
})();
