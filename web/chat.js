// StudyBuddy – Claude-Chat (links) und Lernfortschritt-Sync
//
// Pro PDF (erkannt am PDF-Fingerprint, damit es auf allen Geräten dieselbe ist) gibt es einen
// Datensatz mit Chatverlauf und Lesefortschritt. Der Host speichert ihn lokal und im Sync-Ordner.
// Claude läuft über die Claude-Code-CLI; pro Gerät wird eine eigene Claude-Session geführt.
// Fehlt auf einem Gerät die Session (z. B. Chat auf einem anderen Gerät begonnen), wird eine neue
// gestartet und der bisherige Verlauf als Kontext mitgeschickt.

let katex = null;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const baseName = (p) => String(p || "").split(/[\\/]/).pop();
const dirOf = (p) => String(p || "").replace(/[\\/][^\\/]*$/, "");

const SUGGESTIONS = [
  ["Folie erklären", "Erkläre mir die aktuelle Folie verständlich – mit Intuition und, wo sinnvoll, einem Beispiel."],
  ["Zusammenfassung", "Fasse den Foliensatz kompakt zusammen: wichtigste Konzepte, Definitionen, Formeln und wie sie zusammenhängen."],
  ["Quiz mich", "Stell mir Verständnisfragen zum Stoff bis zur aktuellen Folie – eine Frage nach der anderen, warte jeweils auf meine Antwort."],
  ["Prüfungsfragen", "Welche typischen Prüfungsfragen könnten zu diesem Abschnitt kommen? Gib kurze Musterlösungen."],
];

const ICON = {
  send: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>',
  stop: '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
  tool: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
};

export function createChat(api) {
  const { send, store } = api;
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const panel = $("chat");
  const list = $("chatList");
  const input = $("chatInput");
  const sendBtn = $("chatSend");
  const titleEl = $("chatTitle");
  const statusEl = $("chatStatus");
  const ctxEl = $("chatCtx");
  const selEl = $("chatSel");

  const recs = new Map(); // Fingerprint -> Datensatz
  const runs = new Map(); // Request-ID -> laufende Claude-Anfrage
  const elOf = new WeakMap(); // Nachricht -> DOM-Element
  const autoOpened = new Set();
  const settings = { syncDir: "", claude: "", model: "", device: "", known: false };
  let syncOffline = 0;
  let selection = null;
  let current = null;
  let reqSeq = 0;

  /* ================= Datensätze ================= */
  const sanitizeName = (name) =>
    (String(name || "").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .replace(/\.{2,}/g, ".").replace(/_{2,}/g, "_").replace(/[. ]+$/, "").trim().slice(0, 80)) || "Dokument";

  function normalize(d) {
    d = d && typeof d === "object" ? d : {};
    d.v = 1;
    d.progress = d.progress && typeof d.progress === "object" ? d.progress : {};
    d.chat = d.chat && typeof d.chat === "object" ? d.chat : {};
    d.chat.messages = Array.isArray(d.chat.messages) ? d.chat.messages.filter((m) => m && m.role) : [];
    d.chat.sessions = d.chat.sessions && typeof d.chat.sessions === "object" ? d.chat.sessions : {};
    for (const m of d.chat.messages) if (m.pending) { m.pending = false; if (!m.text) m.error = m.error || "Abgebrochen."; }
    return d;
  }

  function ensureRec(tab) {
    if (!tab || !tab.doc) return Promise.resolve(null);
    const fp = tab.doc.fingerprints[0];
    tab.fp = fp;
    let rec = recs.get(fp);
    if (!rec) {
      rec = { fp, name: tab.name, sname: sanitizeName(tab.name), key: null, data: null, loaded: false, waiters: [], run: null, candidate: null };
      rec.promise = new Promise((res) => rec.waiters.push(res));
      recs.set(fp, rec);
      send("recfind:" + fp + "\n" + rec.sname);
    }
    return rec.promise;
  }

  function onRec(fp, key, match, json) {
    const rec = recs.get(fp);
    if (!rec || rec.loaded) return;
    let old = null;
    try { old = json ? JSON.parse(json) : null; } catch { old = null; }
    if (old && match === "exact") {
      rec.data = normalize(old);
      rec.key = key;
    } else {
      rec.data = normalize({ name: rec.name, fp, created: Date.now() });
      rec.key = rec.sname + "__" + fp;
      // gleicher Dateiname, andere Version -> Übernahme anbieten (nicht automatisch, Namen wie "Blatt1.pdf" sind nicht eindeutig)
      if (old && match === "name") {
        const c = normalize(old);
        if (c.chat.messages.length) rec.candidate = c;
      }
    }
    rec.loaded = true;
    if (settings.syncDir && Date.now() - syncOffline > 15000) setStatus();
    for (const w of rec.waiters) w(rec);
    rec.waiters = [];
  }

  let flushTimers = new Map();
  function saveRec(rec, soon) {
    if (!rec || !rec.loaded) return;
    clearTimeout(flushTimers.get(rec));
    flushTimers.set(rec, setTimeout(() => writeRec(rec), soon ? 50 : 2500));
  }
  function writeRec(rec) {
    flushTimers.delete(rec);
    rec.data.updated = Date.now();
    rec.data.name = rec.name;
    rec.data.fp = rec.fp;
    const data = JSON.stringify(rec.data, (k, v) => (k === "pending" ? undefined : v));
    send("recsave:" + rec.key + "\n" + data);
  }
  window.addEventListener("pagehide", () => { for (const rec of [...flushTimers.keys()]) writeRec(rec); });

  /* ================= Hooks aus dem Viewer ================= */
  function docLoaded(tab) {
    ensureRec(tab).then((rec) => {
      if (!rec) return;
      api.applyProgress(tab, rec.data.progress);
      tab.progressHold = Date.now() + 2000; // Startposition nicht sofort als "Fortschritt" überschreiben
      tab.recReady = true;
      if (tab === api.active()) {
        if (rec.data.chat.messages.length && !autoOpened.has(rec.fp)) { autoOpened.add(rec.fp); setOpen(true); }
        render();
      }
    });
  }

  function progress(tab) {
    if (!tab.recReady || Date.now() < (tab.progressHold || 0)) return;
    const rec = recs.get(tab.fp);
    if (!rec || !rec.loaded) return;
    Object.assign(rec.data.progress, {
      page: tab.page, pages: tab.pages, loc: tab.loc, scale: tab.mode || String(tab.scale), t: Date.now(),
    });
    saveRec(rec);
  }

  function readChanged(tab, value) {
    const rec = tab.fp && recs.get(tab.fp);
    if (!rec || !rec.loaded) return;
    rec.data.progress.read = !!value;
    rec.data.progress.readT = Date.now();
    saveRec(rec, true);
  }

  function activeChanged() { render(); }
  function pageChanged(tab) { if (tab === api.active()) renderCtx(); }

  /* ================= Panel ================= */
  const isOpen = () => body.classList.contains("chat-open");
  function setOpen(on) {
    if (isOpen() === on) return;
    body.classList.toggle("chat-open", on);
    store.set("chatOpen", on ? "1" : "0");
    api.refit();
    if (on) { render(); setTimeout(() => input.focus(), 50); }
  }
  const offset = () => (isOpen() ? panel.offsetWidth : 0);

  const setWidth = (w) => document.documentElement.style.setProperty("--chat-w", w + "px");
  setWidth(+store.get("chatw", 400) || 400);
  if (store.get("chatOpen", "1") === "1") body.classList.add("chat-open");

  let resizing = false;
  $("chatResize").addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizing = true;
    body.classList.add("resizing");
  });
  document.addEventListener("mousemove", (e) => {
    if (!resizing) return;
    setWidth(Math.round(Math.max(280, Math.min(e.clientX, innerWidth * 0.65))));
  });
  document.addEventListener("mouseup", () => {
    if (!resizing) return;
    resizing = false;
    body.classList.remove("resizing");
    store.set("chatw", String(panel.offsetWidth));
    api.refit();
  });

  $("chatClose").onclick = () => setOpen(false);
  $("chatBtn").onclick = () => setOpen(!isOpen());
  $("chatMenu").onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    chatMenu(r.left, r.bottom + 4);
  };

  function chatMenu(x, y) {
    const items = [];
    if (current && current.data.chat.messages.length) {
      items.push({ label: "Neuer Chat für diesen Foliensatz", danger: true, action: resetChat }, "-");
    }
    items.push({ header: "Synchronisation" });
    items.push({ label: settings.syncDir ? "Sync-Ordner ändern …" : "Sync-Ordner wählen …", action: () => send("pickSync") });
    if (settings.syncDir) items.push({ label: "Synchronisation ausschalten", action: () => send("clearSync") });
    items.push("-", { header: "Modell" });
    for (const [label, val] of [["Standard (Claude Code)", ""], ["Opus", "opus"], ["Sonnet", "sonnet"], ["Haiku", "haiku"]]) {
      items.push({ label: (settings.model === val ? "✓  " : "     ") + label, action: () => send("setModel:" + val) });
    }
    api.openMenu(x, y, items);
  }

  function resetChat() {
    const rec = current;
    if (!rec || rec.run) return;
    if (!confirm(`Chatverlauf zu „${rec.name}“ auf allen Geräten löschen und neu beginnen?`)) return;
    rec.data.chat = { messages: [], sessions: {} };
    saveRec(rec, true);
    render();
  }

  /* ================= Anzeige ================= */
  function render() {
    const tab = api.active();
    const rec = tab && tab.fp ? recs.get(tab.fp) : null;
    current = rec && rec.loaded ? rec : null;
    titleEl.textContent = tab ? tab.name.replace(/\.pdf$/i, "") : "StudyBuddy";
    titleEl.title = tab ? tab.path : "";
    list.replaceChildren();
    if (!tab) list.append(emptyEl("Öffne eine PDF – dann kannst du hier mit Claude dazu lernen."));
    else if (tab.offline) list.append(emptyEl("Datei nicht erreichbar."));
    else if (!current) list.append(emptyEl("Lade …"));
    else if (!current.data.chat.messages.length) list.append(welcomeEl(current));
    else for (const m of current.data.chat.messages) list.append(msgEl(m));
    renderCtx();
    renderControls();
    list.scrollTop = list.scrollHeight;
  }

  function emptyEl(text) {
    const el = document.createElement("div");
    el.className = "chatEmpty";
    el.textContent = text;
    return el;
  }

  function welcomeEl(rec) {
    const el = document.createElement("div");
    el.className = "chatWelcome";
    el.innerHTML =
      `<div class="wt">Lernen mit Claude</div>` +
      `<div class="wp">Claude sieht automatisch, welche Seite von <b>${esc(rec.name)}</b> du gerade liest. ` +
      `Markierst du Text im PDF, wird er mitgeschickt.</div><div class="sugg"></div>`;
    const sugg = el.querySelector(".sugg");
    for (const [label, prompt] of SUGGESTIONS) {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = label;
      b.onclick = () => ask(prompt);
      sugg.append(b);
    }
    if (rec.candidate) {
      const c = rec.candidate;
      const box = document.createElement("div");
      box.className = "adopt";
      box.innerHTML = `Es gibt einen Chat (${c.chat.messages.filter((m) => m.role === "user").length} Fragen) zu einer anderen Version von „${esc(rec.name)}“.`;
      const b = document.createElement("button");
      b.className = "primary";
      b.textContent = "Chat übernehmen";
      b.onclick = () => {
        rec.data.chat = c.chat;
        rec.data.chat.messages.push({ role: "note", text: "Chat von einer anderen Version dieser Datei übernommen.", t: Date.now() });
        rec.candidate = null;
        saveRec(rec, true);
        render();
      };
      box.append(b);
      el.append(box);
    }
    return el;
  }

  function msgEl(m) {
    const el = document.createElement("div");
    elOf.set(m, el);
    fillMsg(el, m);
    return el;
  }

  function fillMsg(el, m) {
    el.className = "msg " + m.role + (m.pending ? " pending" : "") + (m.error ? " err" : "");
    if (m.role === "user") {
      el.innerHTML =
        (m.page ? `<span class="pgtag pg" data-page="${m.page}">S. ${m.page}</span>` : "") +
        (m.sel ? `<div class="quote">${esc(m.sel.length > 300 ? m.sel.slice(0, 300) + " …" : m.sel)}</div>` : "") +
        `<div class="txt">${esc(m.text)}</div>`;
    } else if (m.role === "note") {
      el.textContent = m.text;
    } else {
      const tools = (m.tools || []).map((t) => `<div class="tool">${ICON.tool}<span>${esc(t)}</span></div>`).join("");
      el.innerHTML =
        (tools ? `<div class="tools">${tools}</div>` : "") +
        `<div class="md">${md(m.text || "")}</div>` +
        (m.pending ? '<div class="typing"><i></i><i></i><i></i></div>' : "") +
        (m.error ? `<div class="error">${esc(m.error)}</div>` : "");
    }
  }

  let dirty = new Set();
  let raf = 0;
  function touch(rec, m) {
    if (rec !== current) return;
    dirty.add(m);
    if (!raf) raf = requestAnimationFrame(flushDirty);
  }
  function flushDirty() {
    raf = 0;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    for (const m of dirty) { const el = elOf.get(m); if (el && el.isConnected) fillMsg(el, m); }
    dirty.clear();
    if (atBottom) list.scrollTop = list.scrollHeight;
    renderControls();
  }

  function renderCtx() {
    const tab = api.active();
    ctxEl.textContent = tab && tab.doc ? `Kontext: Seite ${tab.page} / ${tab.pages}` : "";
    renderSel();
  }

  function renderSel() {
    const tab = api.active();
    const s = selection && tab && selection.fp === tab.fp ? selection : null;
    selEl.hidden = !s;
    if (s) {
      selEl.querySelector(".t").textContent = `„${s.text.length > 120 ? s.text.slice(0, 120) + " …" : s.text}“`;
      selEl.title = "Markierung von Seite " + s.page + " wird mitgeschickt";
    }
  }

  function renderControls() {
    const running = !!(current && current.run);
    sendBtn.innerHTML = running ? ICON.stop : ICON.send;
    sendBtn.title = running ? "Antwort abbrechen" : "Senden (Enter)";
    sendBtn.classList.toggle("stop", running);
    input.disabled = !current;
    input.placeholder = current ? "Frag Claude zu diesem Foliensatz …" : "";
  }

  function setStatus() {
    let text, cls = "";
    if (settings.known && !settings.claude) { text = "Claude Code nicht gefunden"; cls = "bad"; }
    else if (!settings.syncDir) text = "Nur lokal gespeichert · Sync im Menü einrichten";
    else if (Date.now() - syncOffline < 15000) { text = "Sync-Ordner nicht erreichbar – lokal gespeichert"; cls = "warn"; }
    else text = "Synchronisiert: " + baseName(settings.syncDir.replace(/[\\/]+$/, "")) ;
    statusEl.textContent = text;
    statusEl.className = cls;
    statusEl.title = [settings.syncDir && "Sync-Ordner: " + settings.syncDir, settings.claude && "Claude Code: " + settings.claude,
      settings.model && "Modell: " + settings.model].filter(Boolean).join("\n");
  }

  list.addEventListener("click", (e) => {
    const a = e.target.closest(".pg");
    if (a) { e.preventDefault(); api.gotoPage(+a.dataset.page); }
  });

  /* ================= Markierung im PDF ================= */
  document.addEventListener("selectionchange", () => {
    const s = getSelection();
    const tab = api.active();
    if (!s || !s.rangeCount || !tab) return;
    const n = s.anchorNode;
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    if (!el || !el.closest("#docs")) return;
    if (s.isCollapsed) { if (selection) { selection = null; renderSel(); } return; }
    const text = s.toString().replace(/\s+/g, " ").trim();
    if (!text) return;
    selection = { text: text.slice(0, 4000), fp: tab.fp, page: tab.page };
    renderSel();
  });
  selEl.querySelector(".x").onclick = () => { selection = null; renderSel(); };

  /* ================= Eingabe ================= */
  const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; };
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.preventDefault(); api.focusDoc(); }
    e.stopPropagation();
  });
  sendBtn.onclick = submit;
  function submit() {
    if (current && current.run) { stop(current.run); return; }
    ask(input.value);
  }

  /* ================= Claude fragen ================= */
  async function ask(text, sel) {
    text = String(text || "").trim();
    if (!text) return;
    const tab = api.active();
    if (!tab || !tab.doc) { api.showMessage("Bitte zuerst eine PDF öffnen."); return; }
    const rec = await ensureRec(tab);
    if (!rec || rec.run) return;
    if (!settings.device) settings.device = "local";
    sel = sel || (selection && selection.fp === rec.fp ? selection : null);
    const page = tab.page;
    const pageText = await api.pageText(tab, page);

    const history = rec.data.chat.messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.text);
    const user = { role: "user", text, page, t: Date.now() };
    if (sel) { user.sel = sel.text; user.selPage = sel.page; }
    const reply = { role: "assistant", text: "", tools: [], t: Date.now(), pending: true };
    rec.data.chat.messages.push(user, reply);
    rec.candidate = null;
    if (sel === selection) selection = null;
    input.value = "";
    autosize();
    setOpen(true);

    const job = { user, reply, history, dir: dirOf(tab.path), ctx: contextBlock(tab, page, pageText, sel) };
    startRun(rec, job, false, false);
    render();
    saveRec(rec);
  }

  function contextBlock(tab, page, pageText, sel) {
    let s = "[StudyBuddy-Kontext]\n" +
      `Foliensatz: ${tab.name}\nPfad: ${tab.path}\nAktuelle Seite: ${page} von ${tab.pages}\n`;
    if (sel) s += `Markierter Text (S. ${sel.page}):\n"""\n${sel.text}\n"""\n`;
    s += pageText
      ? `Text der aktuellen Seite (automatisch extrahiert, Layout/Formeln evtl. unvollständig):\n"""\n${pageText}\n"""\n`
      : "Text der aktuellen Seite: (kein Text extrahierbar – evtl. Bild oder Scan; bei Bedarf die Seite mit Read ansehen)\n";
    return s + "[/StudyBuddy-Kontext]";
  }

  function transcript(history) {
    const out = [];
    let total = 0;
    for (let i = history.length - 1; i >= 0 && total < 30000; i--) {
      const m = history[i];
      let t = m.text.length > 3000 ? m.text.slice(0, 3000) + " […]" : m.text;
      t = (m.role === "user" ? `Nutzer${m.page ? ` (S. ${m.page})` : ""}: ` : "Claude: ") + t;
      out.unshift(t);
      total += t.length;
    }
    return "\n\n[Bisheriger Chatverlauf zu diesem Foliensatz – aus einer früheren Sitzung bzw. von einem anderen Gerät]\n" +
      out.join("\n\n") + "\n[/Bisheriger Chatverlauf]";
  }

  function startRun(rec, job, forceNew, retried) {
    const chat = rec.data.chat;
    let sid = forceNew ? null : chat.sessions[settings.device];
    const mode = sid ? "resume" : "new";
    if (!sid) { sid = crypto.randomUUID(); chat.sessions[settings.device] = sid; }
    let prompt = job.ctx;
    if (mode === "new" && job.history.length) prompt += transcript(job.history);
    prompt += "\n\n" + job.user.text;
    const id = "r" + (++reqSeq) + "-" + Date.now().toString(36);
    const run = { id, rec, job, mode, retried, stderr: "", result: null, needSep: false, stopped: false };
    runs.set(id, run);
    rec.run = run;
    send("ask:" + [id, mode, sid, job.dir, prompt].join("\n"));
  }

  function stop(run) {
    run.stopped = true;
    send("stop:" + run.id);
  }

  function toolLabel(c) {
    const i = c.input || {};
    switch (c.name) {
      case "Read": return "Liest " + baseName(i.file_path) + (i.pages ? `, S. ${i.pages}` : "");
      case "WebSearch": return "Websuche: " + (i.query || "");
      case "WebFetch": try { return "Öffnet " + new URL(i.url).host; } catch { return "Öffnet Webseite"; }
      case "Grep": return "Durchsucht nach „" + (i.pattern || "") + "“";
      case "Glob": return "Sucht Dateien: " + (i.pattern || "");
      default: return c.name;
    }
  }

  function onEvent(id, line) {
    const run = runs.get(id);
    if (!run) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    const m = run.job.reply;
    if (ev.type === "stream_event") {
      if (ev.parent_tool_use_id) return;
      const e = ev.event || {};
      if (e.type === "message_start") { if (m.text) run.needSep = true; }
      else if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta") {
        if (run.needSep) { m.text = m.text.replace(/\s*$/, "") + "\n\n"; run.needSep = false; }
        m.text += e.delta.text;
        touch(run.rec, m);
      }
    } else if (ev.type === "assistant" && !ev.parent_tool_use_id) {
      for (const c of (ev.message && ev.message.content) || []) {
        if (c.type === "tool_use") { m.tools.push(toolLabel(c)); touch(run.rec, m); }
      }
    } else if (ev.type === "result") {
      run.result = ev;
      if (ev.is_error || (ev.subtype && ev.subtype !== "success")) {
        m.error = ev.result || (Array.isArray(ev.errors) ? ev.errors.join("\n") : "") || ev.subtype || "Fehler";
      } else if (!m.text && ev.result) m.text = ev.result;
      if (typeof ev.total_cost_usd === "number") m.cost = ev.total_cost_usd;
      touch(run.rec, m);
    }
  }

  function onEnd(id, code) {
    const run = runs.get(id);
    if (!run) return;
    runs.delete(id);
    const { rec, job } = run;
    const m = job.reply;
    if (rec.run === run) rec.run = null;

    const failed = !run.stopped && !m.text.trim() && (code !== 0 || !run.result || m.error);
    if (failed && run.mode === "resume" && !run.retried) {
      // Session gibt es auf diesem Gerät nicht (mehr) -> neue Session, Verlauf als Kontext
      m.error = undefined;
      m.tools = [];
      delete rec.data.chat.sessions[settings.device];
      startRun(rec, job, true, true);
      touch(rec, m);
      return;
    }

    m.pending = false;
    if (run.stopped) m.text = (m.text ? m.text.replace(/\s*$/, "") + "\n\n" : "") + "_(abgebrochen)_";
    else if (!m.text.trim() && !m.error) m.error = run.stderr.trim() || `Claude Code wurde ohne Antwort beendet (Code ${code}).`;
    if (m.error) {
      if (/not logged in|\/login|authenticat|api key/i.test(m.error + run.stderr)) {
        m.error += "\n\nBitte einmal im Terminal „claude“ starten und anmelden.";
      }
      if (failed && run.mode === "new") delete rec.data.chat.sessions[settings.device];
    }
    touch(rec, m);
    saveRec(rec, true);
    if (rec === current) renderControls();
    if (window.__log) window.__log(`claude fertig (${run.mode}, Code ${code}): ` + (m.error ? "FEHLER " + m.error : m.text).slice(0, 400).replace(/\n/g, " ⏎ "));
  }

  /* ================= Host-Nachrichten ================= */
  function onHost(cmd, raw) {
    const p = raw.split("\n");
    switch (cmd) {
      case "settings":
        Object.assign(settings, { syncDir: p[1] || "", claude: p[2] || "", model: p[3] || "", device: p[4] || "local", known: true });
        setStatus();
        return true;
      case "rec": onRec(p[1], p[2], p[3], p.slice(4).join("\n")); return true;
      case "cc": onEvent(p[1], p.slice(2).join("\n")); return true;
      case "ccerr": { const r = runs.get(p[1]); if (r) r.stderr += p.slice(2).join("\n") + "\n"; return true; }
      case "ccend": onEnd(p[1], parseInt(p[2], 10)); return true;
      case "syncok": syncOffline = 0; setStatus(); return true;
      case "syncoffline": syncOffline = Date.now(); setStatus(); return true;
    }
    return false;
  }

  /* ================= Markdown + Formeln ================= */
  import("./katex/katex.mjs").then((mod) => { katex = mod.default; if (current) render(); }).catch(() => {});

  function tex(src, display) {
    if (!katex) return `<code>${esc(src)}</code>`;
    try { return katex.renderToString(src, { displayMode: display, throwOnError: false, output: "html" }); }
    catch { return `<code>${esc(src)}</code>`; }
  }

  function inline(t) {
    return t
      .replace(/\b(S\.|Seite|Folie)\s?(\d{1,4})\b/g, '<a class="pg" href="#" data-page="$2">$&</a>')
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/(^|[^_\w])_(?![\s_])(.+?)(?<![\s_])_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~(.+?)~~/g, "<del>$1</del>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank">$2</a>');
  }

  function md(src) {
    const slots = [];
    const put = (html) => "\u0000" + (slots.push(html) - 1) + "\u0000";
    let s = String(src)
      .replace(/```[^\n]*\n([\s\S]*?)(?:```|$)/g, (_, code) => put(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`))
      .replace(/`([^`\n]+)`/g, (_, c) => put(`<code>${esc(c)}</code>`))
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => put(tex(m, true)))
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => put(tex(m, true)))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => put(tex(m, false)))
      .replace(/(^|[^\\$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?!\d)/g, (_, pre, m) => pre + put(tex(m, false)));
    s = esc(s);

    const lines = s.split("\n");
    const out = [];
    const isBlockStart = (l) => /^(#{1,6})\s|^\s*([-*+]|\d+[.)])\s+|^\s*&gt;|^\s*([-*_])(\s*\3){2,}\s*$/.test(l);
    const tableSep = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      let m;
      if (!l.trim()) { i++; continue; }
      if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
        const lv = Math.min(m[1].length + 2, 6);
        out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
        i++;
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
        out.push("<hr>");
        i++;
      } else if (l.includes("|") && i + 1 < lines.length && tableSep.test(lines[i + 1])) {
        const row = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const head = row(l);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(row(lines[i++]));
        out.push("<div class=\"tbl\"><table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table></div>");
      } else if (/^\s*&gt;/.test(l)) {
        const q = [];
        while (i < lines.length && /^\s*&gt;/.test(lines[i])) q.push(lines[i++].replace(/^\s*&gt;\s?/, ""));
        out.push(`<blockquote>${inline(q.join("<br>"))}</blockquote>`);
      } else if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        const items = [];
        while (i < lines.length) {
          const mm = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (mm) { items.push({ ind: mm[1].length, ord: /\d/.test(mm[2]), start: parseInt(mm[2], 10), text: mm[3] }); i++; continue; }
          if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i])) { items[items.length - 1].text += "<br>" + lines[i].trim(); i++; continue; }
          break;
        }
        out.push(listHtml(items));
      } else {
        const para = [];
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) &&
               !(lines[i].includes("|") && i + 1 < lines.length && tableSep.test(lines[i + 1]))) para.push(lines[i++]);
        if (!para.length) para.push(lines[i++]);
        out.push(`<p>${inline(para.join("<br>"))}</p>`);
      }
    }
    return out.join("").replace(/\u0000(\d+)\u0000/g, (_, n) => slots[+n]);
  }

  function listHtml(items) {
    let html = "";
    const stack = [];
    for (const it of items) {
      while (stack.length > 1 && it.ind < stack[stack.length - 1].ind) html += `</li></${stack.pop().tag}>`;
      const top = stack[stack.length - 1];
      if (!top || it.ind > top.ind) {
        const tag = it.ord ? "ol" : "ul";
        stack.push({ ind: it.ind, tag });
        html += `<${tag}${it.ord && it.start > 1 ? ` start="${it.start}"` : ""}>`;
      } else html += "</li>";
      html += `<li>${inline(it.text)}`;
    }
    while (stack.length) html += `</li></${stack.pop().tag}>`;
    return html;
  }

  render();
  setStatus();

  return {
    docLoaded, activeChanged, pageChanged, progress, readChanged, onHost, offset, ask,
    toggle: () => setOpen(!isOpen()),
    hasSelection: () => !!selection,
  };
}
