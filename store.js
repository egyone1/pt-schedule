// Data layer: Firebase (live) or localStorage (demo, when config.js has no apiKey).
import { firebaseConfig, ADMIN_EMAIL } from "./config.js?v=13";

// Treatment codes the secretaries write in a booking ("mt+es+us", "mt*2", "hot mgt") -> one name each.
// Keep in step with importer/codes.py (same list, same rules).
const TREATMENTS = {
  mt: "MT", es: "ES", us: "US", ex: "EX", laser: "Laser", "scanner laser": "Laser", shockwave: "Shockwave", shock: "Shockwave",
  "hot mgt": "Hot pack / Magnet", hotmgt: "Hot pack / Magnet", mgt: "Hot pack / Magnet", hotpak: "Hot pack / Magnet", "hot pack": "Hot pack / Magnet",
  balance: "Balance", gait: "Gait", pb: "PB", schroth: "Schroth", scroth: "Schroth", shroth: "Schroth",
  aq: "Aqua", ot: "OT", mld: "MLD", bandage: "Bandaging", bandaging: "Bandaging", comp: "Compression", pressure: "Compression",
  "lymph press": "Compression", chest: "Chest", tilt: "Tilt table", thera: "Thera", wb: "WB", standing: "Standing",
  biofeedback: "Biofeedback", "biofeed back": "Biofeedback", bladder: "Bladder rehab", speech: "Speech", release: "Release",
  bibatron: "Bibatron", tecar: "Tecar", traction: "Traction",
};
export function treatmentsOf(details) {
  const out = {};
  for (const part of String(details || "").toLowerCase().split(/[+·,/\n]/)) {
    const times = /[*x×]\s*2|2\s*[*x×]|^\s*2\s*[a-z]|[a-z]\s*2\s*$/.test(part) ? 2 : 1;   // mt*2, mtx2, 2mt, mt2
    const key = part.replace(/[*x×]?\s*\d+|\d+\s*[*x×]/g, "").replace(/^[\s*"']+|[\s*"']+$/g, "");
    const name = TREATMENTS[key];
    if (name) out[name] = (out[name] || 0) + times;
  }
  return out;
}
const addTreat = (into, sessions) => {
  for (const s of sessions) for (const [t, n] of Object.entries(treatmentsOf(s.details))) into[t] = (into[t] || 0) + n;
  return into;
};

// Two views of one day: what the doctors marked, and what the booking sheet shows (red = cancelled).
export function summarize(day) {
  const out = {};
  for (const [key, d] of Object.entries(day.doctors || {})) {
    const ss = d.sessions || [];
    const came = ss.filter(s => s.status === 1), sheetCame = ss.filter(s => s.sheet !== "red");
    out[key] = {
      name: d.name,
      section: d.section || "",
      submitted: !!d.submitted,
      booked: ss.reduce((a, s) => a + (s.units || 1), 0),
      attended: came.reduce((a, s) => a + (s.units || 1), 0),
      cases: came.length,
      noShow: ss.filter(s => s.status === 2).length,
      unmarked: ss.filter(s => !s.status).length,
      treat: addTreat({}, came),
      sheet: {
        sessions: sheetCame.reduce((a, s) => a + (s.units || 1), 0),
        cases: sheetCame.length,
        cancelled: ss.filter(s => s.sheet === "red").length,
        treat: addTreat({}, sheetCame),
      },
    };
  }
  return out;
}

const allSubmitted = day => Object.values(day.doctors || {}).every(d => d.submitted);
const nowIso = () => new Date().toISOString();

/* ---------------- Firebase ---------------- */
async function firebaseStore() {
  const V = "10.14.1";
  const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
  const fs = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);
  const au = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
  const app = initializeApp(firebaseConfig);
  const db = fs.getFirestore(app);
  const auth = au.getAuth(app);
  const dayRef = date => fs.doc(db, "days", date);

  return {
    demo: false,
    onAuth: cb => au.onAuthStateChanged(auth, u => cb(!!u && u.email === ADMIN_EMAIL)),
    login: (email, pw) => au.signInWithEmailAndPassword(auth, email, pw),
    logout: () => au.signOut(auth),

    onOpenDays(cb) {
      return fs.onSnapshot(fs.query(fs.collection(db, "days"), fs.where("status", "==", "open")),
        snap => cb(snap.docs.map(d => d.data()).sort((a, b) => b.date.localeCompare(a.date))));
    },
    onDay(date, cb) {
      return fs.onSnapshot(dayRef(date), s => cb(s.exists() ? s.data() : null));
    },
    onStats(cb) {
      return fs.onSnapshot(fs.collection(db, "stats"), snap => cb(snap.docs.map(d => d.data())));
    },
    onSettings(cb) {
      return fs.onSnapshot(fs.doc(db, "settings", "departments"), s => cb(s.exists() ? s.data() : {}));
    },
    saveSettings: data => fs.setDoc(fs.doc(db, "settings", "departments"), data),
    // sheet link + last import result (admin only - the sheet has patient phone numbers)
    getSource: async () => { const x = await fs.getDoc(fs.doc(db, "private", "source")); return x.exists() ? x.data() : {}; },
    saveSource: url => fs.setDoc(fs.doc(db, "private", "source"), { shareUrl: url, changedAt: nowIso() }, { merge: true }),
    async setSessions(date, key, sessions, dayClosed) {
      await fs.updateDoc(dayRef(date), { [`doctors.${key}.sessions`]: sessions, updatedAt: nowIso() });
      if (dayClosed) await this._restat(date);         // totals only change once the day is closed
    },
    async setSubmitted(date, key, value) {
      // returns true when this submit closed the day
      return fs.runTransaction(db, async tx => {
        const snap = await tx.get(dayRef(date));
        const day = snap.data();
        day.doctors[key].submitted = value;
        const patch = { [`doctors.${key}.submitted`]: value, [`doctors.${key}.submittedAt`]: value ? nowIso() : null };
        if (value) patch[`doctors.${key}.changedAt`] = null;      // re-submitted -> warning done
        let closed = false;
        if (value && day.status === "open" && allSubmitted(day)) {
          patch.status = "closed"; patch.closedAt = nowIso(); closed = true;
        }
        if (closed || day.status === "closed")
          tx.set(fs.doc(db, "stats", date), { date, doctors: summarize(day) });
        tx.update(dayRef(date), patch);
        return closed;
      });
    },
    async setStatus(date, status) {
      const snap = await fs.getDoc(dayRef(date));
      const day = snap.data();
      const batch = fs.writeBatch(db);
      batch.update(dayRef(date), { status, closedAt: status === "closed" ? nowIso() : null });
      if (status === "closed") batch.set(fs.doc(db, "stats", date), { date, doctors: summarize(day) });
      await batch.commit();
    },
    async deleteDays(dates) {
      for (let i = 0; i < dates.length; i += 200) {
        const batch = fs.writeBatch(db);
        for (const d of dates.slice(i, i + 200)) { batch.delete(dayRef(d)); batch.delete(fs.doc(db, "stats", d)); }
        await batch.commit();
      }
    },
    async _restat(date) {
      const snap = await fs.getDoc(dayRef(date));
      const day = snap.data();
      if (day && day.status === "closed")
        await fs.setDoc(fs.doc(db, "stats", date), { date, doctors: summarize(day) });
    },
  };
}

/* ---------------- Demo (localStorage) ---------------- */
async function demoStore() {
  const KEY = "pt-schedule-demo";
  let data;
  try { data = JSON.parse(localStorage.getItem(KEY)); } catch { data = null; }
  if (!data) {
    try { data = await (await fetch("demo/seed.json")).json(); } catch { data = { days: {}, stats: {} }; }
  }
  const subs = new Set();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {} subs.forEach(f => f()); };
  const sub = f => { subs.add(f); f(); return () => subs.delete(f); };
  const clone = o => JSON.parse(JSON.stringify(o));
  let admin = new URLSearchParams(location.search).has("admin"); const authSubs = new Set();   // demo only: ?demo&admin

  return {
    demo: true,
    onAuth: cb => { authSubs.add(cb); cb(admin); return () => authSubs.delete(cb); },
    login: async (email, pw) => {
      if (pw !== "demo") throw new Error("wrong");
      admin = true; authSubs.forEach(f => f(true));
    },
    logout: async () => { admin = false; authSubs.forEach(f => f(false)); },
    onOpenDays: cb => sub(() => cb(Object.values(data.days).filter(d => d.status === "open").map(clone)
      .sort((a, b) => b.date.localeCompare(a.date)))),
    onDay: (date, cb) => sub(() => cb(data.days[date] ? clone(data.days[date]) : null)),
    onStats: cb => sub(() => cb(Object.values(data.stats).map(clone))),
    onSettings: cb => sub(() => cb(clone(data.settings || {}))),
    async saveSettings(s) { data.settings = s; save(); },
    getSource: async () => ({ ...(data.source || {}) }),
    async saveSource(url) { data.source = { ...(data.source || {}), shareUrl: url, changedAt: nowIso() }; save(); },
    async setSessions(date, key, sessions) {
      const day = data.days[date];
      day.doctors[key].sessions = sessions;
      if (day.status === "closed") data.stats[date] = { date, doctors: summarize(day) };
      save();
    },
    async setSubmitted(date, key, value) {
      const day = data.days[date];
      day.doctors[key].submitted = value;
      let closed = false;
      if (value && day.status === "open" && allSubmitted(day)) { day.status = "closed"; closed = true; }
      if (day.status === "closed") data.stats[date] = { date, doctors: summarize(day) };
      save();
      return closed;
    },
    async setStatus(date, status) {
      const day = data.days[date];
      day.status = status;
      if (status === "closed") data.stats[date] = { date, doctors: summarize(day) };
      save();
    },
    async deleteDays(dates) {
      for (const d of dates) { delete data.days[d]; delete data.stats[d]; }
      save();
    },
    resetDemo() { localStorage.removeItem(KEY); location.reload(); },
  };
}

export async function createStore() {
  const forceDemo = new URLSearchParams(location.search).has("demo");   // ?demo = local sandbox
  return firebaseConfig.apiKey && !forceDemo ? firebaseStore() : demoStore();
}
