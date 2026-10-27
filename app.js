import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
         doc, getDoc, setDoc, updateDoc, deleteField, onSnapshot,
         collection, query, where, limit, getDocs, serverTimestamp, runTransaction, deleteDoc }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { SEED_DAYS, SEED_LIBRARY } from "./seed.js";

/* ---------- costanti ---------- */
const ADMIN_EMAIL = "kataxsecret@gmail.com";
const GROUPS = ["Petto", "Dorso", "Spalle", "Bicipiti", "Tricipiti", "Gambe", "Core"];
const LIFTS = [
  ["squat", "Squat", false], ["panca", "Panca piana", false], ["stacco", "Stacco", false],
  ["military", "Military Press", false], ["pullup", "Pull Up", true], ["dips", "Dips", true]
];
const PCTS = []; for (let p = 35; p <= 100; p += 5) PCTS.push(p);

/* ---------- helper ---------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const newId = () => "r" + Math.random().toString(36).slice(2, 8);
const num = (v) => parseFloat(String(v ?? "").replace(",", "."));
const clone = (o) => JSON.parse(JSON.stringify(o));
const nk = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
let normChanged = false;
const view = $("#view"), hdr = $("#hdr"), nav = $("#nav");

/* ---------- stato ---------- */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
let user = null, activeUid = null, ref = null, unsub = null, plan = null, rendered = false;
let dirCache = [];   // solo admin: [{uid, email, name, alias}]
const ui = { tab: "scheda", day: 0, week: 0, edit: false };
let lastUi = "";
const uiKey = () => `scheda:ui:${user?.uid}:${activeUid}`;
function restoreUi() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(uiKey()) || "null"); } catch {}
  if (!s && activeUid === user?.uid) s = plan?.ui;      // browser svuotato: usa la copia su Firestore
  if (s && (s.pid || "") !== (plan?.planId || "")) s = null;   // la scheda e' cambiata: riparti dall'inizio
  ui.tab = ["scheda", "calc", "opz"].includes(s?.tab) ? s.tab : "scheda";
  ui.day = Number.isInteger(s?.day) && s.day >= 0 ? s.day : 0;
  ui.week = Number.isInteger(s?.week) && s.week >= 0 ? s.week : 0;
  ui.edit = false;
  lastUi = JSON.stringify({ tab: ui.tab, day: ui.day, week: ui.week, pid: plan?.planId || "" });
}
function saveUi() {
  const s = { tab: ui.tab, day: ui.day, week: ui.week, pid: plan?.planId || "" }, j = JSON.stringify(s);
  if (j === lastUi) return; lastUi = j;
  try { localStorage.setItem(uiKey(), j); } catch {}
  if (activeUid === user?.uid)                           // solo sulla propria scheda
    debounced("ui", 1000, () => { if (activeUid === user?.uid && ref) save({ ui: s }); });
}
const timers = new Map();

/* ---------- serie e carichi ---------- */
function seriesOf(scheme) {
  const p = String(scheme ?? "").split("/").map((x) => x.trim()).filter(Boolean);
  return p.length > 1 ? p : null;
}
const kgKey = (id, w, s) => (s ? `${id}_${w}_${s}` : `${id}_${w}`);

/* ---------- annulla / ripeti ---------- */
const hist = { undo: [], redo: [], typing: null };
const snapStruct = () => clone({ days: plan.days, library: plan.library, weeks: plan.weeks, title: plan.title, rm: plan.rm });
function pushUndo() {
  if (!plan) return;
  hist.undo.push({ s: snapStruct(), kgLost: {} });
  if (hist.undo.length > 50) hist.undo.shift();
  hist.redo = []; hist.typing = null;
}
function typing(key) {
  if (hist.typing !== key) { pushUndo(); hist.typing = key; }
}
function restoreStruct(s) {
  Object.assign(plan, clone(s)); normalize(plan); saveStruct();
}
function undo() {
  const e = hist.undo.pop(); if (!e) return;
  hist.redo.push({ s: snapStruct(), kgLost: e.kgLost });
  restoreStruct(e.s);
  for (const [k, v] of Object.entries(e.kgLost))
    if (!(k in plan.kg)) { plan.kg[k] = v; save({ ["kg." + k]: v }); }
  hist.typing = null; render();
}
function redo() {
  const e = hist.redo.pop(); if (!e) return;
  hist.undo.push({ s: snapStruct(), kgLost: e.kgLost });
  restoreStruct(e.s);
  for (const k of Object.keys(e.kgLost))
    if (k in plan.kg) { delete plan.kg[k]; save({ ["kg." + k]: deleteField() }); }
  hist.typing = null; render();
}

/* ---------- salvataggio ---------- */
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}
function onErr(e) {
  console.error(e);
  toast(e.code === "permission-denied"
    ? "Permesso negato: account non autorizzato o regole Firestore non pubblicate."
    : "Errore di salvataggio: " + (e.message || e));
}
function save(fields) { return updateDoc(ref, fields).catch(onErr); }
function debounced(key, ms, fn) {
  clearTimeout(timers.get(key)?.id);
  timers.set(key, { fn, id: setTimeout(() => { timers.delete(key); fn(); }, ms) });
}
function flushSaves() {            // da chiamare PRIMA di cambiare ref/plan
  const pending = [...timers.values()]; timers.clear();
  pending.forEach(({ id, fn }) => { clearTimeout(id); fn(); });
}
const saveKg = (key, val) => debounced("kg" + key, 500,
  () => save({ ["kg." + key]: val === "" ? deleteField() : val }));
const saveRm = (path, val) => debounced("rm" + path, 500, () => save({ ["rm." + path]: val }));
const saveStruct = () => debounced("struct", 400, () => save(clone(
  { days: plan.days, library: plan.library, weeks: plan.weeks, title: plan.title, rm: plan.rm })));

/* ---------- dati ---------- */
function normalize(p) {
  p.title ??= "Scheda"; p.weeks ??= 5; p.days ??= []; p.library ??= clone(SEED_LIBRARY);
  p.rm ??= {}; p.rm.bw ??= ""; p.rm.lifts ??= {}; p.kg ??= {};
  for (const g of Object.keys(p.library)) {            // rubrica: pulizia e dedup
    const src = p.library[g] || [], seen = new Set(), out = [];
    for (const x of src) { const t = tidy(x), k = nk(t); if (t && !seen.has(k)) { seen.add(k); out.push(t); } }
    if (out.length !== src.length || out.some((x, i) => x !== src[i])) normChanged = true;
    p.library[g] = out;
  }
  p.days.forEach((d) => { d.rows ??= []; d.rows.forEach((r) => {
    r.id ??= newId(); r.scheme ??= []; r.rest ??= ""; r.ex ??= "";
    while (r.scheme.length < p.weeks) r.scheme.push("");
    const grp = GROUPS.find((g) => nk(g) === nk(r.group));
    if (grp && grp !== r.group) { r.group = grp; normChanged = true; }
    const t = tidy(r.ex);
    if (t && r.group) {                                // allinea alla rubrica o aggiungilo
      const lib = (p.library[r.group] ??= []);
      const hit = lib.find((x) => nk(x) === nk(t));
      if (hit) { if (r.ex !== hit) { r.ex = hit; normChanged = true; } }
      else { lib.push(t); r.ex = t; normChanged = true; }
    } else if (!t) r.ex = "";
  }); });
  return p;
}
function buildPlan(withSeed) {
  const days = withSeed ? clone(SEED_DAYS) : [{ name: "Giorno 1", rows: [] }];
  return normalize({ title: withSeed ? "Scheda base" : "La mia scheda", weeks: 5, days,
    library: clone(SEED_LIBRARY), rm: { bw: "", lifts: {} }, kg: {}, createdAt: Date.now() });
}
function findRow(id) {
  for (const d of plan.days) for (let i = 0; i < d.rows.length; i++)
    if (d.rows[i].id === id) return { d, i, r: d.rows[i] };
  return null;
}
const inLib = (g, ex) => (plan.library[g] || []).some((x) => nk(x) === nk(ex));
const hasKg = (id) => Object.keys(plan.kg).some((k) => k.startsWith(id + "_"));
function clearRowKg(id) {
  const lost = hist.undo.at(-1)?.kgLost;
  Object.keys(plan.kg).filter((k) => k.startsWith(id + "_")).forEach((k) => {
    if (lost) lost[k] = plan.kg[k];
    delete plan.kg[k]; save({ ["kg." + k]: deleteField() });
  });
}
function setExercise(r, name) {
  if (r.ex && r.ex !== name && hasKg(r.id) &&
      confirm("Su questa riga hai gia' dei kg segnati.\nOK = azzerali (l'esercizio cambia)\nAnnulla = mantienili"))
    clearRowKg(r.id);
  r.ex = name;
}

/* ---------- schermate ---------- */
function showLogin() {
  hdr.innerHTML = `<b>Scheda allenamento</b>`; nav.innerHTML = "";
  view.innerHTML = `<div class="center"><h1>Scheda allenamento</h1>
    <p>Accedi con Google per aprire la tua scheda.</p>
    <button class="btn" data-a="login">Accedi con Google</button></div>`;
}
function showMsg(html) { nav.innerHTML = ""; renderHeader();
  view.innerHTML = `<div class="center">${html}</div>`; }

function showOnboarding() {
  showMsg(`<h1>Imposta Scheda</h1><p>Scegli da quale scheda partire per l'utente selezionato:</p>
    <p><button class="btn" data-a="seed">Scheda base (4 giorni)</button></p>
    <p><button class="btn ghost" data-a="empty">Scheda vuota</button></p>
    <p class="note">La libreria esercizi sara' inclusa e potrai modificare tutto liberamente.</p>`);
}

function renderHeader() {
  const isAdmin = user?.email === ADMIN_EMAIL;
  hdr.innerHTML = `<b>${esc(plan?.title || "Scheda allenamento")}</b>
    <div><span>${esc((user?.displayName || user?.email || "").split(" ")[0])}${isAdmin ? " (Admin)" : ""}</span>
    <button data-a="logout">Esci</button></div>`;
}

function renderAdminSection() {
  if (user?.email !== ADMIN_EMAIL) return "";
  const isViewingOther = activeUid && activeUid !== user?.uid;
  const cur = dirCache.find((x) => x.uid === activeUid);
  const currentKey = cur?.email || cur?.alias || "";
  return `<div class="admin-card" style="margin-top:20px;">
    <h3>Pannello Amministrazione Clienti</h3>
    <div class="erow">
      <input type="text" id="adminTargetUid" list="adminUsers" placeholder="Email, alias o UID" value="${isViewingOther ? esc(currentKey || activeUid) : ""}" style="flex:1">
      <datalist id="adminUsers"></datalist>
      <button class="btn" data-a="admin-load">Carica Utente</button>
      ${isViewingOther ? `<button class="btn ghost" data-a="admin-reset">Torna alla Mia Scheda</button>` : ""}
    </div>
    ${isViewingOther ? `<div class="erow" style="margin-top:8px;justify-content:space-between;align-items:center">
      <span class="note" style="color:var(--pri)">UID effettivo: <b>${esc(activeUid)}</b></span>
      <button class="btn ghost" data-a="set-alias" style="padding:4px 8px;font-size:12px">+ Associa Alias / Email</button>
    </div>` : ""}
  </div>`;
}

function render() {
  if (!plan) return;
  rendered = true; renderHeader();
  nav.innerHTML = [["scheda", "Scheda"], ["calc", "Calcolatore"], ["opz", "Impostazioni"]]
    .map(([t, l]) => `<button data-a="tab" data-t="${t}" class="${ui.tab === t ? "on" : ""}">${l}</button>`).join("");
  view.innerHTML = ui.preview ? viewPreview() : (ui.tab === "scheda" ? viewScheda() : ui.tab === "calc" ? viewCalc() : viewOpz());
  if (ui.tab === "calc") updateCalc();
  if (ui.tab === "opz" && !ui.preview) { fillDirList(); fillExtras(); if (extrasFor !== activeUid) loadExtras(); }
}

/* --- scheda --- */
function viewScheda() {
  if (ui.day >= plan.days.length) ui.day = Math.max(0, plan.days.length - 1);
  if (ui.week >= plan.weeks) ui.week = plan.weeks - 1;
  const d = plan.days[ui.day];
  const dayChips = plan.days.map((x, i) =>
    `<button class="chip ${i === ui.day ? "on" : ""}" data-a="day" data-i="${i}">${esc(x.name)}</button>`).join("");
  const weekChips = Array.from({ length: plan.weeks }, (_, w) =>
    `<button class="chip ${w === ui.week ? "on" : ""}" data-a="week" data-i="${w}">S${w + 1}</button>`).join("");
  let h = `<div class="chips">${dayChips}${ui.edit ? `<button class="chip" data-a="add-day">+ giorno</button>` : ""}</div>
    <div class="chips">${weekChips}</div>
    <div class="bar ${ui.edit ? "sticky" : ""}"><span class="sm">${d ? d.rows.length : 0} esercizi</span>
    <span class="grp">${ui.edit ? `<button class="chip ic" data-a="undo" aria-label="Annulla" ${hist.undo.length ? "" : "disabled"}>&#8630; Annulla</button>
    <button class="chip ic" data-a="redo" aria-label="Ripeti" ${hist.redo.length ? "" : "disabled"}>&#8631;</button>` : ""}
    <button class="chip ${ui.edit ? "on" : ""}" data-a="edit">${ui.edit ? "Fine modifica" : "Modifica scheda"}</button></span></div>`;
  if (!d) return h + `<p class="note">Nessun giorno: premi "Modifica scheda" e aggiungi un giorno.</p>`;
  if (ui.edit) {
    h += `<div class="card"><div class="erow"><label style="flex:1">Titolo scheda
      <input type="text" data-f="title" value="${esc(plan.title)}"></label>
      <label style="flex:1">Nome giorno
      <input type="text" data-f="dayname" value="${esc(d.name)}"></label></div>
      <div class="erow"><span class="sm">Settimane: ${plan.weeks}</span>
      <button data-a="weeks-">-</button><button data-a="weeks+">+</button>
      <button class="danger" data-a="del-day">Elimina giorno</button></div></div>`;
    h += d.rows.map((r, i) => cardEdit(r, i, d.rows.length)).join("");
    return h + `<button class="btn" data-a="add-row">+ Aggiungi esercizio</button>`;
  }
  const body = d.rows.map((r) => cardView(r, ui.week)).join("");
  return h + (body || `<p class="note">Giorno vuoto.</p>`);
}

function cardView(r, w) {
  const ser = seriesOf(r.scheme[w]), n = ser ? ser.length : 1;
  const box = (si) => {
    const key = kgKey(r.id, w, si), cur = plan.kg[key] ?? "", prev = w > 0 ? (plan.kg[kgKey(r.id, w - 1, si)] ?? "") : "";
    return { key, cur, prev };
  };
  const head = `<div class="card"><div class="top"><span class="badge">${esc(r.group)}</span>
    <span>&#9201; ${esc(r.rest || "-")}</span></div>
    <div class="ex">${esc(r.ex || "- scegli esercizio -")}</div>`;
  if (!ser) {
    const { key, cur, prev } = box(0);
    return head + `<div class="line"><div class="scheme">${esc(r.scheme[w] || "-")}</div>
    <label class="kg"><input type="text" inputmode="decimal" data-kg="${key}" value="${esc(cur)}"
      placeholder="${esc(prev)}" aria-label="kg"><span>kg</span></label></div>
    ${prev ? `<div class="hint">sett. prec.: ${esc(prev)} kg</div>` : ""}</div>`;
  }
  const boxes = Array.from({ length: n }, (_, si) => box(si));
  const prevs = boxes.map((b) => b.prev);
  return head + `<div class="line"><div class="scheme">${esc(r.scheme[w])}</div><span class="note">kg per serie</span></div>
    <div class="series">${boxes.map((b, si) => `<label class="sk"><span>${esc(ser[si])} rip</span>
      <input type="text" inputmode="decimal" data-kg="${b.key}" value="${esc(b.cur)}"
        placeholder="${esc(b.prev)}" aria-label="kg serie ${si + 1} (${esc(ser[si])} rip)"></label>`).join("")}</div>
    ${prevs.some(Boolean) ? `<div class="hint">sett. prec.: ${prevs.map((x) => esc(x || "-")).join(" / ")} kg</div>` : ""}</div>`;
}

function exOptions(r) {
  const list = [...(plan.library[r.group] || [])]
    .sort((a, b) => a.localeCompare(b, "it", { sensitivity: "base" }));
  const cur = list.find((x) => nk(x) === nk(r.ex));
  if (r.ex && !cur) list.unshift(r.ex);
  return `<option value="">- scegli -</option>` +
    list.map((x) => `<option ${x === (cur ?? r.ex) ? "selected" : ""}>${esc(x)}</option>`).join("") +
    `<option value="__new">+ Nuovo esercizio...</option>`;
}

function cardEdit(r, i, n) {
  return `<div class="card" data-row="${r.id}">
    <div class="erow"><select data-f="group">${GROUPS.map((g) =>
      `<option ${g === r.group ? "selected" : ""}>${g}</option>`).join("")}</select>
      <select data-f="ex">${exOptions(r)}</select></div>
    <div class="schemes">${Array.from({ length: plan.weeks }, (_, w) =>
      `<label>S${w + 1}<input type="text" data-f="scheme" data-w="${w}" value="${esc(r.scheme[w] || "")}"></label>`).join("")}</div>
    <div class="erow"><label>Rest<input type="text" data-f="rest" value="${esc(r.rest)}" size="6"></label>
      <button data-a="up" data-id="${r.id}" ${i === 0 ? "disabled" : ""}>&uarr;</button>
      <button data-a="down" data-id="${r.id}" ${i === n - 1 ? "disabled" : ""}>&darr;</button>
      <button class="danger" data-a="del-row" data-id="${r.id}">Elimina</button></div></div>`;
}

/* --- calcolatore --- */
function viewCalc() {
  return `<div class="erow"><label>Peso corporeo (kg)
    <input type="text" inputmode="decimal" data-rm="bw" value="${esc(plan.rm.bw)}"></label></div>
    <div class="tbl"><table><thead><tr><th>Alzata</th><th>1RM kg</th>${PCTS.map((p) => `<th>${p}%</th>`).join("")}</tr></thead><tbody>
    ${LIFTS.map(([k, name]) => `<tr><td>${name}</td>
      <td><input type="text" inputmode="decimal" data-rm="lift" data-k="${k}" value="${esc(plan.rm.lifts[k] ?? "")}"></td>
      ${PCTS.map((p) => `<td data-c="${k}|${p}"></td>`).join("")}</tr>`).join("")}
    </tbody></table></div>
    <p class="note">Squat, Panca, Stacco, Military: % x 1RM. Pull Up e Dips: % x (peso corporeo + 1RM aggiuntivo) - peso corporeo;
    un valore negativo = serve assistenza. Per Pull Up e Dips il 1RM e' il carico aggiunto al corpo.</p>`;
}
function updateCalc() {
  const bw = num(plan.rm.bw);
  LIFTS.forEach(([k, , bwBased]) => {
    const one = num(plan.rm.lifts[k]);
    PCTS.forEach((p) => {
      const c = view.querySelector(`[data-c="${k}|${p}"]`); if (!c) return;
      if (isNaN(one) || (bwBased && isNaN(bw))) { c.textContent = ""; return; }
      const v = bwBased ? (p / 100) * (bw + one) - bw : (p / 100) * one;
      c.textContent = v.toLocaleString("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    });
  });
}

/* --- impostazioni --- */
function viewOpz() {
  return `<div class="sec">Libreria esercizi</div>
    ${GROUPS.map((g) => `<details><summary>${g} (${(plan.library[g] || []).length})</summary>
      <div class="tags">${(plan.library[g] || []).map((x, i) => ({ x, i }))
        .sort((a, b) => a.x.localeCompare(b.x, "it", { sensitivity: "base" }))
        .map(({ x, i }) => `<span class="tag"><span>${esc(x)}</span><button data-a="lib-del" data-g="${g}" data-i="${i}">&times;</button></span>`).join("")}</div>
      <div class="erow"><input type="text" data-newex="${g}" placeholder="Nuovo esercizio" style="flex:1">
      <button class="btn" data-a="lib-add" data-g="${g}">Aggiungi</button></div></details>`).join("")}
    <div id="extras"></div>
    <div class="sec">Dati ed Esportazione / Importazione</div>
    <div class="erow">
      <button class="btn" data-a="export-excel">Esporta Excel (.xlsx)</button>
      <button class="btn ghost" data-a="export">Esporta backup (JSON)</button>
    </div>
    <div class="erow">
      <button class="btn ghost" data-a="import-file">Importa file (Excel / JSON)</button>
    </div>
    <div class="erow"><button class="btn danger" data-a="clear-kg">Azzera tutti i kg (nuovo blocco)</button></div>
    <p class="note">Puoi caricare file Excel (.xlsx, .xlsm, .xls) o backup in formato JSON.</p>
    ${renderAdminSection()}`;
}

/* ---------- esportazione / importazione excel e json ---------- */
function exportToExcel(src, meta = {}) {
  const p = src || plan;                                    // scheda attuale oppure una scheda dall'archivio
  const rm = { bw: p.rm?.bw ?? "", lifts: p.rm?.lifts ?? {} };
  const kgMap = p.kg || {};
  const lib = p.library || plan?.library || {};
  if (typeof XLSX === "undefined") return toast("Libreria XLSX in caricamento...");
  const wb = XLSX.utils.book_new();

  const sheetData = [];
  sheetData.push([`PROGRAMMA ATTUALE — ${p.title || "SCHEDA"} — ${meta.when || new Date().toLocaleDateString("it-IT")}`]);
  
  const header = ["Gruppo Muscolare", "Esercizio"];
  for (let w = 1; w <= p.weeks; w++) {
    header.push(`S${w}`);
    header.push("kg");
  }
  header.push("Rest");
  sheetData.push(header);

  p.days.forEach((day) => {
    sheetData.push([day.name.toUpperCase(), "", ...Array(p.weeks * 2 + 1).fill("")]);
    day.rows.forEach((r) => {
      const row = [r.group || "", r.ex || ""];
      for (let w = 0; w < p.weeks; w++) {
        row.push(r.scheme[w] || "");
        const ser = seriesOf(r.scheme[w]);
        if (ser) {
          const arr = ser.map((_, si) => kgMap[kgKey(r.id, w, si)] || "");
          const kgs = arr.some(Boolean) ? arr.join("/") : "";
          row.push(kgs);
        } else {
          row.push(kgMap[kgKey(r.id, w, 0)] || "");
        }
      }
      row.push(r.rest || "");
      sheetData.push(row);
    });
  });

  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  XLSX.utils.book_append_sheet(wb, ws, "Programma Attuale");

  const calcData = [];
  calcData.push(["CALCOLATORE MASSIMALI (1RM)"]);
  calcData.push(["Peso corporeo (kg)", rm.bw || ""]);
  calcData.push([]);
  
  const calcHeader = ["Alzata", "1RM (kg)", ...PCTS.map(p => `${p}%`)];
  calcData.push(calcHeader);

  const bw = num(rm.bw);
  LIFTS.forEach(([k, name, bwBased]) => {
    const one = num(rm.lifts[k]);
    const row = [name, rm.lifts[k] || ""];
    PCTS.forEach((p) => {
      if (isNaN(one) || (bwBased && isNaN(bw))) {
        row.push("");
      } else {
        const v = bwBased ? (p / 100) * (bw + one) - bw : (p / 100) * one;
        row.push(v.toFixed(1));
      }
    });
    calcData.push(row);
  });

  const wsCalc = XLSX.utils.aoa_to_sheet(calcData);
  XLSX.utils.book_append_sheet(wb, wsCalc, "Calcolatore %1RM");

  const libHeaders = GROUPS;
  const libRows = [libHeaders];
  const maxLen = Math.max(...GROUPS.map(g => (lib[g] || []).length), 1);
  for (let i = 0; i < maxLen; i++) {
    const row = GROUPS.map(g => (lib[g] || [])[i] || "");
    libRows.push(row);
  }
  const wsLib = XLSX.utils.aoa_to_sheet(libRows);
  XLSX.utils.book_append_sheet(wb, wsLib, "Libreria Esercizi");

  const fileName = meta.fileName || `Scheda_Modulare_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fileName);
  toast("File Excel esportato con successo!");
}

async function parseAndImportExcel(file, scheduleOn = null) {
  if (typeof XLSX === "undefined") return toast("Libreria XLSX in caricamento...");
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const workbook = XLSX.read(data, { type: 'array' });

    let sheet = workbook.Sheets['Programma Attuale'] || workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error("Foglio di calcolo non valido.");

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    if (!rows || rows.length === 0) throw new Error("File vuoto o non leggibile.");

    let title = "Scheda Importata";
    if (rows[0] && rows[0][0]) {
      const titleStr = String(rows[0][0]);
      if (titleStr.includes("PROGRAMMA ATTUALE")) title = titleStr.replace("PROGRAMMA ATTUALE — ", "").split(" — ")[0] || "Scheda Importata";
    }

    let headerRowIdx = 1;
    if (rows.length > 1 && !String(rows[1][0] || "").toLowerCase().includes("gruppo")) {
      for (let i = 0; i < Math.min(rows.length, 5); i++) {
        const rStr = JSON.stringify(rows[i]).toLowerCase();
        if (rStr.includes("gruppo") || rStr.includes("esercizio") || rStr.includes("s1")) {
          headerRowIdx = i;
          break;
        }
      }
    }

    const headerRow = rows[headerRowIdx] || [];
    const weekMap = [];
    let restColIdx = -1;

    headerRow.forEach((h, idx) => {
      const text = String(h || "").trim().toUpperCase();
      if (/^S[1-9][0-9]?$/.test(text)) {
        const wNum = parseInt(text.slice(1)) - 1;
        const nextColText = String(headerRow[idx + 1] || "").trim().toLowerCase();
        const kgCol = (nextColText === "kg") ? idx + 1 : -1;
        weekMap.push({ weekIdx: wNum, colS: idx, colKg: kgCol });
      }
      if (text === "REST" || text === "RECUPERO") {
        restColIdx = idx;
      }
    });

    const importedDays = [];
    const importedKg = {};
    let currentDay = null;
    let weeksCount = weekMap.length > 0 ? Math.max(...weekMap.map(w => w.weekIdx)) + 1 : 5;

    const unknownGroups = new Set();
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;

      const firstCol = String(row[0] || "").trim();

      if (firstCol.toUpperCase().startsWith("GIORNO")) {
        currentDay = { name: firstCol, rows: [] };
        importedDays.push(currentDay);
        continue;
      }

      if (currentDay && row.length >= 2 && row[1]) {
        const group = firstCol || "Petto";
        const ex = String(row[1] || "").trim();
        const scheme = Array(weeksCount).fill("");
        const rowId = newId();

        let restVal = "";
        if (restColIdx !== -1 && row[restColIdx] !== undefined && row[restColIdx] !== "") {
          restVal = String(row[restColIdx]).trim();
        }

        weekMap.forEach(({ weekIdx, colS, colKg }) => {
          const schVal = String(row[colS] ?? "").trim();
          scheme[weekIdx] = schVal;

          if (colKg !== -1) {
            const kgVal = String(row[colKg] ?? "").trim();
            if (kgVal) {
              const ser = seriesOf(schVal);
              if (ser && kgVal.includes("/")) {
                const kgParts = kgVal.split("/").map(x => x.trim());
                kgParts.forEach((kv, si) => {
                  if (kv) importedKg[kgKey(rowId, weekIdx, si)] = kv;
                });
              } else {
                importedKg[kgKey(rowId, weekIdx, 0)] = kgVal;
              }
            }
          }
        });

        currentDay.rows.push({
          id: rowId,
          group: GROUPS.find((g) => g.toLowerCase() === group.toLowerCase()) || (unknownGroups.add(group), "Petto"),
          ex: ex,
          scheme: scheme,
          rest: restVal
        });
      }
    }

    if (importedDays.length === 0) throw new Error("Nessun giorno o esercizio trovato nel file Excel.");

    let importedLibrary = clone(SEED_LIBRARY);
    if (workbook.Sheets['Libreria Esercizi']) {
      const libSheet = XLSX.utils.sheet_to_json(workbook.Sheets['Libreria Esercizi'], { header: 1 });
      if (libSheet && libSheet.length > 1) {
        let libHdr = libSheet.findIndex((row, i) => i < 6 && (row || []).filter((c) => GROUPS.includes(String(c || "").trim())).length >= 2);
        if (libHdr < 0) libHdr = 0;
        const headers = (libSheet[libHdr] || []).map(h => String(h || "").trim());
        headers.forEach((h, colIdx) => {
          if (GROUPS.includes(h)) {
            const list = [];
            for (let r = libHdr + 1; r < libSheet.length; r++) {
              const val = String(libSheet[r][colIdx] || "").trim();
              if (val) list.push(val);
            }
            if (list.length > 0) importedLibrary[h] = list;
          }
        });
      }
    }

    const importedRm = { bw: "", lifts: {} };
    const calcSheet = workbook.Sheets['Calcolatore %1RM'] || workbook.Sheets['Calcolatore'];
    if (calcSheet) {
      const calcRows = XLSX.utils.sheet_to_json(calcSheet, { header: 1 });
      calcRows.forEach((r) => {
        if (!r || r.length < 2) return;
        const col0 = String(r[0] || "").trim();
        const col1 = String(r[1] || "").trim();
        if (col0.toLowerCase().includes("peso corporeo")) {
          importedRm.bw = col1;
        } else {
          LIFTS.forEach(([k, name]) => {
            if (col0.toLowerCase() === name.toLowerCase()) {
              importedRm.lifts[k] = col1;
            }
          });
        }
      });
    }

    const newPlanData = normalize({
      title: title,
      weeks: weeksCount,
      days: importedDays,
      library: importedLibrary,
      rm: importedRm,
      kg: importedKg,
      createdAt: Date.now()
    });

    if (scheduleOn) {                                     // programmata: la scheda attuale non viene toccata
      await saveScheduled(newPlanData, scheduleOn, unknownGroups.size
        ? " Gruppi non riconosciuti messi in Petto: " + [...unknownGroups].join(", ") : "");
      return;
    }
    await archiveCurrent("sostituita da importazione Excel");
    newPlanData.planId = newId();
    plan = newPlanData;
    await setDoc(ref, clone(newPlanData));
    hist.undo = []; hist.redo = []; hist.typing = null;
    ui.day = 0; ui.week = 0;
    render();
    toast("Scheda Excel importata con successo!" + (unknownGroups.size
      ? " Gruppi non riconosciuti messi in Petto: " + [...unknownGroups].join(", ")
      : ""));
  } catch (err) {
    console.error(err);
    toast("Errore durante l'importazione dell'Excel: " + err.message);
  }
}

/* ---------- azioni ---------- */
function move(id, dir) {
  const f = findRow(id); if (!f) return;
  const j = f.i + dir; if (j < 0 || j >= f.d.rows.length) return;
  [f.d.rows[f.i], f.d.rows[j]] = [f.d.rows[j], f.d.rows[f.i]];
}
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const isAdminUser = () => user?.email === ADMIN_EMAIL;

function registerLogin(u) {   // ad ogni accesso: riallinea UID <-> email (obbligatorio, verificato dalle regole)
  return setDoc(doc(db, "directory", u.uid), {
    email: u.email || "", emailLower: (u.email || "").toLowerCase(),
    name: u.displayName || "", lastLogin: serverTimestamp()
  }, { merge: true });
}
function showSyncError(e) {
  console.error("directory:", e);
  showMsg(`<h1>Accesso non verificato</h1><p>Non riesco a collegare il tuo account (UID ed email): ${
    e?.code === "permission-denied" ? "permesso negato dalle regole Firestore" : esc(e?.message || e)}.</p>
    <p class="note">Riprova ad accedere. Se continua, avvisa l'amministratore.</p>`);
}
async function loadDirectory() {
  if (!isAdminUser()) return;
  try {
    dirCache = (await getDocs(collection(db, "directory"))).docs.map((d) => ({ uid: d.id, ...d.data() }));
  } catch (e) { dirCache = []; console.warn("directory:", e.code || e); }
  fillDirList();
}
function fillDirList() {
  const dl = $("#adminUsers"); if (!dl) return;
  dl.innerHTML = dirCache.map((x) => `<option value="${esc(x.email || x.alias || x.uid)}">${esc([x.name, x.alias].filter(Boolean).join(" · "))}</option>`).join("");
}
async function resolveUser(input) {
  const raw = input.trim(), low = raw.toLowerCase();
  if (!raw || raw.includes("/")) return null;
  const find = async (field, val) => {
    const s = await getDocs(query(collection(db, "directory"), where(field, "==", val), limit(1)));
    return s.empty ? null : { uid: s.docs[0].id, ...s.docs[0].data() };
  };
  if (raw.includes("@")) return find("emailLower", low);
  const byAlias = await find("aliasLower", low);
  if (byAlias) return byAlias;
  const d = await getDoc(doc(db, "directory", raw));          // UID
  if (d.exists()) return { uid: d.id, ...d.data() };
  const p = await getDoc(doc(db, "users", raw, "plan", "main")); // UID di utenti precedenti alla directory
  return p.exists() ? { uid: raw } : null;
}

/* ---------- schede programmate e archivio ---------- */
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fmtDate = (s) => { const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : ""; };
const parseDate = (v) => {
  const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
};
const dateKey = (iso) => Number(String(iso).replace(/-/g, ""));   // 2026-11-02 -> 20261102 (usato dalle regole)
const slug = (s) => String(s || "scheda").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "scheda";
let extras = { sched: [], arch: [] }, extrasFor = null;   // extrasFor = uid per cui l'elenco e' caricato
let scheduleDate = null, checkedFor = null, held = null, checking = false;

// salva la scheda attuale (con kg e massimali) nell'archivio
async function archiveCurrent(reason) {
  if (!plan || !activeUid) return;
  await setDoc(doc(db, "users", activeUid, "archive", Date.now().toString(36)), clone({
    title: plan.title, weeks: plan.weeks, days: plan.days, kg: plan.kg, rm: plan.rm,
    startDate: plan.startDate || "", endDate: todayStr(), reason, supersedes: plan.restoredFrom ?? null
  }));
  extrasFor = null;                                       // l'elenco dell'archivio va ricaricato
}

// salva una scheda da attivare in futuro: NON tocca la scheda attuale
async function saveScheduled(p, date, note = "") {
  if (date <= todayStr()) throw new Error("la data deve essere successiva a oggi");
  await setDoc(doc(db, "users", activeUid, "scheduled", Date.now().toString(36)),
    clone({ title: p.title, weeks: p.weeks, days: p.days, startDate: date, startKey: dateKey(date) }));
  toast(`Scheda "${p.title}" programmata per il ${fmtDate(date)}.${note}`);
  await loadExtras();
}

// scambio atomico: archivia l'attuale, attiva la programmata, elimina la programmata usata.
// Le programmate "saltate" (superate da una piu' recente) vanno prima in archivio, fuori dalla transazione:
// cosi' la transazione resta di sole 3 scritture (le regole limitano gli accessi per richiesta).
async function activateScheduled(uid, target, skipped = [], since = target.startDate) {
  const stamp0 = Date.now().toString(36);
  for (const [i, s] of skipped.entries()) {
    await setDoc(doc(db, "users", uid, "archive", `${stamp0}s${i}`), clone({
      title: s.title ?? "", weeks: s.weeks ?? 5, days: s.days ?? [], kg: {}, rm: {}, startDate: s.startDate ?? "",
      endDate: s.startDate ?? "", reason: "programmata ma mai attivata (superata da una piu' recente)"
    }));
    await deleteDoc(doc(db, "users", uid, "scheduled", s.id));
  }
  const mainRef = doc(db, "users", uid, "plan", "main");
  const tRef = doc(db, "users", uid, "scheduled", target.id);
  const done = await runTransaction(db, async (tx) => {
    const [mSnap, tSnap] = await Promise.all([tx.get(mainRef), tx.get(tRef)]);
    if (!tSnap.exists()) return false;                    // gia' attivata da un altro dispositivo
    const cur = mSnap.exists() ? mSnap.data() : null, next = tSnap.data();
    const stamp = Date.now().toString(36);
    if (cur) tx.set(doc(db, "users", uid, "archive", stamp), clone({
      title: cur.title ?? "", weeks: cur.weeks ?? 5, days: cur.days ?? [], kg: cur.kg ?? {}, rm: cur.rm ?? {},
      startDate: cur.startDate ?? "", endDate: since, reason: "sostituita da scheda programmata",
      supersedes: cur.restoredFrom ?? null
    }));
    const fresh = normalize({ title: next.title, weeks: next.weeks, days: clone(next.days || []),
      library: clone(cur?.library ?? SEED_LIBRARY), rm: clone(cur?.rm ?? {}), kg: {} });
    tx.set(mainRef, {
      ...clone({ title: fresh.title, weeks: fresh.weeks, days: fresh.days, library: fresh.library, rm: fresh.rm, kg: {} }),
      startDate: since, planId: stamp, createdAt: cur?.createdAt ?? Date.now()
    });
    tx.delete(tRef);
    return true;
  });
  if (done && uid === activeUid) toast(`Da oggi e' attiva la scheda "${target.title}".`);
  return done;
}

// riattiva una scheda dall'archivio (con i suoi kg): l'attuale va in archivio, quindi si puo' tornare indietro e avanti.
// Non si cancella nulla: la voce usata resta, ma viene nascosta finche' la scheda ripristinata e' quella attiva.
async function restoreArchived(uid, entry) {
  const mainRef = doc(db, "users", uid, "plan", "main");
  const aRef = doc(db, "users", uid, "archive", entry.id);
  const stamp = Date.now().toString(36);
  const done = await runTransaction(db, async (tx) => {
    const [mSnap, aSnap] = await Promise.all([tx.get(mainRef), tx.get(aRef)]);
    if (!aSnap.exists()) return false;
    const cur = mSnap.exists() ? mSnap.data() : null, old = aSnap.data();
    if (cur) tx.set(doc(db, "users", uid, "archive", stamp), clone({
      title: cur.title ?? "", weeks: cur.weeks ?? 5, days: cur.days ?? [], kg: cur.kg ?? {}, rm: cur.rm ?? {},
      startDate: cur.startDate ?? "", endDate: todayStr(), reason: `sostituita dal ripristino di "${old.title ?? ""}"`,
      supersedes: cur.restoredFrom ?? null
    }));
    const fresh = normalize({ title: old.title, weeks: old.weeks, days: clone(old.days || []),
      library: clone(cur?.library ?? SEED_LIBRARY), rm: clone(cur?.rm ?? {}), kg: clone(old.kg || {}) });   // massimali: restano quelli attuali
    tx.set(mainRef, {
      ...clone({ title: fresh.title, weeks: fresh.weeks, days: fresh.days, library: fresh.library, rm: fresh.rm, kg: fresh.kg }),
      startDate: old.startDate ?? "", planId: stamp, restoredFrom: entry.id, createdAt: cur?.createdAt ?? Date.now()
    });
    return true;
  });
  if (done && uid === activeUid) toast(`Riattivata la scheda "${entry.title}".`);
  return done;
}

// all'apertura di una scheda: se una programmata ha raggiunto la data, attivala (ritorna true se ha scambiato)
async function checkScheduled(uid) {
  if (checkedFor === uid) return false;
  checkedFor = uid;
  try {
    const snap = await getDocs(query(collection(db, "users", uid, "scheduled"), where("startDate", "<=", todayStr())));
    if (snap.empty) return false;
    const due = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
    return await activateScheduled(uid, due.at(-1), due.slice(0, -1));
  } catch (e) { console.warn("schede programmate:", e.code || e); return false; }
}

async function loadExtras() {
  const uid = activeUid; if (!uid) return;
  extrasFor = uid;
  try {
    const [s, a] = await Promise.all([getDocs(collection(db, "users", uid, "scheduled")),
                                      getDocs(collection(db, "users", uid, "archive"))]);
    if (uid !== activeUid) return;
    extras.sched = s.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((x, y) => String(x.startDate).localeCompare(String(y.startDate)));
    extras.arch = a.docs.map((d) => ({ id: d.id, ...d.data() })).sort((x, y) => y.id.localeCompare(x.id));
  } catch (e) { console.warn("extras:", e.code || e); extras = { sched: [], arch: [] }; extrasFor = null; }
  fillExtras();
}

function fillExtras() {
  const box = $("#extras"); if (!box) return;
  const admin = isAdminUser();
  // voci nascoste: quella da cui deriva la scheda attiva e quelle superate da un archivio piu' recente
  const shown = extras.arch.filter((a) => a.id !== plan?.restoredFrom && !extras.arch.some((x) => x.supersedes === a.id));
  const sched = extras.sched.map((s) => `<div class="card"><div class="top"><span class="badge">Dal ${esc(fmtDate(s.startDate))}</span>
    <span>${esc(s.weeks)} sett.</span></div><div class="ex">${esc(s.title)}</div>
    <div class="erow"><button data-a="pv-open" data-k="sched" data-id="${esc(s.id)}">Anteprima</button>
    ${admin ? `<button data-a="sched-date" data-id="${esc(s.id)}">Cambia data</button>
    <button data-a="sched-now" data-id="${esc(s.id)}">Attiva ora</button>
    <button class="danger" data-a="sched-del" data-id="${esc(s.id)}">Elimina</button>` : ""}</div></div>`).join("");
  const arch = shown.map((a) => `<div class="card"><div class="top">
    <span class="badge">${esc(fmtDate(a.startDate) || "?")} &rarr; ${esc(fmtDate(a.endDate) || "?")}</span><span>${esc(a.weeks ?? "")} sett.</span></div>
    <div class="ex">${esc(a.title)}</div><div class="hint" style="text-align:left">${esc(a.reason || "")}</div>
    <div class="erow"><button data-a="pv-open" data-k="arch" data-id="${esc(a.id)}">Apri</button>
    <button data-a="arch-restore" data-id="${esc(a.id)}">Ripristina</button>
    <button data-a="arch-xlsx" data-id="${esc(a.id)}">Scarica Excel</button>
    <button data-a="arch-json" data-id="${esc(a.id)}">Scarica JSON</button>
    ${admin ? `<button class="danger" data-a="arch-del" data-id="${esc(a.id)}">Elimina</button>` : ""}</div></div>`).join("");
  box.innerHTML = `<div class="sec">Schede programmate</div>
    ${admin ? `<div class="erow"><label>Attiva dal
        <input type="date" id="schedDate" min="${todayStr()}" style="font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line,#444);background:var(--card,#222);color:inherit;color-scheme:dark"></label>
        <button class="btn" data-a="sched-new">Carica scheda da programmare</button></div>
      <p class="note">La scheda attuale resta attiva e viene archiviata (con i kg) quando arriva la data.</p>`
      : `<p class="note">Alla data indicata la scheda attuale va in archivio con i suoi kg e questa diventa quella attiva.</p>`}
    ${sched || `<p class="note">Nessuna scheda programmata.</p>`}
    <div class="sec">Archivio schede</div>
    <p class="note">"Ripristina" riattiva una scheda vecchia con i suoi kg. Quella attuale va in archivio con i suoi kg, e puoi tornarci quando vuoi.</p>
    ${arch || `<p class="note">L'archivio e' vuoto: le schede sostituite compaiono qui con i loro kg.</p>`}`;
}

async function schedAction(a, t) {
  const find = (list) => list.find((x) => x.id === t.dataset.id);
  try {
    if (a === "sched-new") {
      const when = $("#schedDate")?.value || "";
      if (!when) return toast("Scegli prima la data di attivazione.");
      if (when <= todayStr()) return toast("La data deve essere successiva a oggi.");
      scheduleDate = when; $("#importFile").click(); return;
    }
    if (a === "sched-date") {
      const s = find(extras.sched); if (!s) return;
      const iso = parseDate(prompt("Nuova data di attivazione (GG/MM/AAAA):", fmtDate(s.startDate)) || "");
      if (!iso) return toast("Data non valida.");
      if (iso <= todayStr()) return toast("La data deve essere successiva a oggi.");
      await updateDoc(doc(db, "users", activeUid, "scheduled", s.id), { startDate: iso, startKey: dateKey(iso) });
    } else if (a === "sched-now") {
      const s = find(extras.sched); if (!s) return;
      if (!confirm(`Attivare subito "${s.title}"? La scheda attuale verra' archiviata con i suoi kg.`)) return;
      await activateScheduled(activeUid, s, [], todayStr());
    } else if (a === "sched-del") {
      const s = find(extras.sched); if (!s || !confirm(`Eliminare la scheda programmata "${s.title}"?`)) return;
      await deleteDoc(doc(db, "users", activeUid, "scheduled", s.id));
    } else if (a === "arch-restore") {
      const x = find(extras.arch); if (!x) return;
      if (!confirm(`Riattivare "${x.title}" con i suoi kg?\nLa scheda attuale "${plan?.title || ""}" verra' archiviata con i suoi kg e potrai tornarci.`)) return;
      flushSaves();
      await restoreArchived(activeUid, x);
    } else if (a === "arch-xlsx") {
      const x = find(extras.arch); if (!x) return;
      exportToExcel(x, { fileName: `Scheda_${slug(x.title)}_${x.startDate || "inizio"}_${x.endDate || "fine"}.xlsx`,
        when: `dal ${fmtDate(x.startDate) || "?"} al ${fmtDate(x.endDate) || "?"}` });
      return;
    } else if (a === "arch-json") {
      const x = find(extras.arch); if (!x) return;
      const { id, ...data } = x; download(`archivio-${id}.json`, JSON.stringify(data, null, 1)); return;
    } else if (a === "arch-del") {
      const x = find(extras.arch); if (!x || !confirm(`Eliminare definitivamente "${x.title}" dall'archivio?`)) return;
      await deleteDoc(doc(db, "users", activeUid, "archive", x.id));
    }
  } catch (e) { onErr(e); }
  await loadExtras();
}

// vista in sola lettura di una scheda archiviata o programmata
function viewPreview() {
  const { k, id } = ui.preview;
  const a = (k === "sched" ? extras.sched : extras.arch).find((x) => x.id === id);
  const back = `<div class="bar"><button class="chip" data-a="pv-close">&larr; Indietro</button>
    <span class="sm">${k === "sched" ? "Anteprima" : "Archivio"} - sola lettura</span>
    ${k === "arch" ? `<button class="chip" data-a="arch-restore" data-id="${esc(id)}">Ripristina</button>
    <button class="chip" data-a="arch-xlsx" data-id="${esc(id)}">Scarica Excel</button>` : ""}</div>`;
  if (!a) return back + `<p class="note">Elemento non trovato.</p>`;
  const kg = a.kg || {}, weeks = a.weeks || 5;
  const kgText = (r, w) => {
    const ser = seriesOf(r.scheme?.[w]);
    const vals = ser ? ser.map((_, si) => kg[kgKey(r.id, w, si)] || "") : [kg[kgKey(r.id, w, 0)] || ""];
    return vals.some(Boolean) ? vals.map((v) => v || "-").join("/") + " kg" : "";
  };
  const line = "display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-top:1px solid var(--line,#444);font-size:15px";
  return back + `<div class="card"><div class="ex">${esc(a.title)}</div>
    <div class="hint" style="text-align:left">${esc(fmtDate(a.startDate) || "?")} &rarr; ${esc(fmtDate(a.endDate) || (k === "sched" ? "" : "?"))}
    ${k === "sched" ? " (da attivare)" : ""}</div></div>` +
    (a.days || []).map((d) => `<div class="sec">${esc(d.name)}</div>` + (d.rows || []).map((r) =>
      `<div class="card"><div class="top"><span class="badge" data-g="${esc(r.group)}">${esc(r.group)}</span>
      <span>&#9201; ${esc(r.rest || "-")}</span></div><div class="ex">${esc(r.ex)}</div>
      ${Array.from({ length: weeks }, (_, w) => `<div style="${line}"><span>S${w + 1}</span>
        <span>${esc(r.scheme?.[w] || "-")}</span><b>${esc(kgText(r, w))}</b></div>`).join("")}</div>`).join("")).join("");
}

async function listenToUid(uid) {
  flushSaves();                                   // salva sul vecchio riferimento prima di cambiare
  if (unsub) { unsub(); unsub = null; }
  plan = null; rendered = false; held = null; checking = false;
  extras = { sched: [], arch: [] }; extrasFor = null;
  hist.undo = []; hist.redo = []; hist.typing = null;
  activeUid = uid; ui.preview = null;
  ref = doc(db, "users", uid, "plan", "main");
  showMsg("<p>Caricamento scheda in corso...</p>");

  const apply = (snap) => {
    if (rendered) {
      if (snap.metadata.hasPendingWrites || timers.size) return;
      const a = document.activeElement;
      if (a && view.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
    }
    const prevPid = plan?.planId;
    normChanged = false;
    plan = normalize(snap.data());
    if (!rendered) restoreUi();
    else if (prevPid !== plan.planId) {            // la scheda e' stata sostituita: stesso tab, ma riparti da Giorno 1 / S1
      ui.day = 0; ui.week = 0; ui.edit = false; ui.preview = null; extrasFor = null; saveUi();
    }
    if (normChanged && activeUid === user?.uid) { normChanged = false; saveStruct(); }
    render();
  };

  unsub = onSnapshot(ref, (snap) => {
    if (uid !== activeUid) return;
    if (!snap.exists()) {
      if (snap.metadata.fromCache) showMsg("<p>Connessione in corso...</p>"); else showOnboarding();
      return;
    }
    if (!rendered && (checkedFor !== uid || checking)) {   // prima di mostrare la scheda: e' scaduta una programmata?
      held = snap;
      if (!checking) {
        checking = true;
        Promise.race([checkScheduled(uid), new Promise((r) => setTimeout(() => r(false), 4000))]).then(() => {
          checking = false;
          if (held && uid === activeUid && !rendered) apply(held);
          held = null;
        });
      }
      return;
    }
    apply(snap);
  }, (err) => {
    console.error("Firestore Error:", err);
    showMsg(`<h1>Accesso fallito</h1><p>${err.code === "permission-denied"
      ? "Impossibile accedere alla scheda richiesta." : esc(err.message)}</p>
      <button class="btn" data-a="admin-reset">Torna alla Mia Scheda</button>`);
  });
}

async function handleAction(a, t) {
  const d = plan?.days[ui.day];
  switch (a) {
    case "login":
      try { await signInWithPopup(auth, new GoogleAuthProvider()); }
      catch (e) { toast(e.code === "auth/unauthorized-domain"
        ? "Dominio non autorizzato."
        : "Accesso non riuscito: " + (e.code || e.message)); }
      return;
    case "logout": await signOut(auth); return;
    case "admin-load": {
      const target = ($("#adminTargetUid")?.value || "").trim();
      if (!target) return toast("Inserisci email, alias o UID.");
      try {
        const found = await resolveUser(target);
        if (!found) return toast(`Nessun utente per "${target}". Deve aver fatto almeno un accesso.`);
        listenToUid(found.uid);
      } catch (e) { onErr(e); }
      return;
    }
    case "admin-reset": if (user) listenToUid(user.uid); return;
    case "set-alias": {
      if (!activeUid || activeUid === user?.uid) return toast("Apri prima la scheda di un cliente.");
      const al = (prompt("Alias da associare a questo utente (es. alessandro):") || "").trim();
      if (!al) return;
      if (al.includes("@") || al.includes("/")) return toast("L'alias non puo' contenere '@' o '/'.");
      try {
        const clash = await getDocs(query(collection(db, "directory"), where("aliasLower", "==", al.toLowerCase()), limit(1)));
        if (!clash.empty && clash.docs[0].id !== activeUid) return toast("Alias gia' usato da un altro utente.");
        await setDoc(doc(db, "directory", activeUid), { alias: al, aliasLower: al.toLowerCase() }, { merge: true });
        toast(`Alias "${al}" salvato.`); await loadDirectory(); render();
      } catch (e) { onErr(e); }
      return;
    }
    case "seed": case "empty":
      try {
        const newPlan = buildPlan(a === "seed");
        plan = newPlan;
        await setDoc(ref, clone(newPlan));
        render();
      } catch (e) { onErr(e); } return;
    case "tab": ui.tab = t.dataset.t; ui.preview = null; saveUi(); if (ui.tab === "opz") loadExtras(); break;
    case "pv-open": ui.preview = { k: t.dataset.k, id: t.dataset.id }; break;
    case "pv-close": ui.preview = null; break;
    case "sched-new": case "sched-date": case "sched-now": case "sched-del":
    case "arch-restore": case "arch-xlsx": case "arch-json": case "arch-del":
      await schedAction(a, t); return;
    case "day": ui.day = +t.dataset.i; saveUi(); break;
    case "week": ui.week = +t.dataset.i; saveUi(); break;
    case "edit": ui.edit = !ui.edit; break;
    case "undo": undo(); return;
    case "redo": redo(); return;
    case "add-day": pushUndo(); plan.days.push({ name: `Giorno ${plan.days.length + 1}`, rows: [] });
      ui.day = plan.days.length - 1; saveStruct(); break;
    case "del-day":
      if (!d || !confirm(`Eliminare "${d.name}" e i kg dei suoi esercizi?`)) return;
      pushUndo(); d.rows.forEach((r) => clearRowKg(r.id)); plan.days.splice(ui.day, 1); saveStruct(); break;
    case "add-row": pushUndo(); d.rows.push({ id: newId(), group: d.rows.at(-1)?.group || "Petto", ex: "",
      scheme: Array(plan.weeks).fill(""), rest: "" }); saveStruct(); break;
    case "del-row": if (!confirm("Eliminare questo esercizio e i suoi kg?")) return;
      pushUndo(); { const f = findRow(t.dataset.id); if (f) { clearRowKg(f.r.id); f.d.rows.splice(f.i, 1); } }
      saveStruct(); break;
    case "up": pushUndo(); move(t.dataset.id, -1); saveStruct(); break;
    case "down": pushUndo(); move(t.dataset.id, 1); saveStruct(); break;
    case "weeks+": pushUndo(); plan.weeks++; plan.days.forEach((x) => x.rows.forEach((r) => r.scheme.push(""))); saveStruct(); break;
    case "weeks-":
      if (plan.weeks <= 1 || !confirm(`Rimuovere la settimana S${plan.weeks}? I kg gia' segnati restano salvati.`)) return;
      pushUndo(); plan.weeks--; saveStruct(); break;
    case "lib-add": {
      const g = t.dataset.g, inp = view.querySelector(`[data-newex="${g}"]`), v = tidy(inp.value);
      if (!v) return;
      if (inLib(g, v)) return toast("Esercizio gia' presente in libreria.");
      pushUndo(); (plan.library[g] ??= []).push(v); saveStruct(); break;
    }
    case "lib-del": pushUndo(); plan.library[t.dataset.g].splice(+t.dataset.i, 1); saveStruct(); break;
    case "export-excel": exportToExcel(); return;
    case "export": download(`scheda-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(clone({ title: plan.title, weeks: plan.weeks, days: plan.days,
        library: plan.library, rm: plan.rm, kg: plan.kg }), null, 1)); return;
    case "import-file": $("#importFile").click(); return;
    case "clear-kg":
      if (!confirm("Azzerare TUTTI i kg segnati? (la scheda attuale con i suoi kg viene prima archiviata)")) return;
      await archiveCurrent("kg azzerati (nuovo blocco)");
      Object.keys(plan.kg).forEach((k) => save({ ["kg." + k]: deleteField() })); plan.kg = {}; break;
    default: return;
  }
  render();
}

function onInput(e) {
  const el = e.target, ds = el.dataset;
  if (ds.kg !== undefined) { const v = el.value.trim(); plan.kg[ds.kg] = v; if (v === "") delete plan.kg[ds.kg]; saveKg(ds.kg, v); return; }
  if (ds.rm !== undefined) {
    if (ds.rm === "bw") { plan.rm.bw = el.value; saveRm("bw", el.value); }
    else { plan.rm.lifts[ds.k] = el.value; saveRm("lifts." + ds.k, el.value); }
    updateCalc(); return;
  }
  const card = el.closest("[data-row]"), f = ds.f;
  if (f === "title") { typing("title"); plan.title = el.value; saveStruct(); return; }
  if (f === "dayname") { typing("dayname" + ui.day); plan.days[ui.day].name = el.value; saveStruct(); return; }
  const row = card && findRow(card.dataset.row)?.r; if (!row) return;
  if (f === "scheme") { typing("s" + row.id + ds.w); row.scheme[+ds.w] = el.value; saveStruct(); }
  if (f === "rest") { typing("r" + row.id); row.rest = el.value; saveStruct(); }
}

function onChange(e) {
  const el = e.target, f = el.dataset.f, card = el.closest("[data-row]");
  const row = card && findRow(card.dataset.row)?.r; if (!row) return;
  if (f === "group") {
    pushUndo(); row.group = el.value;
    if (row.ex && !inLib(row.group, row.ex)) setExercise(row, "");
    saveStruct(); render();
  } else if (f === "ex") {
    let v = el.value;
    if (v === "__new") {
      v = tidy(prompt(`Nome del nuovo esercizio (${row.group}):`) || "");
      if (!v) { render(); return; }
      const existing = (plan.library[row.group] || []).find((x) => nk(x) === nk(v));
      pushUndo();
      if (existing) v = existing; else (plan.library[row.group] ??= []).push(v);
    } else pushUndo();
    setExercise(row, v); saveStruct(); render();
  }
}

document.addEventListener("click", (e) => { const t = e.target.closest("[data-a]"); if (t) handleAction(t.dataset.a, t); });
view.addEventListener("input", onInput);
view.addEventListener("change", onChange);
view.addEventListener("focusout", () => { hist.typing = null; });

$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0]; e.target.value = "";
  const when = scheduleDate; scheduleDate = null;          // data scelta con "Carica scheda da programmare"
  if (!file) return;
  const name = file.name.toLowerCase(), isXls = /\.(xlsx|xlsm|xls)$/.test(name);
  try {
    if (when) {                                             // programma per il futuro: l'attuale non viene toccata
      if (!confirm(`Programmare "${file.name}" per il ${fmtDate(when)}?\nLa scheda attuale resta attiva fino ad allora.`)) return;
      if (isXls) await parseAndImportExcel(file, when);
      else if (name.endsWith(".json")) {
        const data = JSON.parse(await file.text());
        if (!Array.isArray(data.days)) throw new Error("file non valido (manca 'days')");
        await saveScheduled(normalize({ ...data }), when);
      } else throw new Error("formato non supportato (usa .xlsx, .xlsm o .json)");
      return;
    }
    if (isXls) {
      if (!confirm(`Importare la scheda, i carichi ed il Calcolatore dal file Excel "${file.name}" per l'utente attivo?\nLa scheda attuale verra' archiviata con i suoi kg.`)) return;
      await parseAndImportExcel(file);
    } else if (name.endsWith(".json")) {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.days)) throw new Error("file non valido (manca 'days')");
      if (!confirm("Sostituire la scheda attuale con quella del file JSON?\nLa scheda attuale verra' archiviata con i suoi kg.")) return;
      await archiveCurrent("sostituita da importazione JSON");
      const p = normalize({ ...data, createdAt: Date.now() }); p.planId = newId();
      plan = p; await setDoc(ref, clone(p));
      hist.undo = []; hist.redo = []; hist.typing = null; ui.day = 0; ui.week = 0;
      render(); toast("Backup JSON importato con successo!");
    } else toast("Formato file non supportato. Seleziona un file Excel (.xlsx/.xlsm) o JSON.");
  } catch (err) { toast("Importazione non riuscita: " + err.message); }
});

/* ---------- autenticazione e sync ---------- */
onAuthStateChanged(auth, async (u) => {
  user = u; plan = null; rendered = false;
  hist.undo = []; hist.redo = []; hist.typing = null;
  if (!u) {
    if (unsub) { unsub(); unsub = null; }
    timers.forEach(({ id }) => clearTimeout(id)); timers.clear();
    ref = null; activeUid = null; dirCache = []; checkedFor = null; held = null; checking = false;
    showLogin(); return;
  }
  showMsg("<p>Verifica account in corso...</p>");
  try {   // la scheda si apre solo dopo che UID ed email sono stati registrati/riverificati
    const sync = registerLogin(u);
    const esito = await Promise.race([sync.then(() => "ok"), new Promise((r) => setTimeout(() => r("lento"), 6000))]);
    if (esito === "lento") sync.catch(showSyncError);   // offline: si procede dalla cache, la verifica parte appena torna la rete
  } catch (e) { showSyncError(e); return; }
  if (user !== u) return;                                // nel frattempo c'e' stato un logout/cambio account
  loadDirectory();
  listenToUid(u.uid);
});