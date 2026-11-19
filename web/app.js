import * as pdfjsLib from "./pdfjs/build/pdf.min.mjs";

globalThis.pdfjsLib = pdfjsLib;
if (window.__log) window.__log("pdf.js geladen");
const { EventBus, PDFViewer, PDFLinkService, PDFFindController, FindState, LinkTarget, ScrollMode } =
  await import("./pdfjs/web/pdf_viewer.mjs");
pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdfjs/build/pdf.worker.min.mjs";
const { createChat } = await import("./chat.js");

const host = window.chrome && window.chrome.webview;
const send = (m) => (host ? host.postMessage(m) : console.log("[host]", m));

const $ = (id) => document.getElementById(id);
const body = document.body;
const docsEl = $("docs");
const toolbar = $("toolbar");
const tabbar = $("tabbar");
const tabList = $("tabList");
const pageNum = $("pageNum");
const pageCount = $("pageCount");
const zoomVal = $("zoomVal");
const fitBtn = $("fit");
const messageEl = $("message");
const menuEl = $("ctxmenu");

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } },
};
const loadJSON = (k, d) => { try { return JSON.parse(store.get(k, "")) ?? d; } catch { return d; } };
const isPreset = (v) => typeof v === "string" && isNaN(v);
const keyOf = (p) => (p || "").toLowerCase();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/* ================= Zustand ================= */
const tabs = [];    // Reihenfolge = Anzeigereihenfolge
const groups = [];  // { id, name, collapsed, color, parent } – parent: übergeordneter Ordner (Unterordner)
let active = null;
let tabSeq = 0;
let primary = false;
let sessionReady = false;
const readSet = new Set(loadJSON("read", []));
const COLORS = ["#4f9cf7", "#3ecf8e", "#f5a623", "#e85d75", "#a78bfa", "#2dd4bf", "#f472b6", "#facc15"];
const groupById = (id) => groups.find((g) => g.id === id);
const isRead = (t) => readSet.has(keyOf(t.path));

/* ================= Leseposition pro PDF ================= */
// Pfad (klein) -> { loc, scale, t }; bleibt auch nach dem Schließen des Tabs erhalten
const pendingPos = {};
let posTimer = 0;
const savedPos = (path) => loadJSON("positions", {})[keyOf(path)] || null;
function rememberPos(tab) {
  if (!tab.path || !tab.loc || !tab.ready) return;
  pendingPos[keyOf(tab.path)] = { loc: tab.loc, scale: tab.mode || String(tab.scale), t: Date.now() };
  clearTimeout(posTimer);
  posTimer = setTimeout(flushPositions, 250);
}
function flushPositions() {
  // frisch laden und zusammenführen (andere Fenster schreiben evtl. auch)
  const all = Object.assign(loadJSON("positions", {}), pendingPos);
  for (const k in pendingPos) delete pendingPos[k];
  const keys = Object.keys(all);
  if (keys.length > 500) {
    keys.sort((a, b) => all[a].t - all[b].t).slice(0, keys.length - 500).forEach((k) => delete all[k]);
  }
  store.set("positions", JSON.stringify(all));
}
window.addEventListener("pagehide", flushPositions);

/* ================= Sitzung ================= */
let saveTimer = 0;
function scheduleSave() {
  if (!primary || !sessionReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSession, 300);
}
function saveSession() {
  const data = {
    groups: groups.map(({ id, name, collapsed, color, parent }) => ({ id, name, collapsed, color, parent: parent || null })),
    tabs: tabs.map((t) => ({
      name: t.name,
      path: t.path,
      group: t.group,
      loc: t.loc || (t.want && t.want.loc) || null,
      scale: t.doc ? (t.mode || String(t.scale)) : (t.want && t.want.scale) || null,
    })),
    active: tabs.indexOf(active),
  };
  store.set("session", JSON.stringify(data));
}
function restoreSession() {
  const s = loadJSON("session", null);
  if (s) {
    for (const g of s.groups || []) groups.push({ id: g.id, name: g.name, collapsed: !!g.collapsed, color: g.color || COLORS[0], parent: g.parent || null });
    fixParents();
    for (const e of s.tabs || []) {
      if (!e.path) continue;
      const pos = savedPos(e.path);
      addTab({ name: e.name, path: e.path, group: groupById(e.group) ? e.group : null,
        want: pos ? { loc: pos.loc, scale: pos.scale } : { loc: e.loc, scale: e.scale } });
    }
    const a = tabs[s.active] || tabs[0];
    if (a) activate(a);
    // übrige Tabs im Hintergrund auf Erreichbarkeit prüfen (Offline-Anzeige)
    for (const t of tabs) if (t !== a) send("probe:" + t.path);
  }
  sessionReady = true;
  renderTabs();
}

/* ================= Tabs ================= */
function addTab({ name, path, group = null, want = null }) {
  const tab = {
    id: ++tabSeq, name, path, group, want,
    container: null, viewer: null, linkService: null, task: null, doc: null, requested: false,
    offline: false, ready: false,
    page: (want && want.loc && want.loc.pageNumber) || 1, pages: 0, scale: 1, mode: "", loc: null, stale: false,
    wheelTarget: null, wheelTimer: 0,
  };
  tabs.push(tab);
  return tab;
}

function ensureViewer(tab) {
  if (tab.viewer) return;
  const container = document.createElement("div");
  container.className = "viewerContainer";
  container.tabIndex = 0;
  const viewerEl = document.createElement("div");
  viewerEl.className = "pdfViewer";
  container.append(viewerEl);
  docsEl.append(container);

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
  const findController = new PDFFindController({ linkService, eventBus });
  const viewer = new PDFViewer({
    container,
    viewer: viewerEl,
    eventBus,
    linkService,
    findController,
    removePageBorders: true,
    textLayerMode: 1,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
  });
  linkService.setViewer(viewer);
  Object.assign(tab, { container, viewer, linkService, eventBus });
  container.classList.toggle("active", tab === active);

  eventBus.on("updatefindmatchescount", (e) => { if (tab === active) showFindCount(e.matchesCount); });
  eventBus.on("updatefindcontrolstate", (e) => { if (tab === active) showFindState(e.state, e.matchesCount); });

  eventBus.on("pagesinit", () => {
    const w = tab.want;
    tab.want = null;
    if (singleMode) viewer.scrollMode = ScrollMode.PAGE;
    viewer.currentScaleValue = (w && w.scale) || (singleMode ? "page-fit" : store.get("scale", "page-width"));
    if (w && w.loc) {
      viewer.scrollPageIntoView({
        pageNumber: Math.min(w.loc.pageNumber || 1, viewer.pagesCount),
        destArray: [null, { name: "XYZ" }, w.loc.left, w.loc.top, null],
        allowNegativeOffset: true,
      });
    }
    tab.ready = true;
    setTimeout(() => window.__log && window.__log(`geöffnet: ${tab.name} auf Seite ${tab.page}`), 800);
    if (tab === active && testCmd) runTest(tab);
    if (tab === active) {
      if (findOpen() && findInput.value) runFind("");
      else container.focus({ preventScroll: true });
    }
  });
  eventBus.on("pagechanging", (e) => {
    tab.page = e.pageNumber;
    if (tab === active && document.activeElement !== pageNum) pageNum.value = e.pageNumber;
    chat.pageChanged(tab);
  });
  eventBus.on("scalechanging", (e) => {
    tab.scale = e.scale;
    tab.mode = isPreset(e.presetValue) ? e.presetValue : "";
    if (!singleMode) store.set("scale", tab.mode || String(e.scale));
    if (tab === active) updateBar();
  });
  eventBus.on("updateviewarea", (e) => {
    const l = e.location;
    if (!l) return;
    tab.loc = { pageNumber: l.pageNumber, left: l.left, top: l.top };
    rememberPos(tab);
    scheduleSave();
    chat.progress(tab);
  });

  container.addEventListener("wheel", (e) => {
    if (!tab.doc) return;
    if (!e.ctrlKey) { if (singleMode) singleWheel(tab, e); return; }
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    tab.wheelTarget = Math.min(10, Math.max(0.1, (tab.wheelTarget ?? viewer.currentScale) * Math.exp(-delta / 450)));
    clearTimeout(tab.wheelTimer);
    tab.wheelTimer = setTimeout(() => (tab.wheelTarget = null), 400);
    viewer.updateScale({ scaleFactor: tab.wheelTarget / viewer.currentScale, origin: [e.clientX, e.clientY], drawingDelay: 250 });
  }, { passive: false });
}

async function loadInto(tab, url) {
  ensureViewer(tab);
  tab.requested = true;
  const task = pdfjsLib.getDocument({
    url,
    disableRange: true,
    cMapUrl: "./pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "./pdfjs/standard_fonts/",
    isEvalSupported: false,
    enableXfa: true,
  });
  tab.task = task;
  task.onPassword = (update, reason) => {
    const pw = prompt(
      reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
        ? "Falsches Passwort. Bitte erneut eingeben:"
        : `„${tab.name}“ ist passwortgeschützt.\nPasswort:`
    );
    if (pw === null) task.destroy();
    else update(pw);
  };

  try {
    const doc = await task.promise;
    if (!tabs.includes(tab)) return;
    tab.doc = doc;
    tab.pages = doc.numPages;
    tab.viewer.setDocument(doc);
    tab.linkService.setDocument(doc, null);
    renderTabs();
    if (tab === active) updateBar();
    chat.docLoaded(tab);
  } catch (err) {
    if (window.__log) window.__log("load failed: " + tab.path + " – " + ((err && (err.stack || err.message)) || err));
    if (!tabs.includes(tab)) return;
    const name = err && err.name;
    if (name === "MissingPDFException" || name === "UnexpectedResponseException" || /fetch|network/i.test((err && err.message) || "")) {
      // Datei (gerade) nicht erreichbar -> Tab behalten und offline markieren
      tab.task = null;
      setOffline(tab, true);
      return;
    }
    closeTab(tab);
    if (!(err && err.name === "PasswordException")) {
      showMessage(`„${tab.name}“ konnte nicht geöffnet werden.\n` + ((err && err.message) || err));
    }
  }
}

// Antwort des Hosts: Datei ist bereit unter url
function onHostLoad(url, name, path, tag) {
  let tab = tabs.find((t) => keyOf(t.path) === keyOf(path));
  if (tab) {
    if (tab.offline) setOffline(tab, false);
    if (!tab.task) loadInto(tab, url);
    if (tag !== "restore") activate(tab);
    return;
  }
  const g = groupById(tag);
  const pos = savedPos(path);
  tab = addTab({ name, path, group: g ? g.id : null, want: pos ? { loc: pos.loc, scale: pos.scale } : null });
  if (g) expandTo(g.id);
  loadInto(tab, url);
  activate(tab);
}

function activate(tab) {
  if (active && active !== tab && active.eventBus) active.eventBus.dispatch("findbarclose", { source: window });
  active = tab;
  for (const t of tabs) if (t.container) t.container.classList.toggle("active", t === tab);
  if (tab) {
    if (!tab.requested) { tab.requested = true; ensureViewer(tab); send("reg:" + tab.path); }
    if (tab.stale && tab.doc && tab.mode) tab.viewer.currentScaleValue = tab.mode;
    tab.stale = false;
    if (tab.doc) tab.viewer.update();
    if (findOpen() && findInput.value && tab.doc) runFind("");
    else if (tab.container) tab.container.focus({ preventScroll: true });
  }
  if (findOpen() && !(tab && tab.doc)) showFindCount(null);
  updateOfflineView();
  updateBar();
  renderTabs();
  send("title:" + (tab ? tab.name : ""));
  scheduleSave();
  chat.activeChanged(tab);
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (tab.loc && tab.ready) { rememberPos(tab); flushPositions(); }
  try { if (tab.viewer) { tab.viewer.setDocument(null); tab.linkService.setDocument(null); } } catch { /* egal */ }
  if (tab.task) tab.task.destroy().catch(() => {});
  if (tab.container) tab.container.remove();
  if (active === tab) {
    // bevorzugt Nachbar in derselben Gruppe
    const order = visualOrder();
    const same = order.filter((t) => t.group === tab.group);
    activate(same[0] ? same.reduce((a, b) => (Math.abs(tabs.indexOf(b) - i) < Math.abs(tabs.indexOf(a) - i) ? b : a)) : order[0] || null);
  } else {
    renderTabs();
    scheduleSave();
  }
  if (!tabs.length) body.classList.remove("bars");
}

/* ================= Offline-Tabs ================= */
const offlineEl = $("offline");
function setOffline(tab, value) {
  if (tab.offline === value) return;
  tab.offline = value;
  if (value) tab.requested = true; // nicht bei jedem Tabwechsel neu prüfen
  renderTabs();
  if (tab === active) { updateOfflineView(); updateBar(); }
}
function updateOfflineView() {
  const show = !!(active && active.offline);
  offlineEl.hidden = !show;
  if (show) $("offlinePath").textContent = active.path;
}
$("offlineRetry").onclick = () => { if (active && active.offline) { active.retrying = true; send("reg:" + active.path); } };

function visualOrder() {
  const walk = (g) => [...tabs.filter((t) => t.group === g.id), ...childGroups(g.id).flatMap(walk)];
  return [...tabs.filter((t) => !t.group), ...childGroups(null).flatMap(walk)];
}

function cycleTab(dir) {
  const order = visualOrder();
  if (order.length < 2) return;
  const i = order.indexOf(active);
  const next = order[(i + dir + order.length) % order.length];
  const g = groupById(next.group);
  if (g) expandTo(g.id);
  activate(next);
}

function toggleRead(tab, value) {
  const k = keyOf(tab.path);
  const v = value ?? !readSet.has(k);
  if (v) readSet.add(k); else readSet.delete(k);
  store.set("read", JSON.stringify([...readSet]));
  renderTabs();
  chat.readChanged(tab, v);
}

/* ================= Gruppen ================= */
// Gruppen sind verschachtelbar ("Ordner" mit Unterordnern): parent = id des übergeordneten Ordners
const childGroups = (parentId) => groups.filter((g) => (g.parent || null) === parentId);
// liegt Gruppe a in b (oder ist b)?
function isInside(a, b) {
  for (let g = a, n = 0; g && n < 100; g = groupById(g.parent), n++) if (g === b) return true;
  return false;
}
const descendantGroups = (g) => childGroups(g.id).flatMap((c) => [c, ...descendantGroups(c)]);
const tabsIn = (g) => tabs.filter((t) => t.group === g.id || descendantGroups(g).some((d) => d.id === t.group));
const groupPath = (g) => (g.parent && groupById(g.parent) ? groupPath(groupById(g.parent)) + " › " : "") + g.name;
function expandTo(id) {
  for (let g = groupById(id), n = 0; g && n < 100; g = groupById(g.parent), n++) g.collapsed = false;
}
// verwaiste oder zyklische Eltern (z. B. aus alter Sitzung) bereinigen
function fixParents() {
  for (const g of groups) {
    if (g.parent && !groupById(g.parent)) g.parent = null;
    if (g.parent && isInside(groupById(g.parent), g)) g.parent = null;
  }
}

function newGroup(withTab, parent = null) {
  const g = {
    id: "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: parent ? "Neuer Unterordner" : "Neue Gruppe",
    collapsed: false,
    color: parent ? parent.color : COLORS[groups.length % COLORS.length],
    parent: parent ? parent.id : null,
  };
  groups.push(g);
  if (parent) expandTo(parent.id);
  if (withTab) moveTab(withTab, g.id, null);
  renderTabs();
  startRename(g);
  scheduleSave();
}

// Ordner in anderen Ordner (oder mit null auf oberste Ebene) verschieben
function nestGroup(g, parentId) {
  const p = groupById(parentId);
  if (p && isInside(p, g)) return; // nicht in sich selbst / eigenen Unterordner
  g.parent = p ? p.id : null;
  groups.splice(groups.indexOf(g), 1);
  groups.push(g);
  if (p) expandTo(p.id);
  renderTabs();
  scheduleSave();
}

// closeTabs=false: Tabs und Unterordner wandern in den übergeordneten Ordner
function deleteGroup(g, closeTabs) {
  if (closeTabs) {
    const doomed = tabsIn(g);
    for (const d of descendantGroups(g)) groups.splice(groups.indexOf(d), 1);
    for (const t of doomed) closeTab(t);
  } else {
    for (const t of tabs.filter((t) => t.group === g.id)) t.group = g.parent || null;
    for (const c of childGroups(g.id)) c.parent = g.parent || null;
  }
  groups.splice(groups.indexOf(g), 1);
  renderTabs();
  scheduleSave();
}

// Tab in Gruppe (oder null) verschieben, optional vor/nach einem Ziel-Tab einsortieren
function moveTab(tab, groupId, target, after) {
  tabs.splice(tabs.indexOf(tab), 1);
  tab.group = groupId;
  let idx = tabs.length;
  if (target && target !== tab) idx = tabs.indexOf(target) + (after ? 1 : 0);
  tabs.splice(idx, 0, tab);
  renderTabs();
  scheduleSave();
}

let renaming = null;
function startRename(g) {
  renaming = g;
  renderTabs();
  const inp = tabList.querySelector(".rename");
  if (!inp) return;
  inp.focus();
  inp.select();
  const done = (ok) => {
    if (renaming !== g) return;
    renaming = null;
    if (ok && inp.value.trim()) g.name = inp.value.trim();
    renderTabs();
    scheduleSave();
  };
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") done(true);
    else if (e.key === "Escape") done(false);
  });
  inp.addEventListener("blur", () => done(true));
}

/* ================= Tab-Liste zeichnen ================= */
const ICONS = {
  doc: '<svg class="ico" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M9.5 1.5H4.5a1.5 1.5 0 0 0-1.5 1.5v10a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5z"/><path d="M9.5 1.5V5H13"/></svg>',
  off: '<svg class="ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18.5h10.5a4 4 0 0 0 .9-7.9 6 6 0 0 0-10.8-2.2"/><path d="M5.2 9.6A4.5 4.5 0 0 0 7 18.5"/><path d="M3 3l18 18"/></svg>',
  x: '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  chk: '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.2 8.2l1.9 1.9 3.7-3.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chev: '<svg class="chev" width="12" height="12" viewBox="0 0 12 12"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus: '<svg width="12" height="12" viewBox="0 0 14 14"><path d="M2 7h10M7 2v10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  more: '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="11" cy="7" r="1.2"/></svg>',
};

function renderTabs() {
  const items = tabs.filter((t) => !t.group).map(tabEl);
  for (const g of childGroups(null)) items.push(groupEl(g));
  tabList.replaceChildren(...items);
  body.classList.toggle("has-doc", tabs.length > 0);
  body.classList.toggle("has-tabbar", tabs.length > 0 || groups.length > 0);
  const a = tabList.querySelector(".tab.active");
  if (a) a.scrollIntoView({ block: "nearest" });
}

function tabEl(t) {
  const el = document.createElement("div");
  el.className = "tab" + (t === active ? " active" : "") + (t.doc ? "" : " loading") + (isRead(t) ? " read" : "") + (t.offline ? " offline" : "");
  el.title = (t.offline ? "Offline – nicht erreichbar: " : "") + (t.path || t.name);
  el.draggable = true;
  el.innerHTML = (t.offline ? ICONS.off : ICONS.doc) + '<span class="name"></span>' +
    `<button class="btn chk" title="${isRead(t) ? "Als ungelesen markieren" : "Als gelesen markieren"}">${ICONS.chk}</button>` +
    `<button class="btn x" title="Tab schließen (Strg+W)">${ICONS.x}</button>`;
  el.querySelector(".name").textContent = t.name;
  el.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
  el.addEventListener("click", (e) => {
    if (e.target.closest(".x")) closeTab(t);
    else if (e.target.closest(".chk")) toggleRead(t);
    else if (t !== active) activate(t);
  });
  el.addEventListener("auxclick", (e) => { if (e.button === 1) closeTab(t); });
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); tabMenu(t, e.clientX, e.clientY); });

  el.addEventListener("dragstart", (e) => {
    dragTab = t;
    e.dataTransfer.setData("application/x-studybuddy-tab", String(t.id));
    e.dataTransfer.effectAllowed = "move";
    requestAnimationFrame(() => el.classList.add("dragging"));
  });
  el.addEventListener("dragend", endDrag);
  el.addEventListener("dragover", (e) => {
    if (!dragTab || dragTab === t) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropMarks();
    const r = el.getBoundingClientRect();
    el.classList.add(e.clientY > r.top + r.height / 2 ? "drop-after" : "drop-before");
  });
  el.addEventListener("drop", (e) => {
    if (!dragTab || dragTab === t) return;
    e.preventDefault();
    e.stopPropagation();
    const after = el.classList.contains("drop-after");
    const d = dragTab;
    endDrag();
    moveTab(d, t.group, t, after);
  });
  return el;
}

function groupEl(g) {
  const members = tabs.filter((t) => t.group === g.id);
  const all = tabsIn(g); // inkl. Unterordner
  const read = all.filter(isRead).length;
  const wrap = document.createElement("div");
  wrap.className = "group" + (g.collapsed ? " collapsed" : "") + (all.includes(active) ? " has-active" : "") + (g.parent ? " sub" : "");
  wrap.dataset.gid = g.id;
  wrap.style.setProperty("--gc", g.color);

  const head = document.createElement("div");
  head.className = "ghead";
  head.title = (g.collapsed ? "Aufklappen" : "Zuklappen") + " · Ziehen, um in einen anderen Ordner zu verschieben";
  head.draggable = renaming !== g;
  head.addEventListener("dragstart", (e) => {
    if (renaming === g) { e.preventDefault(); return; }
    e.stopPropagation();
    dragGroup = g;
    e.dataTransfer.setData("application/x-studybuddy-group", g.id);
    e.dataTransfer.effectAllowed = "move";
    requestAnimationFrame(() => wrap.classList.add("dragging"));
  });
  head.addEventListener("dragend", endDrag);
  // Ordner darf hier abgelegt werden? (nicht in sich selbst oder eigene Unterordner)
  const acceptsGroup = () => dragGroup && !isInside(g, dragGroup);
  const nameHtml = renaming === g
    ? `<input class="rename" value="${esc(g.name)}" spellcheck="false">`
    : `<span class="gname">${esc(g.name)}</span>`;
  head.innerHTML = ICONS.chev + '<span class="dot"></span>' + nameHtml +
    `<span class="gcount${all.length && read === all.length ? " done" : ""}" title="gelesen / gesamt (inkl. Unterordner)">${read}/${all.length}</span>` +
    `<button class="btn gadd" title="PDF in diese Gruppe öffnen">${ICONS.plus}</button>` +
    `<button class="btn gmore" title="Mehr">${ICONS.more}</button>`;
  head.addEventListener("click", (e) => {
    if (e.target.closest(".rename")) return;
    if (e.target.closest(".gadd")) { send("open:" + g.id); return; }
    if (e.target.closest(".gmore")) { const r = e.target.closest(".gmore").getBoundingClientRect(); groupMenu(g, r.left, r.bottom + 2); return; }
    g.collapsed = !g.collapsed;
    renderTabs();
    scheduleSave();
  });
  head.addEventListener("dblclick", (e) => { if (e.target.closest(".gname")) startRename(g); });
  head.addEventListener("contextmenu", (e) => { e.preventDefault(); groupMenu(g, e.clientX, e.clientY); });
  const list = document.createElement("div");
  list.className = "gtabs";
  list.append(...members.map(tabEl), ...childGroups(g.id).map(groupEl));
  // Tab oder Ordner auf Kopf bzw. Inhalt ablegen -> hinein
  for (const zone of [head, list]) {
    zone.addEventListener("dragover", (e) => {
      if (!dragTab && !acceptsGroup()) return;
      e.preventDefault();
      e.stopPropagation();
      clearDropMarks();
      head.classList.add("drop-into");
    });
    zone.addEventListener("drop", (e) => {
      if (!dragTab && !acceptsGroup()) return;
      e.preventDefault();
      e.stopPropagation();
      const t = dragTab, d = dragGroup;
      endDrag();
      if (t) moveTab(t, g.id, null);
      else nestGroup(d, g.id);
    });
  }
  wrap.append(head, list);
  return wrap;
}

/* Drag & Drop innerhalb der Liste */
let dragTab = null;
let dragGroup = null;
function clearDropMarks() {
  tabList.classList.remove("drop-out");
  for (const el of tabList.querySelectorAll(".drop-before, .drop-after, .drop-into")) {
    el.classList.remove("drop-before", "drop-after", "drop-into");
  }
}
function endDrag() {
  dragTab = null;
  dragGroup = null;
  clearDropMarks();
  for (const el of tabList.querySelectorAll(".dragging")) el.classList.remove("dragging");
}
// freie Fläche der Liste = aus Gruppe herausnehmen (Tab) bzw. auf oberste Ebene (Ordner)
tabList.addEventListener("dragover", (e) => {
  if (!dragTab && !dragGroup) return;
  e.preventDefault();
  clearDropMarks();
  if ((dragTab && dragTab.group) || (dragGroup && dragGroup.parent)) tabList.classList.add("drop-out");
});
tabList.addEventListener("dragleave", (e) => { if (e.target === tabList) tabList.classList.remove("drop-out"); });
tabList.addEventListener("drop", (e) => {
  if (!dragTab && !dragGroup) return;
  e.preventDefault();
  const t = dragTab, d = dragGroup;
  endDrag();
  if (t) moveTab(t, null, null);
  else nestGroup(d, null);
});

/* ================= Kontextmenü ================= */
function openMenu(x, y, items) {
  menuEl.replaceChildren();
  for (const it of items) {
    const el = document.createElement("div");
    if (it === "-") el.className = "ms";
    else if (it.header) { el.className = "mh"; el.textContent = it.header; }
    else {
      el.className = "mi" + (it.danger ? " danger" : "");
      if (it.color) { const sw = document.createElement("span"); sw.className = "sw"; sw.style.background = it.color; el.append(sw); }
      el.append(document.createTextNode(it.label));
      el.addEventListener("click", () => { closeMenu(); it.action(); });
    }
    menuEl.append(el);
  }
  menuEl.hidden = false;
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + "px";
  menuEl.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + "px";
}
function closeMenu() { menuEl.hidden = true; }
document.addEventListener("mousedown", (e) => { if (!menuEl.hidden && !menuEl.contains(e.target)) closeMenu(); }, true);
window.addEventListener("blur", closeMenu);

function tabMenu(t, x, y) {
  const items = [
    { label: isRead(t) ? "Als ungelesen markieren" : "Als gelesen markieren", action: () => toggleRead(t) },
    "-",
  ];
  const others = groups.filter((g) => g.id !== t.group);
  if (others.length) {
    items.push({ header: "In Gruppe verschieben" });
    for (const g of others) items.push({ label: groupPath(g), color: g.color, action: () => moveTab(t, g.id, null) });
  }
  items.push({ label: "Neue Gruppe mit diesem Tab", action: () => newGroup(t) });
  if (t.group) items.push({ label: "Aus Gruppe entfernen", action: () => moveTab(t, null, null) });
  items.push("-", { label: "Tab schließen", danger: true, action: () => closeTab(t) });
  openMenu(x, y, items);
}

function groupMenu(g, x, y) {
  const members = tabsIn(g);
  const parent = groupById(g.parent);
  openMenu(x, y, [
    { label: "Umbenennen", action: () => startRename(g) },
    { label: "PDF zur Gruppe hinzufügen …", action: () => send("open:" + g.id) },
    { label: "Neuer Unterordner", action: () => newGroup(null, g) },
    ...(parent ? [{ label: `Aus „${parent.name}“ herausnehmen`, action: () => nestGroup(g, parent.parent || null) }] : []),
    { label: "Farbe wechseln", color: COLORS[(COLORS.indexOf(g.color) + 1) % COLORS.length],
      action: () => { g.color = COLORS[(COLORS.indexOf(g.color) + 1) % COLORS.length]; renderTabs(); scheduleSave(); } },
    ...(members.length ? [{ label: "Alle als gelesen markieren", action: () => { for (const t of members) readSet.add(keyOf(t.path)); toggleRead(members[0], true); } }] : []),
    "-",
    { label: parent ? `Gruppe auflösen (Inhalt nach „${parent.name}“)` : "Gruppe auflösen (Tabs behalten)", action: () => deleteGroup(g, false) },
    { label: "Gruppe mit allen Tabs schließen", danger: true, action: () => deleteGroup(g, true) },
  ]);
}

$("newGroup").onclick = () => newGroup(null);
$("newTab").onclick = () => send("open");

/* ================= Tab-Leiste: Breite ziehen ================= */
let resizing = false;
const setTabWidth = (w) => document.documentElement.style.setProperty("--tab-w", w + "px");
setTabWidth(+store.get("tabw", 250) || 250);
$("tabResize").addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  resizing = true;
  body.classList.add("resizing");
});
document.addEventListener("mousemove", (e) => {
  if (!resizing) return;
  const w = Math.round(Math.max(170, Math.min(e.clientX, 700, innerWidth * 0.85)));
  setTabWidth(w);
});
document.addEventListener("mouseup", () => {
  if (!resizing) return;
  resizing = false;
  body.classList.remove("resizing");
  store.set("tabw", String(parseInt(getComputedStyle(document.documentElement).getPropertyValue("--tab-w"), 10)));
});

// Fenster- oder Chatbreite geändert -> "Seitenbreite"/"Ganze Seite" neu berechnen
function refit() {
  for (const t of tabs) {
    if (!t.doc) continue;
    if (t !== active) { if (t.mode) t.stale = true; continue; }
    if (t.mode) t.viewer.currentScaleValue = t.mode;
    t.viewer.update();
  }
}
window.addEventListener("resize", refit);

/* ================= Claude-Chat ================= */
// Seitentext für den Kontext (pdf.js-Textebene)
async function pageText(tab, n) {
  if (!tab.doc) return "";
  try {
    const page = await tab.doc.getPage(n);
    const tc = await page.getTextContent();
    let s = "";
    for (const it of tc.items) {
      if (!("str" in it)) continue;
      s += it.str;
      if (it.hasEOL) s += "\n";
      else if (it.str && !/\s$/.test(it.str)) s += " ";
    }
    s = s.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return s.length > 6000 ? s.slice(0, 6000) + " […]" : s;
  } catch { return ""; }
}

// synchronisierten Fortschritt (anderes Gerät) übernehmen, falls neuer als der lokale
function applyProgress(tab, p) {
  if (!p) return;
  const local = savedPos(tab.path);
  if (p.loc && p.t && (!local || p.t > (local.t || 0) + 1000)) {
    const scale = isPreset(p.scale) ? p.scale : (tab.want && tab.want.scale) || (local && local.scale) || null;
    if (!tab.ready) tab.want = { loc: p.loc, scale };
    else if (tab.viewer) {
      tab.viewer.scrollPageIntoView({
        pageNumber: Math.min(p.loc.pageNumber || 1, tab.viewer.pagesCount),
        destArray: [null, { name: "XYZ" }, p.loc.left, p.loc.top, null],
        allowNegativeOffset: true,
      });
    }
  }
  if (typeof p.read === "boolean" && p.read !== isRead(tab)) {
    const k = keyOf(tab.path);
    if (p.read) readSet.add(k); else readSet.delete(k);
    store.set("read", JSON.stringify([...readSet]));
    renderTabs();
  }
}

const chat = createChat({
  send, store, refit, pageText, applyProgress,
  active: () => active,
  gotoPage: (n) => { if (active && active.doc && n >= 1) active.viewer.currentPageNumber = Math.min(n, active.pages); },
  openMenu: (x, y, items) => openMenu(x, y, items),
  showMessage: (t) => showMessage(t),
  focusDoc: () => focusDoc(),
});

// Rechtsklick auf markierten Text im PDF -> Claude fragen
docsEl.addEventListener("contextmenu", (e) => {
  const sel = String(window.getSelection() || "").trim();
  if (!sel || !active || !active.doc) return;
  e.preventDefault();
  openMenu(e.clientX, e.clientY, [
    { header: "Markierung – Claude fragen" },
    { label: "Erklären", action: () => chat.ask("Erkläre mir den markierten Text verständlich.") },
    { label: "Einfach erklären, mit Beispiel", action: () => chat.ask("Erkläre den markierten Text ganz einfach, mit einem anschaulichen Beispiel.") },
    { label: "Übersetzen & Fachbegriffe", action: () => chat.ask("Übersetze den markierten Text ins Deutsche und erkläre die Fachbegriffe.") },
    { label: "Quizfrage dazu", action: () => chat.ask("Stell mir eine Verständnisfrage zum markierten Text und warte auf meine Antwort.") },
  ]);
});

/* ================= Menüleiste ================= */
function updateBar() {
  const t = active;
  pageNum.value = t ? t.page : 1;
  pageCount.textContent = t ? t.pages : 0;
  zoomVal.value = Math.round((t ? t.scale : 1) * 100) + "%";
  const w = !!t && t.mode === "page-width";
  fitBtn.classList.toggle("active", w);
  fitBtn.title = w ? "Ganze Seite anzeigen" : "An Seitenbreite anpassen";
}

const STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10];
function zoomStep(dir) {
  if (!active || !active.doc) return;
  const cur = active.viewer.currentScale;
  const next = dir > 0
    ? STEPS.find((s) => s > cur + 0.005)
    : [...STEPS].reverse().find((s) => s < cur - 0.005);
  if (next) active.viewer.currentScale = next;
}

$("zoomIn").onclick = () => zoomStep(1);
$("zoomOut").onclick = () => zoomStep(-1);
fitBtn.onclick = () => {
  if (!active || !active.doc) return;
  active.viewer.currentScaleValue = active.mode === "page-width" ? "page-fit" : "page-width";
};

/* ================= Suche (Strg+F) ================= */
const findbar = $("findbar");
const findInput = $("findInput");
const findCount = $("findCount");
const findOpen = () => !findbar.hidden;

function runFind(type, previous = false) {
  if (!active || !active.doc) return;
  const query = findInput.value;
  if (!query) {
    active.eventBus.dispatch("findbarclose", { source: window });
    showFindCount(null);
    return;
  }
  active.eventBus.dispatch("find", {
    source: window,
    type,
    query,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious: previous,
    matchDiacritics: false,
  });
}
function showFindCount(mc) {
  findInput.classList.remove("notfound");
  if (!mc || !findInput.value) { findCount.textContent = ""; return; }
  if (mc.total === 0) { findCount.textContent = "…"; return; }
  findCount.textContent = mc.current > 0 ? `${mc.current} / ${mc.total}` : `${mc.total} Treffer`;
}
function showFindState(state, mc) {
  if (state === FindState.NOT_FOUND) {
    findInput.classList.add("notfound");
    findCount.textContent = "Keine Treffer";
  } else if (state !== FindState.PENDING) {
    showFindCount(mc);
  }
}
function openFind() {
  if (!active) return;
  const sel = String(window.getSelection() || "").trim();
  if (sel && sel.length < 100 && !sel.includes("\n")) findInput.value = sel;
  findbar.hidden = false;
  findInput.focus();
  findInput.select();
  if (findInput.value) runFind("");
}
function closeFind() {
  findbar.hidden = true;
  findCount.textContent = "";
  if (active && active.eventBus) active.eventBus.dispatch("findbarclose", { source: window });
  focusDoc();
}
findInput.addEventListener("input", () => runFind(""));
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); runFind("again", e.shiftKey); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
});
$("findNext").onclick = () => runFind("again", false);
$("findPrev").onclick = () => runFind("again", true);
$("findClose").onclick = closeFind;

// Selbsttests ohne Tastatur/Maus (nur mit STUDYBUDDY_DEBUG + STUDYBUDDY_TEST="find:…" oder "goto:<Seite>")
let testCmd = "";
function runTest(tab) {
  const cmd = testCmd;
  testCmd = "";
  if (cmd.startsWith("find:")) runTestFind(cmd.slice(5));
  else if (cmd.startsWith("ask:")) setTimeout(() => chat.ask(cmd.slice(4)), 2500);
  else if (cmd === "groups") setTimeout(() => runTestGroups(tab), 1000);
  else if (cmd.startsWith("type:")) setTimeout(() => { const i = $("chatInput"); i.focus(); i.value = cmd.slice(5); i.dispatchEvent(new Event("input")); }, 1500);
  else if (cmd.startsWith("goto:")) {
    setTimeout(() => {
      tab.viewer.currentPageNumber = +cmd.slice(5);
      window.__log && window.__log("test: springe zu Seite " + tab.page);
    }, 1200);
  }
}
function runTestGroups(tab) {
  const log = (m) => window.__log && window.__log(m);
  const dump = () => [...tabList.querySelectorAll(".group")].map((el) => {
    let d = 0; for (let p = el.parentElement; p && p !== tabList; p = p.parentElement) if (p.classList.contains("group")) d++;
    return "  ".repeat(d) + el.querySelector(".gname").textContent + " " + el.querySelector(".gcount").textContent;
  }).join(" | ");
  const mk = (name, parent) => { const g = { id: "t" + name, name, collapsed: false, color: COLORS[0], parent }; groups.push(g); return g; };
  const a = mk("Kurs", null), b = mk("Uebungen", null);
  nestGroup(b, a.id);
  moveTab(tab, b.id, null);
  log("test groups verschachtelt: " + dump() + " | order=" + visualOrder().length);
  nestGroup(a, b.id);
  log("test groups zyklus abgelehnt: " + (a.parent === null) + " | " + dump());
  saveSession();
  log("test groups session: " + JSON.stringify(loadJSON("session", {}).groups.map((g) => [g.name, g.parent])));
  deleteGroup(a, false);
  log("test groups aufgelöst: " + dump() + " | parent Uebungen=" + b.parent + " | tab in " + tab.group);
}
function runTestFind(q) {
  const log = (m) => window.__log && window.__log(m);
  setTimeout(() => { findInput.value = q; openFind(); }, 300);
  setTimeout(() => { log("find '" + q + "': " + findCount.textContent + " | Seite " + active.page); runFind("again"); }, 2500);
  setTimeout(() => { runFind("again"); }, 3000);
  setTimeout(() => { log("nach 2x weiter: " + findCount.textContent + " | Seite " + active.page); runFind("again", true); }, 3500);
  setTimeout(() => { log("nach 1x zurück: " + findCount.textContent + " | Seite " + active.page); }, 4000);
  setTimeout(() => { findInput.value = "xyzqqq"; runFind(""); }, 4300);
  setTimeout(() => { log("unsinn: " + findCount.textContent); findInput.value = q; runFind(""); }, 5800);
}

/* ================= Einzelseiten-Modus ================= */
let singleMode = store.get("single", "0") === "1";
const singleBtn = $("single");

function setSingleMode(on) {
  singleMode = on;
  store.set("single", on ? "1" : "0");
  singleBtn.classList.toggle("active", on);
  body.classList.toggle("single", on);
  singleBtn.title = on ? "Einzelseiten-Modus beenden (S)" : "Einzelseiten-Modus (S)";
  for (const t of tabs) {
    if (!t.doc) continue;
    if (on) {
      t.prevScale = t.mode || String(t.scale);
      t.viewer.scrollMode = ScrollMode.PAGE;
      t.viewer.currentScaleValue = "page-fit";
    } else {
      t.viewer.scrollMode = ScrollMode.VERTICAL;
      t.viewer.currentScaleValue = t.prevScale || store.get("scale", "page-width");
      t.viewer.currentPageNumber = t.page; // an der aktuellen Seite bleiben
    }
  }
  focusDoc();
}
singleBtn.classList.toggle("active", singleMode);
body.classList.toggle("single", singleMode);
singleBtn.onclick = () => setSingleMode(!singleMode);

const fitsVertically = (c) => c.scrollHeight <= c.clientHeight + 1;
function flipPage(tab, dir) {
  const v = tab.viewer;
  if (dir > 0) v.nextPage(); else v.previousPage();
}

// Mausrad blättert, sobald die Seite ganz sichtbar ist bzw. am Seitenende
let wheelAcc = 0, wheelLock = 0;
function singleWheel(tab, e) {
  const c = tab.container;
  const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  const atEnd = dy > 0 ? c.scrollTop + c.clientHeight >= c.scrollHeight - 1 : c.scrollTop <= 0;
  if (!fitsVertically(c) && !atEnd) { wheelAcc = 0; return; }
  e.preventDefault();
  if (Date.now() < wheelLock) return;
  wheelAcc += dy;
  if (Math.abs(wheelAcc) < 60) return;
  flipPage(tab, wheelAcc > 0 ? 1 : -1);
  wheelAcc = 0;
  wheelLock = Date.now() + 220;
}

function commitPage() {
  if (!active || !active.doc) return;
  const n = parseInt(pageNum.value, 10);
  if (n >= 1) active.viewer.currentPageNumber = Math.min(n, active.pages);
  pageNum.value = active.viewer.currentPageNumber || 1;
}
function commitZoom() {
  if (!active || !active.doc) return;
  const v = parseFloat(zoomVal.value.replace(",", "."));
  if (v > 0) active.viewer.currentScale = Math.min(Math.max(v, 10), 1000) / 100;
  zoomVal.value = Math.round(active.viewer.currentScale * 100) + "%";
}
const focusDoc = () => active && active.container && active.container.focus({ preventScroll: true });
for (const [el, commit] of [[pageNum, commitPage], [zoomVal, commitZoom]]) {
  el.addEventListener("focus", () => el.select());
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { commit(); focusDoc(); }
    else if (e.key === "Escape") { el.blur(); focusDoc(); }
  });
  el.addEventListener("blur", () => { commit(); maybeHide(); });
}

/* ========== Ein-/ausklappen (Menüleiste + Tabs) beim Hovern oben ========== */
const TRIGGER = 8;
let lastX = 9999, lastY = 9999;
const showBars = () => body.classList.add("bars");
function inBars(x, y) {
  const off = chat.offset();
  if (x < off) return false; // über dem Chat
  return y <= toolbar.offsetHeight + 24 || (body.classList.contains("has-tabbar") && x <= off + tabbar.offsetWidth + 24);
}
function maybeHide() {
  if (!tabs.length || resizing || renaming || dragTab || dragGroup || !menuEl.hidden) return;
  if (document.activeElement === pageNum || document.activeElement === zoomVal) return; // wird gerade eingetippt
  if (inBars(lastX, lastY)) return;
  body.classList.remove("bars");
}
document.addEventListener("mousemove", (e) => {
  lastX = e.clientX; lastY = e.clientY;
  if (e.clientY <= TRIGGER && e.clientX >= chat.offset()) showBars();
  else if (body.classList.contains("bars")) maybeHide();
});
document.documentElement.addEventListener("mouseleave", (e) => {
  if (e.clientY <= TRIGGER && e.clientX >= chat.offset()) { lastX = e.clientX; lastY = 0; showBars(); }
});

/* ================= Fenster ================= */
$("minBtn").onclick = () => send("min");
$("maxBtn").onclick = () => send("max");
$("closeBtn").onclick = () => send("close");
$("openBtn").onclick = () => send("open");
$("resizeTop").addEventListener("mousedown", (e) => { if (e.button === 0) send("resizeTop"); });
toolbar.addEventListener("dblclick", (e) => { if (e.target === toolbar || e.target.classList.contains("side")) send("max"); });

/* Dateien von außen ablegen (auch mehrere; auf einer Gruppe -> in die Gruppe) */
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
document.addEventListener("dragover", (e) => {
  if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
});
document.addEventListener("drop", (e) => {
  if (!hasFiles(e) || !e.dataTransfer.files.length) return;
  e.preventDefault();
  const groupNode = e.target.closest && e.target.closest(".group");
  const gid = groupNode ? groupNode.dataset.gid : "";
  if (host && host.postMessageWithAdditionalObjects) host.postMessageWithAdditionalObjects("drop:" + (gid || ""), e.dataTransfer.files);
}, true);

/* ================= Tastatur ================= */
document.addEventListener("keydown", (e) => {
  const inField = e.target instanceof HTMLInputElement;
  const k = e.key;
  if (k === "Escape" && !menuEl.hidden) { closeMenu(); return; }
  if (e.ctrlKey && !e.altKey) {
    if (k === "Tab") { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
    else if (k === "PageDown") { e.preventDefault(); cycleTab(1); }
    else if (k === "PageUp") { e.preventDefault(); cycleTab(-1); }
    else if (k === "f" || k === "F") { e.preventDefault(); openFind(); }
    else if (k === "o" || k === "O") { e.preventDefault(); send("open"); }
    else if (k === "+" || k === "=") { e.preventDefault(); zoomStep(1); }
    else if (k === "-") { e.preventDefault(); zoomStep(-1); }
    else if (k === "0") { e.preventDefault(); if (active && active.doc) active.viewer.currentScaleValue = "page-width"; }
    else if (k === "w" || k === "W" || k === "F4") { e.preventDefault(); active ? closeTab(active) : send("close"); }
    else if (k === "g" || k === "G") { e.preventDefault(); if (active) { showBars(); pageNum.focus(); } }
    else if (k === "l" || k === "L") { e.preventDefault(); chat.toggle(); }
    else if (k === "Enter") { e.preventDefault(); if (active) toggleRead(active); }
    else if (k >= "1" && k <= "9" && tabs.length) {
      e.preventDefault();
      const order = visualOrder();
      activate(k === "9" ? order[order.length - 1] : order[Math.min(+k, order.length) - 1]);
    }
    return;
  }
  if (k === "F11") { e.preventDefault(); send("fullscreen"); return; }
  if (k === "F3") { e.preventDefault(); if (findOpen() && findInput.value) runFind("again", e.shiftKey); else openFind(); return; }
  if (k === "Escape") { if (findOpen()) closeFind(); else send("esc"); return; }
  if (inField || !active || !active.doc) return;
  if (e.target.closest && e.target.closest("textarea, select, [contenteditable]")) return;
  const v = active.viewer;
  if ((k === "s" || k === "S") && !e.altKey && !e.metaKey) { e.preventDefault(); setSingleMode(!singleMode); return; }
  if (singleMode) {
    const fits = fitsVertically(active.container);
    if (k === "ArrowRight" || k === "PageDown" || k === " " || (k === "ArrowDown" && fits)) {
      e.preventDefault(); flipPage(active, e.shiftKey && k === " " ? -1 : 1); return;
    }
    if (k === "ArrowLeft" || k === "PageUp" || (k === "ArrowUp" && fits)) {
      e.preventDefault(); flipPage(active, -1); return;
    }
  }
  if (k === "Home") { e.preventDefault(); v.currentPageNumber = 1; }
  else if (k === "End") { e.preventDefault(); v.currentPageNumber = v.pagesCount; }
  else if ((k === "ArrowLeft" || k === "ArrowRight") && active.container.scrollWidth <= active.container.clientWidth) {
    e.preventDefault();
    k === "ArrowLeft" ? v.previousPage() : v.nextPage();
  }
});

/* ================= Meldungen ================= */
let msgTimer;
function showMessage(text) {
  messageEl.textContent = text;
  messageEl.hidden = false;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => (messageEl.hidden = true), 6000);
}

/* ================= Host-Nachrichten ================= */
if (host) {
  host.addEventListener("message", (e) => {
    const [cmd, a, b, c, d] = String(e.data).split("\n");
    if (window.__log) window.__log("host: " + cmd + " " + (a || ""));
    if (chat.onHost(cmd, String(e.data))) return;
    if (cmd === "init") {
      primary = a === "primary";
      testCmd = b || "";
      send("settings");
      if (primary) restoreSession();
      else { sessionReady = true; renderTabs(); }
    } else if (cmd === "load") onHostLoad(a, b, c, d);
    else if (cmd === "missing" || cmd === "online") {
      const t = tabs.find((t) => keyOf(t.path) === keyOf(a));
      if (t) {
        if (cmd === "missing" && t.retrying) showMessage(`„${t.name}“ ist weiterhin nicht erreichbar.`);
        t.retrying = false;
        setOffline(t, cmd === "missing");
      }
    } else if (cmd === "error") showMessage([a, b, c].filter(Boolean).join("\n"));
    else if (cmd === "state") {
      body.classList.toggle("maximized", a === "max");
      body.classList.toggle("fullscreen", a === "full");
      $("maxBtn").title = a === "normal" ? "Maximieren" : "Wiederherstellen";
    }
  });
}

renderTabs();
if (window.__log) window.__log("app ready");
send("ready");
