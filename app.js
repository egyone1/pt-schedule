import { createStore } from "./store.js?v=18";
import { ADMIN_EMAIL } from "./config.js?v=18";

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
const idName = n => String(n || "").toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, " ").trim();

const state = {
  store: null, admin: false, view: "today",
  openDays: [], day: null, viewDate: null, unsubDay: null,
  stats: [], section: "all", me: ls.get("meKey", ""), meName: ls.get("me", ""),
  settings: { depts: {}, assign: {} }, dept: "all",
  dayPick: "today", override: false,   // override = admin opened another date
  charts: [], metric: ls.get("metric", "sessions"), unsubStats: null,
  source: ls.get("source", "doctors"),   // reports from the doctors' marks or from the booking sheet
  rep: { preset: "month", from: "", to: "", dept: "all", sort: "sessions", dir: -1 },   // reports filters
  cmpA: { preset: "month", from: "", to: "" }, cmpB: { preset: "last", from: "", to: "" },
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
    d.returnValue = "";                     // Esc must never count as "ok"
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
function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const pickedDate = () => state.dayPick === "yesterday" ? addDays(cairoNow().date, -1) : cairoNow().date;
let lastLock = null;
function followPick() {
  if (!state.override && state.viewDate !== pickedDate()) { watchDay(pickedDate()); return; }
  const lock = submitLocked();
  if (lastLock !== null && lock !== lastLock && state.view === "today") renderToday();
  lastLock = lock;
}
function onOpenDays(days) {
  state.openDays = days;
  if (!state.override && state.viewDate !== pickedDate()) watchDay(pickedDate());
  else if (state.view === "today") renderToday();
}
function dayTabs() {
  const t = cairoNow().date, y = addDays(t, -1);
  const tab = (k, label, d) => `<button class="${!state.override && state.dayPick === k ? "active" : ""}" data-pick="${k}">
    <b>${label}</b><span>${arDate(d, { weekday: "long", day: "numeric", month: "short" })}</span></button>`;
  return `<div class="daytabs">${tab("today", "النهارده", t)}${tab("yesterday", "امبارح", y)}</div>`;
}
function bindDayTabs(el) {
  el.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => {
    state.dayPick = b.dataset.pick; state.override = false; watchDay(pickedDate());
  });
}

/* ---------------- departments (admin) ---------------- */
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
// only the departments the admin chose; a doctor not put in one yet is "بدون قسم"
const NO_DEPT = "بدون قسم";
// Outpatient = the admin's department whose name has "out" in it (Outpatient / outpatient / Out patient)
const isOutDept = name => /out/i.test(name || "");
const outDept = () => Object.keys(state.settings.depts || {}).find(isOutDept) || "Outpatient";
// Neuro / Ortho: the official list (settings.subs, from the doctors file, admin can change it) comes first,
// then what the sheet layout showed. Same-name doctors in Inpatient / OT / LYM columns are left out.
const OTHER_SEC = /^(inpatient|ot|lym)$/i;
const subOf = d => (!OTHER_SEC.test(d.section || "") && (state.settings.subs || {})[idName(d.name)]) || d.sub || "";
// a doctor's department: "name@section" first (two doctors with one name in different sections), then the name
const secKey = d => idName(d.name) + "@" + String(d.section || "").toLowerCase();
const assignKey = d => (state.settings.assign || {})[secKey(d)] !== undefined ? secKey(d) : idName(d.name);
const deptOf = d => {
  const dep = (state.settings.assign || {})[assignKey(d)];
  if (dep && (state.settings.depts || {})[dep]) return dep;
  return subOf(d) ? outDept() : NO_DEPT;   // a Neuro / Ortho doctor not put in a department yet still counts as Outpatient
};
const deptColor = name => (state.settings.depts || {})[name] || "";
const dcStyle = name => deptColor(name) ? `style="--dc:${deptColor(name)}"` : "";

async function saveSettings(patch) {
  const next = { depts: { ...(state.settings.depts || {}) }, assign: { ...(state.settings.assign || {}) }, subs: { ...(state.settings.subs || {}) }, ...patch };
  try { await state.store.saveSettings(next); }
  catch (e) { console.error(e); toast("محصلش حفظ — جرّب تاني"); }
}
async function assignDept(name, value, key = idName(name)) {
  const assign = { ...(state.settings.assign || {}) }, depts = { ...(state.settings.depts || {}) };
  if (value === "__new") {
    const d = await modal("قسم جديد", `اسم القسم:<input id="deptName" placeholder="مثلاً Ortho">`, { ok: "ضيف" });
    const nm = d?.querySelector("#deptName").value.trim();
    if (!nm) { renderToday(); return; }
    if (!depts[nm]) depts[nm] = PALETTE[Object.keys(depts).length % PALETTE.length];
    value = nm;
  }
  if (value) assign[key] = value; else delete assign[key];
  await saveSettings({ depts, assign });
  toast(value ? `${name} اتحط في ${value}` : `${name} اتشال من القسم`);
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

/* ---------------- sheet link (admin) ---------------- */
const fmtStamp = iso => iso ? new Date(iso).toLocaleString("ar-EG-u-nu-latn", { timeZone: "Africa/Cairo", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
async function editSource() {
  let src = {};
  try { src = await state.store.getSource(); } catch (e) { console.error(e); }
  const failing = src.lastError && (!src.lastOkAt || src.lastErrorAt > src.lastOkAt);
  const d = await modal("لينك شيت السكرتارية",
    `<p>لو السكرتارية غيّروا الملف أو اللينك، الزق اللينك الجديد هنا. الموقع هيكمّل منه من التحديث الجاي (9 الصبح · 3 العصر · 9 بالليل).</p>
     <p style="font-size:13px">اللينك لازم يكون <b>Anyone with the link can view</b>، والشيت بنفس الشكل: تاب لكل يوم واسمه فيه رقم اليوم والشهر.</p>
     <label style="font-size:13px">اللينك:</label>
     <input id="srcUrl" dir="ltr" value="${esc(src.shareUrl || "")}" placeholder="https://....sharepoint.com/:x:/...">
     <p style="font-size:12.5px;margin-top:10px">آخر سحب ناجح: <b>${fmtStamp(src.lastOkAt)}</b>
     ${failing ? `<br><span style="color:var(--bad)">⚠ آخر محاولة فشلت (${fmtStamp(src.lastErrorAt)}): ممكن اللينك اتقفل أو اتغير.</span>` : ""}</p>`,
    { ok: "احفظ اللينك" });
  if (!d) return;
  const url = d.querySelector("#srcUrl").value.trim();
  if (url === (src.shareUrl || "")) return;
  if (!/^https:\/\/[^\s]+\.(sharepoint\.com|onedrive\.live\.com|1drv\.ms)\//i.test(url)) {
    toast("ده مش لينك SharePoint / OneDrive — متحفظش"); return;
  }
  try { await state.store.saveSource(url); toast("اللينك الجديد اتحفظ ✓ — هيتسحب منه في التحديث الجاي"); }
  catch (e) { console.error(e); toast("محصلش حفظ — جرّب تاني"); }
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
  const two = s.units > 1 ? `<span class="x2" title="الخانة دي بتتحسب ${s.units} جلسات">×${s.units}</span>` : "";
  return `<button class="sess s${s.status || 0}${locked}" data-key="${esc(doc.key)}" data-id="${esc(s.id)}" ${style}
    title="${esc(s.patient)} — ${esc(s.details)}">
    <span class="mark" aria-hidden="true"></span>${two}<span class="p">${esc(s.patient)}</span>
    <span class="t">${fmtTime(toMin(s.start))} – ${fmtTime(toMin(s.end))}</span>
    ${s.details ? `<span class="d">${esc(s.details)}</span>` : ""}</button>`;
}
// Cairo clock (the site may be opened on a phone set to another zone)
function cairoNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24 };
}
const SUBMIT_FROM = 15;   // doctors can submit from 3 PM on the day itself
const submitLocked = () => !state.admin && state.day && state.day.date === cairoNow().date && cairoNow().hour < SUBMIT_FROM;
const changedNote = d => d.changedAt && !d.submitted
  ? `<div class="changed">⚠ جدولك اتغيّر في الشيت بعد الـ Submit — راجعه واعمل Submit تاني</div>` : "";

// after Submit: the patients in order, each with ✓ (came) or ✗ (didn't come), ready to copy as text
const attendText = doc => doc.sessions.map((s, i) => `${i + 1}. ${String(s.patient || "").replace(/\s+/g, " ").trim()} ${s.status === 1 ? "✓" : s.status === 2 ? "✗" : "؟"}`).join("\n");
const copyBox = (doc, big) => big
  ? `<div class="copybox"><textarea readonly rows="${Math.min(doc.sessions.length, 12)}" data-copytext="${esc(doc.key)}">${esc(attendText(doc))}</textarea>
      <button class="ghost" data-copy="${esc(doc.key)}">📋 انسخ الأسامي</button></div>`
  : `<button class="ghost copy-sm" data-copy="${esc(doc.key)}">📋 انسخ الأسامي</button>`;
async function copyAttend(key) {
  const doc = state.day.doctors[key];
  if (!doc) return;
  const txt = attendText(doc);
  try { await navigator.clipboard.writeText(txt); }
  catch {
    const t = document.createElement("textarea"); t.value = txt; document.body.append(t); t.select();
    document.execCommand("copy"); t.remove();
  }
  toast("الأسامي اتنسخت ✓");
}
function submitBtn(doc, big = false) {
  if (doc.submitted)
    return (state.admin
      ? `<button class="ghost" data-unsubmit="${esc(doc.key)}">✓ اتعمل Submit · إلغاء</button>`
      : `<button class="ghost" disabled>✓ اتعمل Submit</button>`) + copyBox(doc, big);
  if (submitLocked()) return `<button class="primary" disabled title="الـ Submit بيفتح الساعة 3 العصر">Submit من الساعة 3</button>`;
  const dis = state.day.status !== "open" && !state.admin ? "disabled" : "";
  return `<button class="primary" data-submit="${esc(doc.key)}" ${dis}>Submit</button>`;
}

function renderToday() {
  const el = $("#view-today");
  const day = state.day;
  const adminBar = state.admin ? adminDayBar() : "";
  if (!day) {
    const early = state.dayPick === "today" && !state.override && cairoNow().hour < 11;   // the 9 AM job can run ~20 min late
    el.innerHTML = adminBar + dayTabs() + `<div class="empty"><div class="big">🗓️</div>
      <h2>${early ? "جدول النهارده بيظهر الساعة 9 الصبح (ممكن يتأخر ربع ساعة)" : "مفيش جدول لليوم ده"}</h2>
      <p>جدول اليوم بيظهر أوتوماتيك كل يوم الساعة <b>9 الصبح</b> من شيت السكرتارية، والـ Submit بيفتح الساعة <b>3 العصر</b>.<br>
      الجدول بيتحدّث من الشيت <b>كل ساعة</b>، وتحديث الساعة <b>9 بالليل</b> هو النهائي، وبيفضل مفتوح للدكاترة لحد <b>12 بالليل</b> اليوم اللي بعده.</p></div>`;
    bindAdminBar(); bindDayTabs(el);
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
    ? `مفتوح لحد 12 بالليل ${day.date === cairoNow().date ? "بكرة" : "النهارده"} · تاب «${esc(day.sheet)}» · ${day.finalAt ? "<b>الجدول النهائي</b> (اتحدّث الساعة 9 بالليل)" : day.refreshedAt ? `آخر تحديث من الشيت ${new Date(day.refreshedAt).toLocaleTimeString("ar-EG-u-nu-latn", { timeZone: "Africa/Cairo", hour: "numeric", minute: "2-digit" })} · بيتحدّث كل ساعة لحد 9 بالليل` : "بيتحدّث من الشيت كل ساعة لحد 9 بالليل"}${submitLocked() ? " · الـ Submit من الساعة 3" : ""}`
    : `<b style="color:var(--brand)">مقفول ✓</b>${day.autoClosed ? " (اتقفل أوتوماتيك)" : ""}`;

  el.innerHTML = `${adminBar}
    ${day.status === "closed" && state.admin ? `<div class="banner">ده يوم مقفول — إنت بتعدّل كأدمن، والإحصائيات بتتحدّث لوحدها.</div>` : ""}
    <div class="toolbar">
      <div class="day-title">${dayTabs()}<h2>${arDate(day.date)}</h2><div class="sub">${statusLine}</div></div>
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
        <span><b style="font-size:11px;background:var(--text);color:var(--surface);border-radius:6px;padding:0 5px">×2</b> بتتحسب أكتر من جلسة</span>
      </div>
    </div>
    ${mine ? mineHTML(mine) : gridHTML(visible)}`;

  const board = el.querySelector(".board");
  if (board && keep.left != null) { board.scrollLeft = keep.left; board.scrollTop = keep.top; }
  if (keep.y) window.scrollTo(0, keep.y);

  bindAdminBar(); bindDayTabs(el);
  $("#meSel").onchange = e => {
    state.me = e.target.value;
    state.meName = docs.find(d => d.key === state.me)?.name || "";
    ls.set("meKey", state.me); ls.set("me", state.meName);
    renderToday();
  };
  el.querySelectorAll("[data-dept]").forEach(s => s.onchange = () => assignDept(s.dataset.dept, s.value, s.dataset.akey));
  el.querySelectorAll("[data-subsel]").forEach(s => s.onchange = () => setSub(s.dataset.subsel, s.value));
  el.querySelectorAll("[data-sec]").forEach(b => b.onclick = () => { state.section = b.dataset.sec; renderToday(); });
  el.querySelectorAll(".sess").forEach(b => b.onclick = () => cycle(b.dataset.key, b.dataset.id));
  el.querySelectorAll("[data-submit]").forEach(b => b.onclick = () => submit(b.dataset.submit));
  el.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => copyAttend(b.dataset.copy));
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
        ${state.admin ? deptSelect(d) : `<div class="sec">${esc(deptOf(d))}${isOutDept(deptOf(d)) && subOf(d) ? " · " + esc(subOf(d)) : ""} ${d.submitted ? '<span class="badge">· Submit ✓</span>' : ""}</div>`}
        <div class="cnt"><span style="color:var(--good)">✓ <b>${c.att}</b></span><span style="color:var(--bad)">✗ <b>${c.ns}</b></span><span>لسه <b>${c.un}</b></span></div>
        ${changedNote(d)}
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
  const cur = (state.settings.assign || {})[assignKey(d)] || "";
  const opts = Object.keys(state.settings.depts || {}).map(n => `<option value="${esc(n)}" ${n === cur ? "selected" : ""}>${esc(n)}</option>`).join("");
  return `<select class="dept-sel" data-dept="${esc(d.name)}" data-akey="${esc(assignKey(d))}" title="القسم">
    <option value="">${NO_DEPT}</option>${opts}<option value="__new">+ قسم جديد…</option></select>${subSelect(d)}`;
}
function subSelect(d) {
  if (!isOutDept(deptOf(d)) || OTHER_SEC.test(d.section || "")) return "";
  const cur = (state.settings.subs || {})[idName(d.name)] || "";
  const o = (v, t) => `<option value="${v}" ${v === cur ? "selected" : ""}>${t}</option>`;
  return `<select class="dept-sel" data-subsel="${esc(d.name)}" title="Neuro / Ortho">
    ${o("", "تلقائي" + (d.sub ? ` (${d.sub})` : ""))}${o("Neuro", "Neuro")}${o("Ortho", "Ortho")}</select>`;
}
async function setSub(name, value) {
  const subs = { ...(state.settings.subs || {}) };
  if (value) subs[idName(name)] = value; else delete subs[idName(name)];
  await saveSettings({ subs });
  toast(value ? `${name} بقى ${value}` : `${name} هيتحدد من الجدول`);
}

function mineHTML(d) {
  const c = counts(d);
  return `<div class="mine"><div class="card">
    <div class="hdr"><h3>${esc(d.name)}</h3>
      <span style="font-size:13px;color:var(--text-2)">✓ ${c.att} · ✗ ${c.ns} · لسه ${c.un}</span></div>
    ${changedNote(d)}
    <div class="list">${d.sessions.map(s => sessHTML(d, s)).join("")}</div>
  </div><div class="foot">${submitBtn(d, true)}</div></div>`;
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
  try { await state.store.setSessions(day.date, key, sessions, day.status === "closed"); }
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
    <button class="ghost" id="srcBtn">🔗 لينك الشيت</button>
    ${state.store.demo ? `<button class="ghost" id="resetDemo">رجّع التجربة من الأول</button>` : ""}
  </div>`;
}
function bindAdminBar() {
  if (!state.admin) return;
  $("#adminDate")?.addEventListener("change", e => { state.override = true; watchDay(e.target.value); });
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
  $("#srcBtn")?.addEventListener("click", editSource);
}

/* ---------------- reports (admin only) ---------------- */
// "sessions" = a session over 1h15 counts twice; "cases" = every attended patient counts once
const METRICS = { sessions: { one: "جلسة", many: "الجلسات" }, cases: { one: "حالة", many: "الحالات" } };
const valOf = r => state.metric === "cases" ? r.cases : r.sessions;
const fmtN = n => Math.round(n).toLocaleString("en-US");
const fmtP = x => (Math.round(x * 1000) / 10).toFixed(1) + "%";
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monthStart = iso => iso.slice(0, 8) + "01";
const monthEnd = iso => { const d = new Date(iso.slice(0, 8) + "01T12:00:00"); d.setMonth(d.getMonth() + 1); d.setDate(0); return isoOf(d); };
const PRESETS = [["month", "الشهر ده"], ["last", "الشهر اللي فات"], ["d7", "آخر 7 أيام"], ["d30", "آخر 30 يوم"], ["all", "كل الفترة"], ["custom", "تواريخ معيّنة"]];

function rangeOf(preset, from, to) {
  const t = cairoNow().date;
  if (preset === "month") return { from: monthStart(t), to: t };
  if (preset === "last") { const p = addDays(monthStart(t), -1); return { from: monthStart(p), to: monthEnd(p) }; }
  if (preset === "d7") return { from: addDays(t, -6), to: t };
  if (preset === "d30") return { from: addDays(t, -29), to: t };
  if (preset === "all") { const ds = state.stats.map(s => s.date).sort(); return { from: ds[0] || t, to: ds[ds.length - 1] || t }; }
  return { from: from || monthStart(t), to: to || t };
}
const rangeLabel = r => r.from === r.to ? arDate(r.from) :
  `${arDate(r.from, { day: "numeric", month: "short", year: "numeric" })} ← ${arDate(r.to, { day: "numeric", month: "short", year: "numeric" })}`;

// one row per doctor per closed day
function rowsIn(range) {
  const rows = [];
  for (const s of state.stats) {
    if (s.date < range.from || s.date > range.to) continue;
    for (const d of Object.values(s.doctors || {})) {
      const sh = d.sheet || {};
      rows.push(state.source === "sheet" ? {
        date: s.date, id: idName(d.name), name: d.name, dept: deptOf(d), sub: isOutDept(deptOf(d)) ? subOf(d) : "",
        sessions: sh.sessions || 0, cases: sh.cases || 0, noShow: sh.cancelled || 0,
        booked: d.booked || 0, unmarked: 0, treat: sh.treat || {},
      } : {
        date: s.date, id: idName(d.name), name: d.name, dept: deptOf(d), sub: isOutDept(deptOf(d)) ? subOf(d) : "",
        sessions: d.attended || 0, cases: d.cases ?? d.attended ?? 0, noShow: d.noShow || 0,
        booked: d.booked || 0, unmarked: d.unmarked || 0, treat: d.treat || {},
      });
    }
  }
  return rows;
}
function agg(rows) {
  const a = { sessions: 0, cases: 0, noShow: 0, booked: 0, unmarked: 0, treat: {}, ids: new Set(), days: new Set() };
  for (const r of rows) {
    a.sessions += r.sessions; a.cases += r.cases; a.noShow += r.noShow; a.booked += r.booked; a.unmarked += r.unmarked;
    a.ids.add(r.id); a.days.add(r.date);
    for (const [t, n] of Object.entries(r.treat)) a.treat[t] = (a.treat[t] || 0) + n;
  }
  a.rate = a.cases + a.noShow ? a.noShow / (a.cases + a.noShow) : 0;
  a.treatTotal = Object.values(a.treat).reduce((x, y) => x + y, 0);
  a.treatTypes = Object.keys(a.treat).length;
  a.topTreat = Object.entries(a.treat).sort((x, y) => y[1] - x[1])[0]?.[0] || "—";
  a.doctors = a.ids.size; a.nDays = a.days.size;
  a.perDay = a.nDays ? valOf(a) / a.nDays : 0;
  return a;
}
function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}
const deptCell = n => `<span class="dept-name">${deptColor(n) ? `<span class="dot" style="background:${deptColor(n)}"></span>` : ""}${esc(n)}</span>`;
const delta = (a, b) => {
  if (!b) return a ? `<span class="up">جديد</span>` : "—";
  const p = (a - b) / b;
  const cls = Math.abs(p) < 0.005 ? "flat" : p > 0 ? "up" : "down";
  return `<span class="${cls}">${p > 0 ? "▲" : p < 0 ? "▼" : "•"} ${fmtP(Math.abs(p))}</span>`;
};
const deltaBad = (a, b) => delta(a, b).replace('class="up"', 'class="tmp"').replace('class="down"', 'class="up"').replace('class="tmp"', 'class="down"');

function periodPicker(prefix, sel) {
  const r = rangeOf(sel.preset, sel.from, sel.to);
  return `<div class="period">
    <div class="chips">${PRESETS.map(([k, l]) => `<button class="chip ${sel.preset === k ? "active" : ""}" data-${prefix}p="${k}">${l}</button>`).join("")}</div>
    <label class="field">من <input type="date" data-${prefix}from value="${r.from}"></label>
    <label class="field">لحد <input type="date" data-${prefix}to value="${r.to}"></label>
  </div>`;
}
function bindPeriod(el, prefix, sel, rerender) {
  el.querySelectorAll(`[data-${prefix}p]`).forEach(b => b.onclick = () => { sel.preset = b.getAttribute(`data-${prefix}p`); rerender(); });
  const f = el.querySelector(`[data-${prefix}from]`), t = el.querySelector(`[data-${prefix}to]`);
  const onDate = () => { sel.preset = "custom"; sel.from = f.value; sel.to = t.value; if (sel.from > sel.to) [sel.from, sel.to] = [sel.to, sel.from]; rerender(); };
  if (f) f.onchange = onDate;
  if (t) t.onchange = onDate;
}
const SUB_LABEL = { Neuro: "Neuro", Ortho: "Ortho" };
function deptSelectBar() {
  const opts = new Map();
  for (const st of state.stats) for (const d of Object.values(st.doctors || {})) {
    const dep = deptOf(d);
    opts.set(dep, dep);
    const sb = subOf(d);
    if (sb && isOutDept(dep)) opts.set(dep + "::" + sb, `${dep} · ${SUB_LABEL[sb] || sb}`);
  }
  const keys = [...opts.keys()].sort();
  if (state.rep.dept !== "all" && !opts.has(state.rep.dept)) state.rep.dept = "all";
  return `<label class="field">القسم <select data-dept-filter>
    <option value="all">كل الأقسام</option>${keys.map(k => `<option value="${esc(k)}" ${state.rep.dept === k ? "selected" : ""}>${esc(opts.get(k))}</option>`).join("")}
  </select></label>`;
}
// department rows, each followed by its Neuro / Ortho rows when it has them
function deptRowsWithSubs(rows) {
  const out = [];
  for (const [k, v] of groupBy(rows, r => r.dept)) {
    out.push({ k, label: k, a: agg(v), rows: v, isSub: false });
    const subs = [...groupBy(v.filter(r => r.sub), r => r.sub)].sort((x, y) => x[0].localeCompare(y[0]));
    if (subs.length) out[out.length - 1].subs = subs.map(([sb, sv]) => ({ k: k + "::" + sb, label: SUB_LABEL[sb] || sb, a: agg(sv), rows: sv, isSub: true }));
  }
  out.sort((x, y) => valOf(y.a) - valOf(x.a));
  return out.flatMap(d => [d, ...(d.subs || [])]);
}
const subCell = (dept, sub) => deptCell(dept) + (sub ? ` <span class="subtag">${esc(SUB_LABEL[sub] || sub)}</span>` : "");
const SOURCES = { doctors: "حسب الدكاترة", sheet: "حسب الجدول" };
const sourceNote = () => state.source === "sheet"
  ? "الأرقام من ألوان شيت السكرتارية: الأحمر = كنسل، وأي لون تاني = حضر."
  : "الأرقام من علامات الدكاترة: الأخضر = حضر، الأحمر = كنسل، والأبيض مش متحسوب.";
function metricChips() {
  return `<div class="chips source">${Object.entries(SOURCES).map(([k, l]) =>
      `<button class="chip ${state.source === k ? "active" : ""}" data-source="${k}">${l}</button>`).join("")}</div>
    <div class="chips">${Object.entries(METRICS).map(([k, m]) =>
      `<button class="chip ${state.metric === k ? "active" : ""}" data-metric="${k}">${m.many}</button>`).join("")}</div>`;
}
function bindCommon(el, rerender) {
  el.querySelectorAll("[data-metric]").forEach(b => b.onclick = () => { state.metric = b.dataset.metric; ls.set("metric", state.metric); rerender(); });
  el.querySelectorAll("[data-source]").forEach(b => b.onclick = () => { state.source = b.dataset.source; ls.set("source", state.source); rerender(); });
  const ds = el.querySelector("[data-dept-filter]");
  if (ds) ds.onchange = () => { state.rep.dept = ds.value; rerender(); };
}
const inDept = r => {
  if (state.rep.dept === "all") return true;
  const [dep, sub] = state.rep.dept.split("::");
  return r.dept === dep && (!sub || r.sub === sub);
};
const adminOnly = el => { el.innerHTML = `<div class="empty"><div class="big">🔒</div><h2>الصفحة دي للأدمن بس</h2></div>`; };
const noData = msg => `<div class="empty"><div class="big">📊</div><h2>${msg}</h2><p>الأرقام بتيجي من الأيام المقفولة (بعد ما الدكاترة يعملوا Submit أو اليوم يتقفل الساعة 12 بالليل).</p></div>`;

/* ---------------- STATS ---------------- */
function renderStats() {
  const el = $("#view-stats");
  if (!state.admin) return adminOnly(el);
  const M = METRICS[state.metric];
  const range = rangeOf(state.rep.preset, state.rep.from, state.rep.to);
  const all = rowsIn(range);
  const rows = all.filter(inDept);
  const A = agg(rows);
  const head = `<div class="toolbar"><div class="day-title"><h2>الإحصائيات</h2><div class="sub">${rangeLabel(range)}${state.rep.dept !== "all" ? " · " + esc(state.rep.dept.replace("::", " · ")) : ""} · <b>${SOURCES[state.source]}</b></div></div>
      <div class="spacer"></div><button class="ghost" id="csvBtn">⬇ Excel</button><button class="danger" id="delBtn">🗑 مسح داتا</button></div>
    <div class="card filters">${periodPicker("s", state.rep)}<div class="filter-row">${deptSelectBar()}${metricChips()}</div><p class="hint">${sourceNote()}</p></div>`;
  if (!rows.length) {
    el.innerHTML = head + noData("مفيش أرقام في الفترة دي");
    bindPeriod(el, "s", state.rep, renderStats); bindCommon(el, renderStats);
    $("#delBtn").onclick = deleteData;
    return;
  }

  // departments (all of them, so the selected one can be compared with the rest)
  const byDept = [...groupBy(all, r => r.dept)].map(([k, v]) => ({ k, a: agg(v) })).sort((x, y) => valOf(y.a) - valOf(x.a));
  const deptTable = deptRowsWithSubs(all);
  const allA = agg(all);
  // doctors
  const docs = [...groupBy(rows, r => r.id)].map(([id, v]) => ({ id, name: v[v.length - 1].name, dept: v[v.length - 1].dept, sub: v[v.length - 1].sub, a: agg(v) }));
  const sortKey = { name: d => d.name.toLowerCase(), dept: d => d.dept, days: d => d.a.nDays, sessions: d => d.a.sessions, cases: d => d.a.cases,
    noShow: d => d.a.noShow, rate: d => d.a.rate, treat: d => d.a.treatTotal, perDay: d => d.a.perDay }[state.rep.sort] || (d => d.a.sessions);
  docs.sort((x, y) => { const a = sortKey(x), b = sortKey(y); return (a > b ? 1 : a < b ? -1 : 0) * state.rep.dir; });
  // treatments by department
  const treatNames = Object.entries(A.treat).sort((x, y) => y[1] - x[1]).map(x => x[0]);
  const tDepts = state.rep.dept === "all" ? byDept.map(d => d.k) : [state.rep.dept.split("::")[0]];
  // day by day
  const dates = [...A.days].sort();

  const th = (key, label) => `<th class="sortable ${state.rep.sort === key ? "sorted" : ""}" data-sort="${key}">${label}${state.rep.sort === key ? (state.rep.dir < 0 ? " ▾" : " ▴") : ""}</th>`;
  el.innerHTML = head + `
    <div class="kpis">
      <div class="card kpi"><div class="k">الجلسات اللي اتعملت</div><div class="v">${fmtN(A.sessions)}</div><div class="s">${fmtN(A.sessions / Math.max(1, A.nDays))} في اليوم · ${A.nDays} يوم</div></div>
      <div class="card kpi"><div class="k">الحالات (المرضى اللي حضروا)</div><div class="v">${fmtN(A.cases)}</div><div class="s">${fmtN(A.sessions - A.cases)} جلسة زيادة (ex/balance/pb/wb/gait أو mt2)</div></div>
      <div class="card kpi bad"><div class="k">${state.source === "sheet" ? "كنسل (أحمر في الجدول)" : "محضرش (كنسل)"}</div><div class="v">${fmtN(A.noShow)}</div><div class="s">${fmtP(A.rate)} من الحالات</div></div>
      <div class="card kpi"><div class="k">العلاجات</div><div class="v">${fmtN(A.treatTotal)}</div><div class="s">${A.treatTypes} نوع · أكتر واحد ${esc(A.topTreat)}</div></div>
      <div class="card kpi"><div class="k">الدكاترة</div><div class="v">${A.doctors}</div><div class="s">${fmtN(valOf(A) / Math.max(1, A.doctors))} ${M.one} للدكتور</div></div>
    </div>

    <section class="card block">
      <h3>الأقسام</h3><p class="hint">دوس على قسم عشان تشوف دكاترته وعلاجاته بس.</p>
      <div class="table-wrap"><table class="stats rep">
        <thead><tr><th class="nm">القسم</th><th>الدكاترة</th><th>الجلسات</th><th>الحالات</th><th>محضرش</th><th>نسبة الكنسل</th><th>العلاجات</th><th>أنواع العلاج</th><th>أكتر علاج</th><th>${M.many} / يوم</th></tr></thead>
        <tbody>${deptTable.map(({ k, label, a, isSub }) => `<tr class="click ${isSub ? "subrow" : ""} ${state.rep.dept === k ? "picked" : ""}" data-pick-dept="${esc(k)}">
          <td class="nm">${isSub ? `<span class="subtag">${esc(label)}</span>` : deptCell(k)}</td><td>${a.doctors}</td><td><b>${fmtN(a.sessions)}</b></td><td>${fmtN(a.cases)}</td><td class="ns">${fmtN(a.noShow)}</td>
          <td>${fmtP(a.rate)}</td><td>${fmtN(a.treatTotal)}</td><td>${a.treatTypes}</td><td>${esc(a.topTreat)}</td><td>${fmtN(a.perDay)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td class="nm">كل الأقسام</td><td>${allA.doctors}</td><td>${fmtN(allA.sessions)}</td><td>${fmtN(allA.cases)}</td><td class="ns">${fmtN(allA.noShow)}</td>
          <td>${fmtP(allA.rate)}</td><td>${fmtN(allA.treatTotal)}</td><td>${allA.treatTypes}</td><td>${esc(allA.topTreat)}</td><td>${fmtN(allA.perDay)}</td></tr></tfoot>
      </table></div>
    </section>

    <section class="card block">
      <h3>الدكاترة</h3><p class="hint">دوس على عنوان أي عمود عشان ترتّب بيه، ودوس على اسم الدكتور عشان تشوف تفاصيله.</p>
      <div class="table-wrap"><table class="stats rep">
        <thead><tr>${th("name", "الدكتور")}${th("dept", "القسم")}${th("days", "أيام")}${th("sessions", "الجلسات")}${th("cases", "الحالات")}${th("noShow", "محضرش")}${th("rate", "نسبة الكنسل")}${th("treat", "العلاجات")}${th("perDay", M.many + " / يوم")}</tr></thead>
        <tbody>${docs.map(d => `<tr><td class="nm"><button class="link" data-doc="${esc(d.id)}">${esc(d.name)}</button></td><td>${subCell(d.dept, d.sub)}</td>
          <td>${d.a.nDays}</td><td><b>${fmtN(d.a.sessions)}</b></td><td>${fmtN(d.a.cases)}</td><td class="ns">${fmtN(d.a.noShow)}</td>
          <td class="${d.a.rate > A.rate ? "hi" : ""}">${fmtP(d.a.rate)}</td><td>${fmtN(d.a.treatTotal)}</td><td>${(Math.round(d.a.perDay * 10) / 10).toFixed(1)}</td></tr>`).join("")}</tbody>
      </table></div>
    </section>

    <section class="card block">
      <h3>أنواع العلاج</h3><p class="hint">عدد مرات كل علاج في الجلسات اللي حضرت (mt*2 بيتحسب مرتين).</p>
      <div class="table-wrap"><table class="stats rep">
        <thead><tr><th class="nm">العلاج</th>${tDepts.map(k => `<th>${deptCell(k)}</th>`).join("")}${tDepts.length > 1 ? "<th>الإجمالي</th>" : ""}<th>من كل العلاجات</th></tr></thead>
        <tbody>${treatNames.map(t => { const tot = A.treat[t]; return `<tr><td class="nm">${esc(t)}</td>
          ${tDepts.map(k => { const v = byDept.find(x => x.k === k)?.a.treat[t] || 0; return `<td class="${v ? "" : "zero"}">${v ? fmtN(v) : "·"}</td>`; }).join("")}
          ${tDepts.length > 1 ? `<td class="tot">${fmtN(tot)}</td>` : ""}<td><span class="bar-cell"><i style="width:${Math.round(tot / A.treatTotal * 100)}%"></i>${fmtP(tot / A.treatTotal)}</span></td></tr>`; }).join("")}</tbody>
        <tfoot><tr><td class="nm">المجموع (${treatNames.length} نوع)</td>${tDepts.map(k => `<td>${fmtN(byDept.find(x => x.k === k)?.a.treatTotal || 0)}</td>`).join("")}${tDepts.length > 1 ? `<td class="tot">${fmtN(A.treatTotal)}</td>` : ""}<td>100%</td></tr></tfoot>
      </table></div>
    </section>

    <details class="card block">
      <summary><h3>يوم بيوم لكل دكتور</h3></summary>
      <div class="table-wrap"><table class="stats">
        <thead><tr><th class="nm">الدكتور</th>${dates.map(d => `<th class="day" title="${arDate(d)}">${shortDate(d)}</th>`).join("")}<th>الإجمالي</th></tr></thead>
        <tbody>${docs.map(d => { const per = {}; rows.filter(r => r.id === d.id).forEach(r => per[r.date] = (per[r.date] || 0) + valOf(r));
          return `<tr><td class="nm">${esc(d.name)}</td>${dates.map(dt => per[dt] == null ? `<td class="zero">·</td>` : `<td>${per[dt]}</td>`).join("")}<td class="tot">${fmtN(valOf(d.a))}</td></tr>`; }).join("")}</tbody>
      </table></div>
    </details>`;

  bindPeriod(el, "s", state.rep, renderStats);
  bindCommon(el, renderStats);
  $("#delBtn").onclick = deleteData;
  el.querySelectorAll("[data-pick-dept]").forEach(tr => tr.onclick = () => {
    state.rep.dept = state.rep.dept === tr.dataset.pickDept ? "all" : tr.dataset.pickDept; renderStats();
  });
  el.querySelectorAll("[data-sort]").forEach(h => h.onclick = () => {
    if (state.rep.sort === h.dataset.sort) state.rep.dir *= -1; else { state.rep.sort = h.dataset.sort; state.rep.dir = h.dataset.sort === "name" || h.dataset.sort === "dept" ? 1 : -1; }
    renderStats();
  });
  el.querySelectorAll("[data-doc]").forEach(b => b.onclick = () => doctorDetail(b.dataset.doc, range, rows));
  $("#csvBtn").onclick = () => downloadCsv(`doctors-${range.from}-${range.to}.csv`,
    [["Doctor", "Department", "Days", "Sessions", "Cases", "No-show", "Cancel rate", "Treatments", ...treatNames],
     ...docs.map(d => [d.name, d.dept, d.a.nDays, d.a.sessions, d.a.cases, d.a.noShow, fmtP(d.a.rate), d.a.treatTotal, ...treatNames.map(t => d.a.treat[t] || 0)])]);
}

function doctorDetail(id, range, rows) {
  const mine = rows.filter(r => r.id === id);
  if (!mine.length) return;
  const a = agg(mine), dept = mine[mine.length - 1].dept;
  const peers = [...groupBy(rows.filter(r => r.dept === dept), r => r.id)].map(([, v]) => agg(v));
  const avg = k => peers.reduce((x, p) => x + p[k], 0) / Math.max(1, peers.length);
  const days = [...groupBy(mine, r => r.date)].sort((x, y) => x[0].localeCompare(y[0]));
  const treat = Object.entries(a.treat).sort((x, y) => y[1] - x[1]);
  modal(`${mine[mine.length - 1].name} · ${dept}`, `
    <p class="hint">${rangeLabel(range)}</p>
    <table class="mini"><thead><tr><th></th><th>الدكتور</th><th>متوسط دكاترة القسم</th></tr></thead><tbody>
      <tr><td>الجلسات</td><td><b>${fmtN(a.sessions)}</b></td><td>${fmtN(avg("sessions"))}</td></tr>
      <tr><td>الحالات</td><td><b>${fmtN(a.cases)}</b></td><td>${fmtN(avg("cases"))}</td></tr>
      <tr><td>محضرش</td><td><b>${fmtN(a.noShow)}</b> (${fmtP(a.rate)})</td><td>${fmtN(avg("noShow"))}</td></tr>
      <tr><td>العلاجات</td><td><b>${fmtN(a.treatTotal)}</b></td><td>${fmtN(avg("treatTotal"))}</td></tr>
      <tr><td>أيام الشغل</td><td><b>${a.nDays}</b></td><td>${fmtN(avg("nDays"))}</td></tr>
    </tbody></table>
    <h4>العلاجات</h4>
    <div class="treat-chips">${treat.map(([t, n]) => `<span>${esc(t)} <b>${n}</b></span>`).join("") || "—"}</div>
    <h4>يوم بيوم</h4>
    <table class="mini"><thead><tr><th>اليوم</th><th>جلسات</th><th>حالات</th><th>محضرش</th></tr></thead><tbody>
      ${days.map(([d, v]) => { const x = agg(v); return `<tr><td>${arDate(d, { weekday: "short", day: "numeric", month: "short" })}</td><td>${x.sessions}</td><td>${x.cases}</td><td class="ns">${x.noShow || ""}</td></tr>`; }).join("")}
    </tbody></table>`, { ok: "تمام", cancel: "" });
}

function downloadCsv(name, lines) {
  const csv = "﻿" + lines.map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = name; a.click();
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

/* ---------------- COMPARE + CHARTS ---------------- */
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
const WEEK = ["السبت", "الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"];
const weekdayOf = iso => WEEK[(new Date(iso + "T12:00:00").getDay() + 1) % 7];

function renderAnalysis() {
  state.charts.forEach(c => c.destroy()); state.charts = [];
  const el = $("#view-analysis");
  if (!state.admin) return adminOnly(el);
  const M = METRICS[state.metric];
  const rA = rangeOf(state.cmpA.preset, state.cmpA.from, state.cmpA.to);
  const rB = rangeOf(state.cmpB.preset, state.cmpB.from, state.cmpB.to);
  const rowsA = rowsIn(rA).filter(inDept), rowsB = rowsIn(rB).filter(inDept);
  const A = agg(rowsA), B = agg(rowsB);
  const perDay = (a, k) => a.nDays ? a[k] / a.nDays : 0;

  const metricsRows = [
    ["الجلسات", A.sessions, B.sessions, false], ["الحالات", A.cases, B.cases, false], ["محضرش (كنسل)", A.noShow, B.noShow, true],
    ["العلاجات", A.treatTotal, B.treatTotal, false], ["الدكاترة", A.doctors, B.doctors, false], ["أيام الشغل", A.nDays, B.nDays, false],
  ];
  const keyOf = r => [r.dept, r.sub ? r.dept + "::" + r.sub : null];
  const deptsA = new Map(), deptsB = new Map();
  for (const [m, rows] of [[deptsA, rowsA], [deptsB, rowsB]])
    for (const r of rows) for (const k of keyOf(r)) if (k) { if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  const deptNames = [...new Set([...deptsA.keys(), ...deptsB.keys()])];
  const dAll = deptNames.map(k => ({ k, a: agg(deptsA.get(k) || []), b: agg(deptsB.get(k) || []) }));
  const dRows = dAll.filter(d => !d.k.includes("::")).sort((x, y) => valOf(y.a) - valOf(x.a))
    .flatMap(d => [d, ...dAll.filter(x => x.k.startsWith(d.k + "::")).sort((x, y) => x.k.localeCompare(y.k))]);
  const docsA = groupBy(rowsA, r => r.id), docsB = groupBy(rowsB, r => r.id);
  const docIds = [...new Set([...docsA.keys(), ...docsB.keys()])];
  const docRows = docIds.map(id => {
    const va = docsA.get(id) || [], vb = docsB.get(id) || [];
    const last = (va[va.length - 1] || vb[vb.length - 1]);
    return { id, name: last.name, dept: last.dept, sub: last.sub, a: agg(va), b: agg(vb) };
  }).sort((x, y) => (valOf(y.a) - valOf(y.b)) - (valOf(x.a) - valOf(x.b)));

  el.innerHTML = `<div class="toolbar"><div class="day-title"><h2>المقارنة والرسوم</h2><div class="sub">قارن أي فترتين: شهر بشهر، أسبوع بأسبوع، أو تواريخ تختارها</div></div></div>
    <div class="card filters">
      <div class="cmp-head"><span class="tag a">الفترة الأولى</span>${periodPicker("a", state.cmpA)}</div>
      <div class="cmp-head"><span class="tag b">الفترة التانية</span>${periodPicker("b", state.cmpB)}</div>
      <div class="filter-row">${deptSelectBar()}${metricChips()}</div><p class="hint">${sourceNote()}</p>
    </div>
    ${!rowsA.length && !rowsB.length ? noData("مفيش أرقام في الفترتين دول") : `
    <section class="card block">
      <h3>الأرقام جنب بعض</h3>
      <p class="hint">الفترة الأولى: ${rangeLabel(rA)} · التانية: ${rangeLabel(rB)}. لو الفترتين مش نفس عدد الأيام، قارن «في اليوم».</p>
      <div class="table-wrap"><table class="stats rep">
        <thead><tr><th class="nm"></th><th>الفترة الأولى</th><th>الفترة التانية</th><th>الفرق</th><th>الأولى / يوم</th><th>التانية / يوم</th><th>الفرق في اليوم</th></tr></thead>
        <tbody>${metricsRows.map(([l, a, b, bad]) => {
          const key = { "الجلسات": "sessions", "الحالات": "cases", "محضرش (كنسل)": "noShow", "العلاجات": "treatTotal" }[l];
          const d = bad ? deltaBad : delta;
          return `<tr><td class="nm">${l}</td><td><b>${fmtN(a)}</b></td><td>${fmtN(b)}</td><td>${d(a, b)}</td>
            ${key ? `<td>${fmtN(perDay(A, key))}</td><td>${fmtN(perDay(B, key))}</td><td>${d(perDay(A, key), perDay(B, key))}</td>` : "<td></td><td></td><td></td>"}</tr>`; }).join("")}
          <tr><td class="nm">نسبة الكنسل</td><td><b>${fmtP(A.rate)}</b></td><td>${fmtP(B.rate)}</td><td>${deltaBad(A.rate, B.rate)}</td><td></td><td></td><td></td></tr>
        </tbody>
      </table></div>
    </section>

    <section class="card block">
      <h3>الأقسام</h3>
      <div class="table-wrap"><table class="stats rep">
        <thead><tr><th class="nm">القسم</th><th>${M.many} الأولى</th><th>${M.many} التانية</th><th>الفرق</th><th>كنسل الأولى</th><th>كنسل التانية</th><th>العلاجات الأولى</th><th>العلاجات التانية</th></tr></thead>
        <tbody>${dRows.map(({ k, a, b }) => `<tr class="${k.includes("::") ? "subrow" : ""}"><td class="nm">${k.includes("::") ? `<span class="subtag">${esc(SUB_LABEL[k.split("::")[1]] || k.split("::")[1])}</span>` : deptCell(k)}</td><td><b>${fmtN(valOf(a))}</b></td><td>${fmtN(valOf(b))}</td><td>${delta(valOf(a), valOf(b))}</td>
          <td>${fmtP(a.rate)}</td><td>${fmtP(b.rate)}</td><td>${fmtN(a.treatTotal)}</td><td>${fmtN(b.treatTotal)}</td></tr>`).join("")}</tbody>
      </table></div>
    </section>

    <section class="card block">
      <h3>الدكاترة: مين زاد ومين قلّ</h3>
      <div class="table-wrap"><table class="stats rep">
        <thead><tr><th class="nm">الدكتور</th><th>القسم</th><th>${M.many} الأولى</th><th>${M.many} التانية</th><th>الفرق</th><th>نسبة الكنسل الأولى</th><th>التانية</th></tr></thead>
        <tbody>${docRows.map(d => `<tr><td class="nm">${esc(d.name)}</td><td>${subCell(d.dept, d.sub)}</td><td><b>${fmtN(valOf(d.a))}</b></td><td>${fmtN(valOf(d.b))}</td>
          <td>${valOf(d.a) - valOf(d.b) > 0 ? "+" : ""}${fmtN(valOf(d.a) - valOf(d.b))} ${delta(valOf(d.a), valOf(d.b))}</td><td>${fmtP(d.a.rate)}</td><td>${fmtP(d.b.rate)}</td></tr>`).join("")}</tbody>
      </table></div>
    </section>

    <div class="charts">
      <div class="card chart-card"><h3>${M.many} كل يوم · الفترة الأولى</h3><p>حضر ومحضرش</p><div class="chart-box"><canvas id="cDay"></canvas></div></div>
      <div class="card chart-card"><h3>متوسط ${M.many} حسب يوم الأسبوع</h3><p>الفترة الأولى مقابل التانية</p><div class="chart-box"><canvas id="cWeek"></canvas></div></div>
      <div class="card chart-card"><h3>${M.many} حسب القسم</h3><p>الفترة الأولى مقابل التانية</p><div class="chart-box"><canvas id="cSec"></canvas></div></div>
      <div class="card chart-card"><h3>أكتر العلاجات</h3><p>الفترة الأولى مقابل التانية</p><div class="chart-box"><canvas id="cTreat"></canvas></div></div>
    </div>`}`;

  bindPeriod(el, "a", state.cmpA, renderAnalysis);
  bindPeriod(el, "b", state.cmpB, renderAnalysis);
  bindCommon(el, renderAnalysis);
  if (!window.Chart || (!rowsA.length && !rowsB.length)) return;

  const C = window.Chart;
  const ink = cssVar("--text-2"), grid = cssVar("--line"), good = cssVar("--good"), bad = cssVar("--bad"), navy = cssVar("--brand"), sky = cssVar("--series-1");
  C.defaults.font.family = "IBM Plex Sans Arabic, system-ui, sans-serif";
  C.defaults.color = ink;
  const base = { maintainAspectRatio: false, animation: { duration: 250 },
    plugins: { legend: { labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { rtl: true, intersect: false, mode: "index" } } };
  const bar = { borderRadius: 4, borderSkipped: "start", maxBarThickness: 22 };
  const axes = (stacked = false) => ({ x: { stacked, grid: { display: false } }, y: { stacked, grid: { color: grid }, ticks: { precision: 0 } } });

  const days = [...groupBy(rowsA, r => r.date)].sort((x, y) => x[0].localeCompare(y[0])).map(([d, v]) => ({ d, a: agg(v) }));
  state.charts.push(new C($("#cDay"), { type: "bar",
    data: { labels: days.map(x => shortDate(x.d)), datasets: [
      { label: "حضر", data: days.map(x => valOf(x.a)), backgroundColor: good, ...bar, stack: "s" },
      { label: "محضرش", data: days.map(x => x.a.noShow), backgroundColor: bad, ...bar, stack: "s" }] },
    options: { ...base, scales: axes(true) } }));

  const wk = rows => WEEK.map(w => { const v = rows.filter(r => weekdayOf(r.date) === w); const n = new Set(v.map(r => r.date)).size; return n ? Math.round(v.reduce((x, r) => x + valOf(r), 0) / n) : 0; });
  state.charts.push(new C($("#cWeek"), { type: "bar",
    data: { labels: WEEK, datasets: [{ label: "الأولى", data: wk(rowsA), backgroundColor: navy, ...bar }, { label: "التانية", data: wk(rowsB), backgroundColor: sky, ...bar }] },
    options: { ...base, scales: axes() } }));

  state.charts.push(new C($("#cSec"), { type: "bar",
    data: { labels: dRows.map(x => x.k), datasets: [{ label: "الأولى", data: dRows.map(x => valOf(x.a)), backgroundColor: navy, ...bar }, { label: "التانية", data: dRows.map(x => valOf(x.b)), backgroundColor: sky, ...bar }] },
    options: { ...base, scales: axes() } }));

  const tn = Object.entries(A.treat).sort((x, y) => y[1] - x[1]).slice(0, 10).map(x => x[0]);
  state.charts.push(new C($("#cTreat"), { type: "bar",
    data: { labels: tn, datasets: [{ label: "الأولى", data: tn.map(t => A.treat[t] || 0), backgroundColor: navy, ...bar }, { label: "التانية", data: tn.map(t => B.treat[t] || 0), backgroundColor: sky, ...bar }] },
    options: { ...base, indexAxis: "y", scales: { x: { grid: { color: grid }, ticks: { precision: 0 } }, y: { grid: { display: false } } } } }));
}

/* ---------------- boot ---------------- */
(async function boot() {
  state.store = await createStore();
  $("#demoTag").hidden = !state.store.demo;
  state.store.onAuth(isAdmin => {
    state.admin = isAdmin;
    $("#adminBtn").classList.toggle("on", isAdmin);
    $("#adminBtn").textContent = isAdmin ? "🔓 أدمن" : "🔒 أدمن";
    document.querySelectorAll('.tabs [data-view="stats"], .tabs [data-view="analysis"]').forEach(b => b.hidden = !isAdmin);
    document.querySelector(".tabs").classList.toggle("solo", !isAdmin);
    if (isAdmin && !state.unsubStats) {
      state.unsubStats = state.store.onStats(st => { state.stats = st; if (state.view !== "today") render(); else renderToday(); });
    }
    if (!isAdmin) {
      if (state.unsubStats) { state.unsubStats(); state.unsubStats = null; }
      state.stats = [];
      state.override = false; followPick();
      if (state.view !== "today") { setView("today"); return; }
    }
    render();
  });
  state.store.onSettings(s => { state.settings = { depts: {}, assign: {}, subs: {}, ...s }; render(); });
  const askedView = new URLSearchParams(location.search).get("view");  // ?view=stats|analysis (admin)
  if (state.admin && ["stats", "analysis"].includes(askedView)) setView(askedView);
  const askedDay = new URLSearchParams(location.search).get("day");   // ?day=YYYY-MM-DD opens that day
  if (/^\d{4}-\d{2}-\d{2}$/.test(askedDay || "")) { state.override = true; watchDay(askedDay); }
  state.store.onOpenDays(onOpenDays);
  setInterval(followPick, 30000);          // midnight / 9 AM roll-over while the page stays open
  render();
})();
