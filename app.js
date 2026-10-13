import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
         doc, onSnapshot, setDoc, updateDoc, deleteField }
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
const view = $("#view"), hdr = $("#hdr"), nav = $("#nav");

/* ---------- stato ---------- */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
let user = null, activeUid = null, ref = null, unsub = null, plan = null, rendered = false;
const ui = { tab: "scheda", day: 0, week: 0, edit: false };
const timers = new Map();

/* ---------- serie e carichi ---------- */
function seriesOf(scheme) {
  const p = String(scheme ?? "").split("/").map((x) => x.trim()).filter(Boolean);
  return p.length > 1 ? p : null;
}
const kgKey = (id, w, s) => (s ? `${id}_${w}_${s}` : `${id}_${w}`);

/* ---------- annulla / ripeti ---------- */
const hist = { undo: [], redo: [], typing: null };
const snapStruct = () => clone({ days: plan.days, library: plan.library, weeks: plan.weeks, title: plan.title });
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
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => { timers.delete(key); fn(); }, ms));
}
const saveKg = (key, val) => debounced("kg" + key, 500,
  () => save({ ["kg." + key]: val === "" ? deleteField() : val }));
const saveRm = (path, val) => debounced("rm" + path, 500, () => save({ ["rm." + path]: val }));
const saveStruct = () => debounced("struct", 400, () => save(clone(
  { days: plan.days, library: plan.library, weeks: plan.weeks, title: plan.title })));

/* ---------- dati ---------- */
function normalize(p) {
  p.title ??= "Scheda"; p.weeks ??= 5; p.days ??= []; p.library ??= clone(SEED_LIBRARY);
  p.rm ??= {}; p.rm.bw ??= ""; p.rm.lifts ??= {}; p.kg ??= {};
  p.days.forEach((d) => { d.rows ??= []; d.rows.forEach((r) => {
    r.id ??= newId(); r.scheme ??= []; r.rest ??= ""; r.ex ??= "";
    while (r.scheme.length < p.weeks) r.scheme.push("");
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
const inLib = (g, ex) => (plan.library[g] || []).some((x) => x.toLowerCase() === ex.toLowerCase());
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
  view.innerHTML = (user?.email === ADMIN_EMAIL ? renderAdminSection() : "") + `<div class="center">${html}</div>`; }

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
  return `<div class="admin-card">
    <h3>Pannello Amministrazione Clienti</h3>
    <div class="erow">
      <input type="text" id="adminTargetUid" placeholder="Inserisci Email / UID Utente" value="${isViewingOther ? esc(activeUid) : ""}" style="flex:1">
      <button class="btn" data-a="admin-load">Carica Utente</button>
      ${isViewingOther ? `<button class="btn ghost" data-a="admin-reset">Torna alla Mia Scheda</button>` : ""}
    </div>
    ${isViewingOther ? `<p class="note" style="color:var(--pri)">Gestione attiva della scheda utente: <b>${esc(activeUid)}</b></p>` : ""}
  </div>`;
}

function render() {
  if (!plan) return;
  rendered = true; renderHeader();
  nav.innerHTML = [["scheda", "Scheda"], ["calc", "Calcolatore"], ["opz", "Impostazioni"]]
    .map(([t, l]) => `<button data-a="tab" data-t="${t}" class="${ui.tab === t ? "on" : ""}">${l}</button>`).join("");
  view.innerHTML = (user?.email === ADMIN_EMAIL ? renderAdminSection() : "") +
    (ui.tab === "scheda" ? viewScheda() : ui.tab === "calc" ? viewCalc() : viewOpz());
  if (ui.tab === "calc") updateCalc();
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
  const list = [...(plan.library[r.group] || [])];
  if (r.ex && !inLib(r.group, r.ex)) list.unshift(r.ex);
  return `<option value="">- scegli -</option>` +
    list.map((x) => `<option ${x === r.ex ? "selected" : ""}>${esc(x)}</option>`) +
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
      <div class="tags">${(plan.library[g] || []).map((x, i) =>
        `<span class="tag">${esc(x)}<button data-a="lib-del" data-g="${g}" data-i="${i}">&times;</button></span>`).join("")}</div>
      <div class="erow"><input type="text" data-newex="${g}" placeholder="Nuovo esercizio" style="flex:1">
      <button class="btn" data-a="lib-add" data-g="${g}">Aggiungi</button></div></details>`).join("")}
    <div class="sec">Dati ed Esportazione / Importazione</div>
    <div class="erow">
      <button class="btn" data-a="export-excel">Esporta Excel (.xlsx)</button>
      <button class="btn ghost" data-a="import-excel">Importa Excel (.xlsx / .xlsm)</button>
    </div>
    <div class="erow">
      <button class="btn ghost" data-a="export">Esporta backup (JSON)</button>
      <button class="btn ghost" data-a="import">Importa backup (JSON)</button>
    </div>
    <div class="erow"><button class="btn danger" data-a="clear-kg">Azzera tutti i kg (nuovo blocco)</button></div>
    <p class="note">Puoi caricare direttamente un file Excel (.xlsx o .xlsm) per impostare la scheda dell'utente.</p>`;
}

/* ---------- esportazione / importazione excel ---------- */
function exportToExcel() {
  if (typeof XLSX === "undefined") return toast("Libreria XLSX in caricamento...");
  const wb = XLSX.utils.book_new();
  const sheetData = [];

  sheetData.push([`PROGRAMMA ATTUALE — ${plan.title || "SCHEDA"} — ${new Date().toLocaleDateString("it-IT")}`]);
  
  const header = ["Gruppo Muscolare", "Esercizio"];
  for (let w = 1; w <= plan.weeks; w++) {
    header.push(`S${w}`);
    header.push("kg");
  }
  sheetData.push(header);

  plan.days.forEach((day) => {
    sheetData.push([day.name.toUpperCase(), "", ...Array(plan.weeks * 2).fill("")]);
    day.rows.forEach((r) => {
      const row = [r.group || "", r.ex || ""];
      for (let w = 0; w < plan.weeks; w++) {
        row.push(r.scheme[w] || "");
        const ser = seriesOf(r.scheme[w]);
        if (ser) {
          const kgs = ser.map((_, si) => plan.kg[kgKey(r.id, w, si)] || "").filter(Boolean).join("/");
          row.push(kgs);
        } else {
          row.push(plan.kg[kgKey(r.id, w, 0)] || "");
        }
      }
      sheetData.push(row);
    });
  });

  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  XLSX.utils.book_append_sheet(wb, ws, "Programma Attuale");

  const libHeaders = GROUPS;
  const libRows = [libHeaders];
  const maxLen = Math.max(...GROUPS.map(g => (plan.library[g] || []).length), 1);
  for (let i = 0; i < maxLen; i++) {
    const row = GROUPS.map(g => (plan.library[g] || [])[i] || "");
    libRows.push(row);
  }
  const wsLib = XLSX.utils.aoa_to_sheet(libRows);
  XLSX.utils.book_append_sheet(wb, wsLib, "Libreria Esercizi");

  const fileName = `Scheda_Modulare_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fileName);
  toast("File Excel esportato con successo!");
}

async function parseAndImportExcel(file) {
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

    const importedDays = [];
    let currentDay = null;
    let weeksCount = 5;

    for (let i = 0; i < rows.length; i++) {
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
        const scheme = [];

        for (let c = 2; c < row.length; c += 2) {
          scheme.push(String(row[c] || "").trim());
        }

        while (scheme.length < weeksCount) scheme.push("");
        if (scheme.length > weeksCount) weeksCount = scheme.length;

        currentDay.rows.push({
          id: newId(),
          group: GROUPS.includes(group) ? group : "Petto",
          ex: ex,
          scheme: scheme,
          rest: "1'30\""
        });
      }
    }

    if (importedDays.length === 0) throw new Error("Nessun giorno o esercizio trovato nel file Excel.");

    let importedLibrary = clone(SEED_LIBRARY);
    if (workbook.Sheets['Libreria Esercizi']) {
      const libSheet = XLSX.utils.sheet_to_json(workbook.Sheets['Libreria Esercizi'], { header: 1 });
      if (libSheet && libSheet.length > 1) {
        const headers = libSheet[0].map(h => String(h || "").trim());
        headers.forEach((h, colIdx) => {
          if (GROUPS.includes(h)) {
            const list = [];
            for (let r = 1; r < libSheet.length; r++) {
              const val = String(libSheet[r][colIdx] || "").trim();
              if (val) list.push(val);
            }
            if (list.length > 0) importedLibrary[h] = list;
          }
        });
      }
    }

    const newPlanData = normalize({
      title: title,
      weeks: weeksCount,
      days: importedDays,
      library: importedLibrary,
      rm: { bw: "", lifts: {} },
      kg: {},
      createdAt: Date.now()
    });

    plan = newPlanData;
    await setDoc(ref, clone(newPlanData));
    hist.undo = []; hist.redo = []; hist.typing = null;
    ui.day = 0; ui.week = 0;
    render();
    toast("Scheda Excel importata ed applicata con successo!");
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

/* ---------- ascolto e gestione utente con supporto Alias ---------- */
function listenToUid(targetId) {
  if (unsub) { unsub(); unsub = null; }
  
  // Se viene inserito un alias semplice (es. "alessandro"), una mail o un UID
  const isEmailOrAlias = targetId.includes("@") || !targetId.match(/^[a-zA-Z0-9]{20,}$/);
  
  // Normalizza l'alias o la mail per Firestore
  const safePathId = isEmailOrAlias 
    ? targetId.trim().toLowerCase().replace(/[@.]/g, "_") 
    : targetId.trim();
    
  activeUid = safePathId;
  rendered = false;
  
  ref = doc(db, "users", activeUid, "plan", "main");
  showMsg("<p>Caricamento scheda in corso...</p>");
  
  unsub = onSnapshot(ref, (snap) => {
    if (!snap.exists()) {
      if (snap.metadata.fromCache) {
        showMsg("<p>Connessione in corso...</p>");
      } else {
        showOnboarding();
      }
      return;
    }
    
    plan = normalize(snap.data());
    render();
  }, (err) => {
    console.error("Firestore Error:", err);
    showMsg(`<h1>Accesso fallito</h1><p>${
      err.code === "permission-denied"
        ? "Impossibile accedere alla scheda richiesta."
        : esc(err.message)
    }</p><button class="btn" data-a="admin-reset">Torna alla Mia Scheda</button>`);
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
      if (!target) return toast("Inserisci un Email o UID valido.");
      if (document.activeElement) document.activeElement.blur();
      listenToUid(target);
      return;
    }
    case "admin-reset":
      if (document.activeElement) document.activeElement.blur();
      if (user) listenToUid(user.uid);
      return;
    case "seed": case "empty":
      try {
        const newPlan = buildPlan(a === "seed");
        plan = newPlan;
        await setDoc(ref, clone(newPlan));
        render();
      } catch (e) { onErr(e); } return;
    case "tab": ui.tab = t.dataset.t; break;
    case "day": ui.day = +t.dataset.i; break;
    case "week": ui.week = +t.dataset.i; break;
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
      const g = t.dataset.g, inp = view.querySelector(`[data-newex="${g}"]`), v = inp.value.trim();
      if (!v) return;
      if (inLib(g, v)) return;
      pushUndo(); (plan.library[g] ??= []).push(v); saveStruct(); break;
    }
    case "lib-del": pushUndo(); plan.library[t.dataset.g].splice(+t.dataset.i, 1); saveStruct(); break;
    case "export-excel": exportToExcel(); return;
    case "import-excel": $("#importExcelFile").click(); return;
    case "export": download(`scheda-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(clone({ title: plan.title, weeks: plan.weeks, days: plan.days,
        library: plan.library, rm: plan.rm, kg: plan.kg }), null, 1)); return;
    case "import": $("#importFile").click(); return;
    case "clear-kg":
      if (!confirm("Azzerare TUTTI i kg segnati?")) return;
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
      v = (prompt(`Nome del nuovo esercizio (${row.group}):`) || "").trim();
      if (!v) { render(); return; }
      const existing = (plan.library[row.group] || []).find((x) => x.toLowerCase() === v.toLowerCase());
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
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.days)) throw new Error("file non valido (manca 'days')");
    if (!confirm("Sostituire la scheda attuale con quella del file?")) return;
    const p = normalize({ ...data, createdAt: Date.now() });
    await setDoc(ref, clone(p));
    hist.undo = []; hist.redo = []; hist.typing = null;
    ui.day = 0; ui.week = 0;
  } catch (err) { toast("Importazione non riuscita: " + err.message); }
});

$("#importExcelFile").addEventListener("change", async (e) => {
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  if (!confirm(`Importare la scheda dal file Excel "${file.name}" per l'utente attivo?`)) return;
  await parseAndImportExcel(file);
});

/* ---------- autenticazione e sync ---------- */
onAuthStateChanged(auth, (u) => {
  user = u; plan = null; rendered = false;
  hist.undo = []; hist.redo = []; hist.typing = null;
  if (!u) { if (unsub) unsub(); showLogin(); return; }
  listenToUid(u.uid);
});
