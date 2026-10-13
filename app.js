import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
         doc, onSnapshot, setDoc, updateDoc, deleteField }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { SEED_DAYS, SEED_LIBRARY } from "./seed.js";

/* ---------- costanti ---------- */
const GROUPS = ["Petto", "Dorso", "Spalle", "Bicipiti", "Tricipiti", "Gambe", "Core"];
const LIFTS = [ // chiave, nome, a corpo libero (usa BW)
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
let user = null, ref = null, unsub = null, plan = null, rendered = false;
const ui = { tab: "scheda", day: 0, week: 0, edit: false };
const timers = new Map();

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
const groupsList = () => [...new Set([...GROUPS, ...Object.keys(plan.library)])];
const hasKg = (id) => Object.keys(plan.kg).some((k) => k.startsWith(id + "_"));
function clearRowKg(id) {
  Object.keys(plan.kg).filter((k) => k.startsWith(id + "_")).forEach((k) => {
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
  showMsg(`<h1>Benvenuto</h1><p>Da quale scheda vuoi partire?</p>
    <p><button class="btn" data-a="seed">Scheda base (4 giorni)</button></p>
    <p><button class="btn ghost" data-a="empty">Scheda vuota</button></p>
    <p class="note">La libreria esercizi e' la stessa in entrambi i casi e potrai modificare tutto dopo.</p>`);
}
function renderHeader() {
  hdr.innerHTML = `<b>${esc(plan?.title || "Scheda allenamento")}</b>
    <div><span>${esc((user?.displayName || user?.email || "").split(" ")[0])}</span>
    <button data-a="logout">Esci</button></div>`;
}
function render() {
  if (!plan) return;
  rendered = true; renderHeader();
  nav.innerHTML = [["scheda", "Scheda"], ["calc", "Calcolatore"], ["opz", "Impostazioni"]]
    .map(([t, l]) => `<button data-a="tab" data-t="${t}" class="${ui.tab === t ? "on" : ""}">${l}</button>`).join("");
  view.innerHTML = ui.tab === "scheda" ? viewScheda() : ui.tab === "calc" ? viewCalc() : viewOpz();
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
    <div class="bar"><span class="sm">${d ? d.rows.length : 0} esercizi</span>
    <button class="chip ${ui.edit ? "on" : ""}" data-a="edit">${ui.edit ? "Fine modifica" : "Modifica scheda"}</button></div>`;
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
  const key = `${r.id}_${w}`, cur = plan.kg[key] ?? "", prev = w > 0 ? (plan.kg[`${r.id}_${w - 1}`] ?? "") : "";
  return `<div class="card"><div class="top"><span class="badge">${esc(r.group)}</span>
    <span>&#9201; ${esc(r.rest || "-")}</span></div>
    <div class="ex">${esc(r.ex || "- scegli esercizio -")}</div>
    <div class="line"><div class="scheme">${esc(r.scheme[w] || "-")}</div>
    <label class="kg"><input type="text" inputmode="decimal" data-kg="${key}" value="${esc(cur)}"
      placeholder="${esc(prev)}" aria-label="kg"><span>kg</span></label></div>
    ${prev ? `<div class="hint">sett. prec.: ${esc(prev)} kg</div>` : ""}</div>`;
}
function exOptions(r) {
  const list = [...(plan.library[r.group] || [])];
  if (r.ex && !inLib(r.group, r.ex)) list.unshift(r.ex);
  return `<option value="">- scegli -</option>` +
    list.map((x) => `<option ${x === r.ex ? "selected" : ""}>${esc(x)}</option>`).join("") +
    `<option value="__new">+ Nuovo esercizio...</option>`;
}
function cardEdit(r, i, n) {
  return `<div class="card" data-row="${r.id}">
    <div class="erow"><select data-f="group">${groupsList().map((g) =>
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
    ${groupsList().map((g) => `<details><summary>${g} (${(plan.library[g] || []).length})</summary>
      <div class="tags">${(plan.library[g] || []).map((x, i) =>
        `<span class="tag">${esc(x)}<button data-a="lib-del" data-g="${g}" data-i="${i}">&times;</button></span>`).join("")}</div>
      <div class="erow"><input type="text" data-newex="${g}" placeholder="Nuovo esercizio" style="flex:1">
      <button class="btn" data-a="lib-add" data-g="${g}">Aggiungi</button></div></details>`).join("")}
    <div class="sec">Dati</div>
    <div class="erow"><button class="btn ghost" data-a="export">Esporta backup (JSON)</button>
    <button class="btn ghost" data-a="import">Importa scheda (Excel o backup)</button></div>
    <div class="erow"><button class="btn danger" data-a="clear-kg">Azzera tutti i kg (nuovo blocco)</button></div>
    <p class="note">Consiglio: esporta il backup prima di azzerare i kg o di cambiare scheda.</p>`;
}


/* ---------- import da Excel ---------- */
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    sc.onload = () => res(window.XLSX);
    sc.onerror = () => rej(new Error("impossibile caricare il lettore Excel (rete?)"));
    document.head.appendChild(sc);
  });
}
// rows = matrice di celle del foglio. Layout atteso: intestazioni "Gruppo Muscolare", "Esercizio", "S1".."Sn"
// (con eventuale colonna "kg" subito dopo ogni Sn), "Rest"; righe "GIORNO n" come separatori.
function rowsToPlan(rows, title) {
  const cl = (v) => String(v ?? "").trim();
  const hi = rows.findIndex((r) => r.some((c) => /^esercizio$/i.test(cl(c))) && r.some((c) => /^s\d+$/i.test(cl(c))));
  if (hi < 0) throw new Error("non trovo l'intestazione: servono le colonne 'Esercizio' e 'S1', 'S2'...");
  const H = rows[hi].map(cl);
  const cEx = H.findIndex((h) => /^esercizio$/i.test(h));
  const cGr = H.findIndex((h) => /^gruppo/i.test(h));
  const cRest = H.findIndex((h) => /^(rest|recupero)/i.test(h));
  if (cGr < 0) throw new Error("manca la colonna 'Gruppo Muscolare'");
  const wk = [];
  H.forEach((h, i) => { if (/^s\d+$/i.test(h)) wk.push({ c: i, kg: /^kg$/i.test(H[i + 1] || "") ? i + 1 : -1 }); });
  const lib = clone(plan.library), days = [], kg = {};
  let cur = null, nRows = 0, newEx = 0; const newGroups = new Set();
  const canon = (g) => groupsList().concat(Object.keys(lib)).find((x) => x.toLowerCase() === g.toLowerCase())
    || g.charAt(0).toUpperCase() + g.slice(1);
  for (const r of rows.slice(hi + 1)) {
    const a = cl(r[0]), g = cl(r[cGr]), ex = cl(r[cEx]);
    if (/^giorno/i.test(a) || /^giorno/i.test(g)) {
      cur = { name: (a || g).toLowerCase().replace(/^./, (c) => c.toUpperCase()), rows: [] }; days.push(cur); continue;
    }
    if (!g || !ex) continue;
    if (!cur) { cur = { name: "Giorno 1", rows: [] }; days.push(cur); }
    const group = canon(g), id = newId();
    if (!lib[group]) { lib[group] = []; newGroups.add(group); }
    if (!lib[group].some((x) => x.toLowerCase() === ex.toLowerCase())) { lib[group].push(ex); newEx++; }
    wk.forEach((w, i) => { if (w.kg >= 0) { const v = cl(r[w.kg]).replace(/^(\d+)\.0$/, "$1"); if (v) kg[`${id}_${i}`] = v; } });
    cur.rows.push({ id, group, ex, scheme: wk.map((w) => cl(r[w.c])), rest: cRest >= 0 ? cl(r[cRest]) : "" });
    nRows++;
  }
  if (!nRows) throw new Error("nessun esercizio trovato sotto l'intestazione");
  return { title, weeks: wk.length, days, library: lib, kg, nRows, newEx, newGroups: [...newGroups] };
}
async function applyImport(p) {
  plan = normalize({ ...clone(plan), ...clone(p) }); ui.day = 0; ui.week = 0; ui.edit = false; render();
  const { nRows, newEx, newGroups, ...data } = p;
  await setDoc(ref, clone({ ...plan, ...data }));
}
async function importFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  const baseTitle = file.name.replace(/\.[^.]+$/, "").replace(/_/g, " ");
  if (ext === "json") {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.days)) throw new Error("file non valido (manca 'days')");
    if (!confirm("Sostituire la scheda attuale con quella del file?")) return;
    plan = normalize({ ...data, createdAt: Date.now() }); ui.day = 0; ui.week = 0; render();
    await setDoc(ref, clone(plan)); return;
  }
  if (!["xlsx", "xlsm", "xls"].includes(ext)) throw new Error("formato non supportato (usa .xlsx, .xlsm o .json)");
  const X = await loadXlsx();
  const wb = X.read(await file.arrayBuffer(), { type: "array" });
  const sheet = wb.SheetNames.find((n) => /programma/i.test(n)) || wb.SheetNames[0];
  const rows = X.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: "", raw: false });
  const p = rowsToPlan(rows, baseTitle);
  const nKg = Object.keys(p.kg).length;
  if (!confirm(`Importare "${p.title}" dal foglio "${sheet}"?\n${p.days.length} giorni, ${p.nRows} esercizi, ${p.weeks} settimane` +
      `${nKg ? `, ${nKg} kg` : ""}.\nSostituisce la scheda e i kg attuali (esporta prima un backup se ti servono).`)) return;
  await applyImport(p);
  toast(`Importati ${p.nRows} esercizi` + (p.newEx ? `, ${p.newEx} nuovi aggiunti alla libreria` : "") +
        (p.newGroups.length ? `, nuovi gruppi: ${p.newGroups.join(", ")}` : ""));
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
async function handleAction(a, t) {
  const d = plan?.days[ui.day];
  switch (a) {
    case "login":
      try { await signInWithPopup(auth, new GoogleAuthProvider()); }
      catch (e) { toast(e.code === "auth/unauthorized-domain"
        ? "Dominio non autorizzato: aggiungilo in Firebase > Authentication > Impostazioni > Domini autorizzati."
        : "Accesso non riuscito: " + (e.code || e.message)); }
      return;
    case "logout": await signOut(auth); return;
    case "seed": case "empty":
      try { await setDoc(ref, buildPlan(a === "seed")); } catch (e) { onErr(e); } return;
    case "tab": ui.tab = t.dataset.t; break;
    case "day": ui.day = +t.dataset.i; break;
    case "week": ui.week = +t.dataset.i; break;
    case "edit": ui.edit = !ui.edit; break;
    case "add-day": plan.days.push({ name: `Giorno ${plan.days.length + 1}`, rows: [] });
      ui.day = plan.days.length - 1; saveStruct(); break;
    case "del-day":
      if (!d || !confirm(`Eliminare "${d.name}" e i kg dei suoi esercizi?`)) return;
      d.rows.forEach((r) => clearRowKg(r.id)); plan.days.splice(ui.day, 1); saveStruct(); break;
    case "add-row": d.rows.push({ id: newId(), group: d.rows.at(-1)?.group || "Petto", ex: "",
      scheme: Array(plan.weeks).fill(""), rest: "" }); saveStruct(); break;
    case "del-row": if (!confirm("Eliminare questo esercizio e i suoi kg?")) return;
      { const f = findRow(t.dataset.id); if (f) { clearRowKg(f.r.id); f.d.rows.splice(f.i, 1); } }
      saveStruct(); break;
    case "up": move(t.dataset.id, -1); saveStruct(); break;
    case "down": move(t.dataset.id, 1); saveStruct(); break;
    case "weeks+": plan.weeks++; plan.days.forEach((x) => x.rows.forEach((r) => r.scheme.push(""))); saveStruct(); break;
    case "weeks-":
      if (plan.weeks <= 1 || !confirm(`Rimuovere la settimana S${plan.weeks}? I kg gia' segnati restano salvati ma non visibili.`)) return;
      plan.weeks--; saveStruct(); break;
    case "lib-add": {
      const g = t.dataset.g, inp = view.querySelector(`[data-newex="${g}"]`), v = inp.value.trim();
      if (!v) return;
      plan.library[g] ??= []; if (!inLib(g, v)) plan.library[g].push(v); saveStruct(); break;
    }
    case "lib-del": plan.library[t.dataset.g].splice(+t.dataset.i, 1); saveStruct(); break;
    case "export": download(`scheda-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(clone({ title: plan.title, weeks: plan.weeks, days: plan.days,
        library: plan.library, rm: plan.rm, kg: plan.kg }), null, 1)); return;
    case "import": $("#importFile").click(); return;
    case "clear-kg":
      if (!confirm("Azzerare TUTTI i kg segnati? (esporta prima un backup)")) return;
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
  if (f === "title") { plan.title = el.value; saveStruct(); return; }
  if (f === "dayname") { plan.days[ui.day].name = el.value; saveStruct(); return; }
  const row = card && findRow(card.dataset.row)?.r; if (!row) return;
  if (f === "scheme") { row.scheme[+ds.w] = el.value; saveStruct(); }
  if (f === "rest") { row.rest = el.value; saveStruct(); }
}
function onChange(e) {
  const el = e.target, f = el.dataset.f, card = el.closest("[data-row]");
  const row = card && findRow(card.dataset.row)?.r; if (!row) return;
  if (f === "group") {
    row.group = el.value;
    if (row.ex && !inLib(row.group, row.ex)) setExercise(row, "");
    saveStruct(); render();
  } else if (f === "ex") {
    let v = el.value;
    if (v === "__new") {
      v = (prompt(`Nome del nuovo esercizio (${row.group}):`) || "").trim();
      if (!v) { render(); return; }
      const existing = (plan.library[row.group] || []).find((x) => x.toLowerCase() === v.toLowerCase());
      if (existing) v = existing; else (plan.library[row.group] ??= []).push(v);
    }
    setExercise(row, v); saveStruct(); render();
  }
}
document.addEventListener("click", (e) => { const t = e.target.closest("[data-a]"); if (t) handleAction(t.dataset.a, t); });
view.addEventListener("input", onInput);
view.addEventListener("change", onChange);
$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  try { await importFile(file); } catch (err) { toast("Importazione non riuscita: " + err.message); }
});

/* ---------- autenticazione e sync ---------- */
onAuthStateChanged(auth, (u) => {
  if (unsub) { unsub(); unsub = null; }
  user = u; plan = null; rendered = false;
  if (!u) { showLogin(); return; }
  ref = doc(db, "users", u.uid, "plan", "main");
  showMsg("<p>Caricamento...</p>");
  unsub = onSnapshot(ref, (snap) => {
    if (!snap.exists()) {
      if (snap.metadata.fromCache) showMsg("<p>Connessione in corso...</p>"); else showOnboarding();
      return;
    }
    if (rendered) {
      // eco delle nostre scritture o modifiche locali non ancora salvate: lo stato locale e' quello giusto
      if (snap.metadata.hasPendingWrites || timers.size) return;
      const a = document.activeElement;
      if (a && view.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return; // non interrompere chi scrive
    }
    plan = normalize(snap.data());
    render();
  }, (err) => {
    showMsg(`<h1>Accesso negato</h1><p>${err.code === "permission-denied"
      ? "Questo account Google non e' autorizzato (controlla le email nelle regole Firestore)."
      : esc(err.message)}</p><button class="btn" data-a="logout">Esci</button>`);
  });
});
