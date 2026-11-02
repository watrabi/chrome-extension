// Gemini Browser Agent — side panel. Runs the agent loop:
//   user task -> Gemini (with tools) -> tool calls executed in the browser -> results back -> ... -> final answer.


const $ = (id) => document.getElementById(id);
const logEl = $("log");

let settings = { provider: "gemini", providers: {}, approve: true, yolo: false, unlimited: false, maxSteps: 40 };
const cfg = () => providerConfig(settings.provider, settings.providers[settings.provider]);
let history = [];          // Gemini "contents" array
let running = false;
let abortCtl = null;
let activeTabId = null;
let lastLabels = {};       // element index -> label from the latest page snapshot (used in approval prompts)

// ---------------------------------------------------------------- UI helpers

// ---------------------------------------------------------------- chat history (saved in chrome.storage.local)

let convId = null;        // id of the current saved conversation (created on first message)
let convCreated = 0;
let currentLog = [];      // UI transcript: [{ kind, text, err? }]
let saveChain = Promise.resolve();
let saveTimer = null;

function addMsg(kind, text, persist = true) {
  const el = document.createElement("div");
  el.className = "msg " + kind;
  el.textContent = text;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
  if (persist) {
    el._entry = { kind, text };
    currentLog.push(el._entry);
    scheduleSave();
  }
  return el;
}

function markErr(el) {
  el.classList.add("err");
  if (el._entry) el._entry.err = true;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveChain = saveChain.then(doSave).catch((e) => console.error("save failed", e));
  return saveChain;
}

async function doSave() {
  if (!convId || !currentLog.length) return;
  const firstUser = currentLog.find((e) => e.kind === "user");
  const title = (firstUser?.text || "Chat").replace(/\s+/g, " ").slice(0, 70);
  // Screenshots are not worth the storage; keep everything else (incl. thought signatures) verbatim.
  const hist = JSON.parse(JSON.stringify(history), (k, v) => v);
  for (const c of hist) for (const p of c.parts || []) if (p.inlineData) { delete p.inlineData; p.text = "[screenshot not saved]"; }
  const updated = Date.now();
  await chrome.storage.local.set({
    ["conv:" + convId]: { id: convId, title, created: convCreated, updated, log: currentLog, history: hist },
    convCurrent: convId,
  });
  const { convIndex = [] } = await chrome.storage.local.get("convIndex");
  const next = [{ id: convId, title, updated }, ...convIndex.filter((c) => c.id !== convId)];
  await chrome.storage.local.set({ convIndex: next });
  if (!$("historyPanel").hidden) renderHistoryList();
}

function renderLog() {
  logEl.textContent = "";
  for (const e of currentLog) {
    const el = document.createElement("div");
    el.className = "msg " + e.kind + (e.err ? " err" : "");
    el.textContent = e.text;
    el._entry = e;
    logEl.appendChild(el);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

async function newConversation() {
  if (running) return;
  await flushSave();
  convId = null; convCreated = 0; history = []; currentLog = [];
  logEl.textContent = "";
  await chrome.storage.local.set({ convCurrent: null });
  $("historyPanel").hidden = true;
}

async function openConversation(id) {
  if (running) return;
  await flushSave();
  const conv = (await chrome.storage.local.get("conv:" + id))["conv:" + id];
  if (!conv) return;
  convId = conv.id; convCreated = conv.created; history = conv.history || []; currentLog = conv.log || [];
  renderLog();
  await chrome.storage.local.set({ convCurrent: convId });
  $("historyPanel").hidden = true;
}

async function deleteConversation(id) {
  if (running || !confirm("Delete this saved chat?")) return;
  if (id === convId) {
    // Drop the in-memory copy first so a pending/flush save can't write the chat back.
    clearTimeout(saveTimer);
    await saveChain;
    convId = null; convCreated = 0; history = []; currentLog = [];
    logEl.textContent = "";
    await chrome.storage.local.set({ convCurrent: null });
  }
  await chrome.storage.local.remove("conv:" + id);
  const { convIndex = [] } = await chrome.storage.local.get("convIndex");
  await chrome.storage.local.set({ convIndex: convIndex.filter((c) => c.id !== id) });
  renderHistoryList();
}

async function renderHistoryList() {
  const { convIndex = [] } = await chrome.storage.local.get("convIndex");
  const list = $("historyList");
  list.textContent = "";
  if (!convIndex.length) { list.textContent = "No saved chats yet."; return; }
  for (const c of convIndex) {
    const row = document.createElement("div");
    row.className = "histRow" + (c.id === convId ? " current" : "");
    const open = document.createElement("button");
    open.className = "histOpen";
    open.textContent = c.title || "Chat";
    open.title = new Date(c.updated).toLocaleString();
    open.onclick = () => openConversation(c.id);
    const date = document.createElement("span");
    date.className = "histDate";
    date.textContent = new Date(c.updated).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const del = document.createElement("button");
    del.className = "histDel";
    del.textContent = "✕";
    del.title = "Delete";
    del.onclick = () => deleteConversation(c.id);
    row.append(open, date, del);
    list.appendChild(row);
  }
}

function buildMarkdown() {
  const firstUser = currentLog.find((e) => e.kind === "user");
  const lines = [`# ${(firstUser?.text || "Chat").replace(/\s+/g, " ").slice(0, 80)}`, `_Exported ${new Date().toLocaleString()}_`, ""];
  for (const e of currentLog) {
    if (e.kind === "user") lines.push(`**You:** ${e.text}`, "");
    else if (e.kind === "assistant") lines.push(`**Agent:** ${e.text}`, "");
    else if (e.kind === "error") lines.push(`> ⚠️ ${e.text}`, "");
    else lines.push("```", e.text, "```", "");
  }
  return lines.join("\n");
}

function exportChat() {
  if (!currentLog.length) return;
  const blob = new Blob([buildMarkdown()], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `gemini-agent-chat-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function restoreLastConversation() {
  const { convCurrent } = await chrome.storage.local.get("convCurrent");
  if (convCurrent) await openConversation(convCurrent);
}

$("newChat").onclick = newConversation;
$("exportChat").onclick = exportChat;
$("historyBtn").onclick = () => {
  const panel = $("historyPanel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderHistoryList();
};

function setRunning(v) {
  running = v;
  $("send").hidden = v;
  $("stop").hidden = !v;
  $("input").disabled = v;
}

function askApproval(description) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "msg approval";
    el.textContent = "Allow this action?\n" + description;
    const row = document.createElement("div");
    row.className = "buttons";
    const done = (ok) => {
      row.remove(); el.textContent += ok ? "\n→ allowed" : "\n→ denied";
      currentLog.push({ kind: "tool", text: `Approval: ${description} → ${ok ? "allowed" : "denied"}` }); scheduleSave();
      resolve(ok);
    };
    const allow = Object.assign(document.createElement("button"), { textContent: "Allow", className: "allow" });
    const deny = Object.assign(document.createElement("button"), { textContent: "Deny" });
    allow.onclick = () => done(true);
    deny.onclick = () => done(false);
    row.append(allow, deny);
    el.appendChild(row);
    logEl.appendChild(el);
    logEl.scrollTop = logEl.scrollHeight;
    abortCtl?.signal.addEventListener("abort", () => resolve(false), { once: true });
  });
}

// ---------------------------------------------------------------- settings

function fillProviderSelect() {
  const sel = $("provider");
  sel.textContent = "";
  for (const [id, p] of Object.entries(PROVIDERS)) sel.add(new Option(p.label, id));
}

// Copy the visible provider fields into settings.providers[<current provider>].
function captureFields() {
  const id = settings.provider;
  settings.providers[id] = {
    ...(settings.providers[id] || {}),
    apiKey: $("apiKey").value.trim(),
    baseUrl: $("baseUrl").value.trim(),
    model: $("model").value.trim(),
    numCtx: parseInt($("numCtx").value) || undefined,
    vision: $("vision").checked,
  };
}

function showProviderFields() {
  const c = cfg();
  $("provider").value = c.id;
  $("apiKey").value = c.apiKey;
  $("baseUrl").value = c.baseUrl;
  $("model").value = c.model;
  $("numCtx").value = c.numCtx || "";
  $("vision").checked = !!c.vision;
  $("rowKeyLabel").textContent = c.needsKey ? "API key" : "API key (optional)";
  $("rowBase").hidden = c.type === "gemini" || c.type === "anthropic";
  $("rowCtx").hidden = c.type !== "ollama";
  $("modelList").textContent = "";
  $("providerHint").textContent = c.keyHelp || "";
}

function providerProblem() {
  const c = cfg();
  if (c.needsKey && !c.apiKey) return `Add your ${c.label} API key in Settings first.`;
  if (!c.baseUrl) return "Set the base URL in Settings first.";
  if (!c.model) return "Choose a model in Settings first (the Load button lists what the server has).";
  return null;
}

async function loadSettings() {
  const s = await chrome.storage.local.get(["provider", "providers", "apiKey", "model", "approve", "yolo", "unlimited", "maxSteps"]);
  settings = {
    provider: PROVIDERS[s.provider] ? s.provider : "gemini",
    // Older versions stored a single Gemini key/model; carry them over.
    providers: s.providers || { gemini: { apiKey: s.apiKey || "", model: s.model || "" } },
    approve: s.approve !== false,
    yolo: s.yolo === true,
    unlimited: s.unlimited === true,
    maxSteps: Math.max(1, parseInt(s.maxSteps) || 40),
  };
  fillProviderSelect();
  showProviderFields();
  $("approve").checked = settings.approve;
  $("yolo").checked = settings.yolo;
  $("unlimited").checked = settings.unlimited;
  $("maxSteps").value = settings.maxSteps;
  $("maxSteps").disabled = settings.unlimited;
  document.body.classList.toggle("yolo-on", settings.yolo);
  updateOriginRule(cfg()).catch(() => {});
  if (providerProblem()) $("settings").open = true;
}

$("provider").onchange = () => {
  captureFields();
  settings.provider = $("provider").value;
  showProviderFields();
};

$("loadModels").onclick = async () => {
  captureFields();
  const c = cfg();
  const hint = $("providerHint");
  hint.textContent = "Loading models…";
  try {
    await updateOriginRule(c);
    const models = await listModels(c);
    const list = $("modelList");
    list.textContent = "";
    for (const m of models) list.appendChild(new Option(m, m));
    if (!$("model").value && models.length) $("model").value = models[0];
    hint.textContent = models.length ? `${models.length} models found. Type or pick one in the Model box.` : "Connected, but no models were listed.";
  } catch (e) {
    hint.textContent = `Could not load models: ${e.message}. ${c.type === "ollama" ? "Is Ollama running at " + c.baseUrl + "?" : "Check the key and base URL."}`;
  }
};

$("save").onclick = async () => {
  captureFields();
  settings.approve = $("approve").checked;
  settings.yolo = $("yolo").checked;
  settings.unlimited = $("unlimited").checked;
  settings.maxSteps = Math.max(1, parseInt($("maxSteps").value) || 40);
  await chrome.storage.local.set(settings);
  showProviderFields();
  updateOriginRule(cfg()).catch(() => {});
  $("settings").open = false;
  addMsg("tool", `Settings saved. Using ${cfg().label}: ${cfg().model}`, false);
};

$("yolo").onchange = async () => {
  settings.yolo = $("yolo").checked;
  document.body.classList.toggle("yolo-on", settings.yolo);
  await chrome.storage.local.set({ yolo: settings.yolo });
  addMsg("tool", settings.yolo ? "YOLO mode ON: the agent will act without asking." : "YOLO mode off.", false);
};

// Takes effect immediately, even in the middle of a running task.
$("unlimited").onchange = async () => {
  settings.unlimited = $("unlimited").checked;
  $("maxSteps").disabled = settings.unlimited;
  await chrome.storage.local.set({ unlimited: settings.unlimited });
  addMsg("tool", settings.unlimited ? "Unlimited steps ON: the agent runs until the task is done or you press Stop." : `Step limit back to ${settings.maxSteps}.`, false);
};

$("stop").onclick = () => abortCtl?.abort();
$("send").onclick = send;
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});

// ---------------------------------------------------------------- functions injected into pages
// These run inside the web page, so they must be fully self-contained.

function pageSnapshot(maxElements) {
  document.querySelectorAll("[data-gx-id]").forEach((e) => e.removeAttribute("data-gx-id"));
  const selector = [
    "a[href]", "button", "input", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]",
    "[role=menuitem]", "[role=option]", "[role=switch]", "[role=combobox]", "[role=textbox]",
    "[contenteditable='']", "[contenteditable=true]", "[onclick]", "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  const clip = (s, n) => { s = (s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const lines = [];
  const labels = {};
  let n = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (n >= maxElements) { lines.push("… (more elements omitted; scroll or use get_page_text)"); break; }
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
    if (el.disabled && el.tagName !== "INPUT") continue;
    n++;
    el.setAttribute("data-gx-id", String(n));
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const type = el.getAttribute("type");
    let label = el.getAttribute("aria-label") || (el.labels && el.labels[0]?.innerText) || el.innerText ||
      el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || "";
    label = clip(label, 80);
    let extra = "";
    if (tag === "input" || tag === "textarea") {
      if (type !== "password" && el.value) extra += ` value="${clip(el.value, 40)}"`;
      if (type === "checkbox" || type === "radio") extra += el.checked ? " checked" : " unchecked";
    } else if (tag === "select") {
      extra += ` value="${clip(el.selectedOptions[0]?.text, 40)}" options=[${[...el.options].slice(0, 12).map((o) => clip(o.text, 25)).join(" | ")}]`;
    } else if (tag === "a") {
      extra += ` href=${clip(el.getAttribute("href"), 70)}`;
    }
    const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    labels[n] = `${role || tag}${type ? ":" + type : ""} "${label}"`;
    const pos = inView ? ` @${Math.round(((r.left + r.width / 2) / innerWidth) * 1000)},${Math.round(((r.top + r.height / 2) / innerHeight) * 1000)}` : " (offscreen)";
    lines.push(`[${n}] ${role || tag}${type ? ":" + type : ""} "${label}"${extra}${pos}`);
  }
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  const text = clip(document.body?.innerText || "", 2500);
  return {
    labels,
    text:
      `URL: ${location.href}\nTitle: ${document.title}\n` +
      `Scroll: ${Math.round(scrollY)}/${Math.round(maxScroll)}px (viewport ${innerHeight}px)\n` +
      `Interactive elements:\n${lines.join("\n") || "(none found)"}\n\nVisible text excerpt:\n${text}`,
  };
}

function pageText() {
  return { url: location.href, title: document.title, text: (document.body?.innerText || "").slice(0, 20000) };
}

function pageClick(id) {
  const el = document.querySelector(`[data-gx-id="${id}"]`);
  if (!el) return { ok: false, error: "Element not found. Call get_page_state to refresh element indices." };
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus?.({ preventScroll: true });
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  el.click();
  return { ok: true };
}

function pageType(id, text, submit) {
  const el = document.querySelector(`[data-gx-id="${id}"]`);
  if (!el) return { ok: false, error: "Element not found. Call get_page_state to refresh element indices." };
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (el.tagName === "SELECT") {
    const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === text.trim().toLowerCase() || o.value === text) ||
      [...el.options].find((o) => o.text.toLowerCase().includes(text.toLowerCase()));
    if (!opt) return { ok: false, error: "No matching <select> option: " + text };
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected: opt.text };
  }
  if (el.isContentEditable) {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
  } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    return { ok: false, error: "Element is not a text field." };
  }
  if (submit) {
    const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true });
    const notPrevented = el.dispatchEvent(ev);
    el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    if (notPrevented && el.form) el.form.requestSubmit();
  }
  return { ok: true };
}

async function pageMouse(action, a) {
  const ID = "__gx_cursor";
  let cur = document.getElementById(ID);
  if (!cur) {
    cur = document.createElement("div");
    cur.id = ID;
    cur.style.cssText = "position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;transition:transform .2s ease;will-change:transform;";
    cur.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M3 2l7 18 2.5-7.5L20 10z" fill="#1a73e8" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cur);
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Model coordinates use a 0-999 grid over the viewport (Gemini's native convention); convert to CSS pixels.
  const px = (v, size) => Math.max(0, Math.min(size - 1, Math.round(((Number(v) || 0) / 1000) * size)));
  const place = (x, y) => { cur.style.transform = `translate(${x - 3}px,${y - 2}px)`; };
  const ripple = (x, y) => {
    const r = document.createElement("div");
    r.style.cssText = `position:fixed;left:${x - 14}px;top:${y - 14}px;width:28px;height:28px;border-radius:50%;border:2px solid #1a73e8;z-index:2147483646;pointer-events:none;transition:transform .4s,opacity .4s;opacity:.9`;
    document.documentElement.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = "scale(1.8)"; r.style.opacity = "0"; });
    setTimeout(() => r.remove(), 600);
  };
  const deep = (x, y) => {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  const desc = (el) => {
    if (!el) return "nothing";
    const t = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("alt") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 60);
    return `${el.tagName.toLowerCase()}${t ? ` "${t}"` : ""}${el.tagName === "IFRAME" ? " (iframe: contents not reachable)" : ""}`;
  };
  const fire = (el, type, x, y, extra = {}) => {
    const C = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    return el.dispatchEvent(new C(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons: 0, ...extra }));
  };
  const focusedEl = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };

  if (action === "cursor") {
    place(a.x, a.y);
    if (a.ripple) ripple(a.x, a.y);
    return { ok: true, hit: desc(deep(a.x, a.y)) };
  }
  if (action === "focused") {
    const el = focusedEl();
    if (!el || el === document.body || el === document.documentElement) return { ok: false, error: "Nothing is focused. Use click_at on a text field first." };
    return { ok: true, typed_into: desc(el) };
  }

  if (action === "move" || action === "click" || action === "drag" || action === "scroll") {
    const x = px(a.x, innerWidth), y = px(a.y, innerHeight);
    place(x, y);
    const el = deep(x, y);
    if (!el) return { ok: false, error: `No element at pixel (${x}, ${y}) (grid ${a.x},${a.y}).` };

    if (action === "move") {
      for (const t of ["pointerover", "pointermove", "mouseover", "mousemove"]) fire(el, t, x, y);
      return { ok: true, grid: [a.x, a.y], pixel: [x, y], viewport: [innerWidth, innerHeight], hit: desc(el) };
    }

    if (action === "click") {
      const btn = { left: 0, middle: 1, right: 2 }[a.button || "left"] ?? 0;
      const down = { button: btn, buttons: 1 << btn };
      ripple(x, y);
      for (const t of ["pointerover", "pointermove", "mouseover", "mousemove"]) fire(el, t, x, y);
      const times = a.double ? 2 : 1;
      for (let n = 1; n <= times; n++) {
        fire(el, "pointerdown", x, y, down);
        fire(el, "mousedown", x, y, { ...down, detail: n });
        if (n === 1 && btn === 0) {
          const f = el.closest("input,textarea,select,button,a[href],[contenteditable]:not([contenteditable=false]),[tabindex]");
          if (f) f.focus?.({ preventScroll: true }); else document.activeElement?.blur?.();
        }
        fire(el, "pointerup", x, y, { button: btn });
        fire(el, "mouseup", x, y, { button: btn, detail: n });
        if (btn === 0) fire(el, "click", x, y, { detail: n });
        else if (btn === 2) fire(el, "contextmenu", x, y, { button: 2 });
        else fire(el, "auxclick", x, y, { button: btn });
      }
      if (a.double && btn === 0) fire(el, "dblclick", x, y, { detail: 2 });
      return { ok: true, grid: [a.x, a.y], pixel: [x, y], viewport: [innerWidth, innerHeight], hit: desc(el) };
    }

    if (action === "drag") {
      const x2 = px(a.x2, innerWidth), y2 = px(a.y2, innerHeight);
      ripple(x, y);
      fire(el, "pointerdown", x, y, { buttons: 1 });
      fire(el, "mousedown", x, y, { buttons: 1, detail: 1 });
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        const cx = Math.round(x + ((x2 - x) * i) / steps), cy = Math.round(y + ((y2 - y) * i) / steps);
        place(cx, cy);
        const t = deep(cx, cy) || el;
        fire(t, "pointermove", cx, cy, { buttons: 1 });
        fire(t, "mousemove", cx, cy, { buttons: 1 });
        await wait(25);
      }
      const end = deep(x2, y2) || el;
      fire(end, "pointerup", x2, y2);
      fire(end, "mouseup", x2, y2);
      ripple(x2, y2);
      return { ok: true, from: { x, y, hit: desc(el) }, to: { x: x2, y: y2, hit: desc(end) } };
    }

    // scroll at point: wheel event first (lets maps/custom widgets handle it), then the nearest scrollable ancestor
    const dx = Number(a.dx) || 0, dy = Number(a.dy) || 0;
    const handled = !el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, deltaX: dx, deltaY: dy }));
    if (handled) return { ok: true, x, y, note: "The page handled the wheel event itself.", hit: desc(el) };
    let node = el, target = null;
    while (node && node !== document.body && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      const sy = /(auto|scroll|overlay)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 1;
      const sx = /(auto|scroll|overlay)/.test(cs.overflowX) && node.scrollWidth > node.clientWidth + 1;
      if ((dy && sy) || (dx && sx)) {
        const bt = node.scrollTop, bl = node.scrollLeft;
        node.scrollBy({ left: dx, top: dy });
        if (node.scrollTop !== bt || node.scrollLeft !== bl) { target = node; break; }
      }
      node = node.parentElement || node.getRootNode()?.host || null;
    }
    if (!target) { scrollBy({ left: dx, top: dy }); }
    return {
      ok: true, x, y, scrolled: target ? `container ${desc(target)}` : "page",
      position: target ? { top: Math.round(target.scrollTop), max: Math.round(target.scrollHeight - target.clientHeight) }
        : { top: Math.round(scrollY), max: Math.round(document.documentElement.scrollHeight - innerHeight) },
    };
  }

  if (action === "keys") {
    const el = focusedEl();
    if (!el || el === document.body || el === document.documentElement) return { ok: false, error: "Nothing is focused. Use click_at on a text field first." };
    const text = String(a.text ?? "");
    if (el.isContentEditable) {
      if (a.clear) document.execCommand("selectAll", false);
      document.execCommand("insertText", false, text);
    } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      let next;
      try {
        const start = a.clear ? 0 : el.selectionStart ?? el.value.length;
        const end = a.clear ? el.value.length : el.selectionEnd ?? el.value.length;
        next = el.value.slice(0, start) + text + el.value.slice(end);
        setter.call(el, next);
        el.setSelectionRange?.(start + text.length, start + text.length);
      } catch { setter.call(el, (a.clear ? "" : el.value) + text); }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      return { ok: false, error: `Focused element (${desc(el)}) is not a text field.` };
    }
    if (a.submit) {
      const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true });
      const ok = el.dispatchEvent(ev);
      el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      if (ok && el.form) el.form.requestSubmit();
    }
    return { ok: true, typed_into: desc(el) };
  }
  return { ok: false, error: "Unknown mouse action " + action };
}

function pageLocate(id) {
  const el = document.querySelector(`[data-gx-id="${id}"]`);
  if (!el) return { ok: false, error: "Element not found. Call get_page_state to refresh element indices." };
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

function pageKey(key) {
  const el = document.activeElement || document.body;
  const init = { key, code: key.length === 1 ? "Key" + key.toUpperCase() : key, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
  if (key === "Enter" && el.form && el.tagName !== "TEXTAREA") el.form.requestSubmit();
  return { ok: true, target: el.tagName.toLowerCase() };
}

function pageScroll(direction, amount) {
  const dy = amount || Math.round(innerHeight * 0.8);
  if (direction === "top") scrollTo({ top: 0 });
  else if (direction === "bottom") scrollTo({ top: document.documentElement.scrollHeight });
  else scrollBy({ top: direction === "up" ? -dy : dy });
  return { ok: true, scrollY: Math.round(scrollY), maxScroll: Math.round(document.documentElement.scrollHeight - innerHeight) };
}

async function inPage(func, args = []) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: activeTabId }, func, args });
    return res?.result;
  } catch (e) {
    return { ok: false, error: "Cannot run on this page (restricted page such as chrome://, the Web Store, or still loading): " + e.message };
  }
}

// ---------------------------------------------------------------- browser-side tool implementations

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForLoad(tabId, timeout = 10000) {
  await sleep(400);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.status === "complete") break;
    await sleep(200);
  }
  await sleep(500);
}

async function stateText() {
  const r = await inPage(pageSnapshot, [150]);
  if (!r || r.error) return r?.error || "Could not read page.";
  lastLabels = r.labels;
  return r.text;
}

function ensureHttp(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : "https://" + url;
}

// ---------------------------------------------------------------- trusted input (Chrome DevTools Protocol)
// Synthetic DOM events have isTrusted=false and many sites ignore them. chrome.debugger lets us send
// real mouse/keyboard input. Chrome shows a "started debugging this browser" bar while attached.

let dbgTabId = null;

async function cdp(method, params = {}) {
  if (dbgTabId !== activeTabId) {
    await detachDebugger();
    try {
      await chrome.debugger.attach({ tabId: activeTabId }, "1.3");
    } catch (e) {
      if (!/already attached/i.test(e.message)) throw e;
    }
    dbgTabId = activeTabId;
    await chrome.debugger.sendCommand({ tabId: dbgTabId }, "Runtime.enable").catch(() => {});
  }
  return chrome.debugger.sendCommand({ tabId: dbgTabId }, method, params);
}

async function detachDebugger() {
  if (dbgTabId == null) return;
  const id = dbgTabId;
  dbgTabId = null;
  await chrome.debugger.detach({ tabId: id }).catch(() => {});
}

chrome.debugger.onDetach.addListener((src) => { if (src.tabId === dbgTabId) dbgTabId = null; });

// Console output / uncaught errors captured while the debugger is attached.
const consoleBuf = [];
chrome.debugger.onEvent.addListener((src, method, params) => {
  let entry = null;
  if (method === "Runtime.consoleAPICalled") {
    const text = (params.args || []).map((a) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description || a.type)).join(" ");
    entry = { level: params.type, text };
  } else if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails || {};
    entry = { level: "error", text: "Uncaught: " + (d.exception?.description || d.text || "error") };
  }
  if (entry) {
    consoleBuf.push({ tabId: src.tabId, ...entry, text: entry.text.slice(0, 500) });
    if (consoleBuf.length > 300) consoleBuf.shift();
  }
});

const mouseEv = (type, x, y, extra = {}) => cdp("Input.dispatchMouseEvent", { type, x, y, ...extra });

async function gridToPx(...pairs) {
  const vp = await inPage(() => ({ w: innerWidth, h: innerHeight }));
  if (!vp?.w) throw new Error("Cannot read viewport (restricted page?)");
  const c = (v, size) => Math.max(0, Math.min(size - 1, Math.round(((Number(v) || 0) / 1000) * size)));
  return pairs.map(([gx, gy]) => ({ x: c(gx, vp.w), y: c(gy, vp.h) }));
}

const showCursor = (x, y, ripple = false) => inPage(pageMouse, ["cursor", { x, y, ripple }]);

const BUTTONS = { left: ["left", 1], right: ["right", 2], middle: ["middle", 4] };

async function trustedClickPx(x, y, opts = {}) {
  const cur = await showCursor(x, y, true);
  await sleep(220); // let the cursor glide there
  const [name, mask] = BUTTONS[opts.button] || BUTTONS.left;
  await mouseEv("mouseMoved", x, y);
  for (let n = 1; n <= (opts.double ? 2 : 1); n++) {
    await mouseEv("mousePressed", x, y, { button: name, buttons: mask, clickCount: n });
    await sleep(40);
    await mouseEv("mouseReleased", x, y, { button: name, buttons: 0, clickCount: n });
    await sleep(60);
  }
  return { ok: true, trusted: true, pixel: [x, y], hit: cur?.hit };
}

async function trustedMove(x, y) {
  const cur = await showCursor(x, y);
  await sleep(200);
  await mouseEv("mouseMoved", x, y);
  return { ok: true, trusted: true, pixel: [x, y], hit: cur?.hit };
}

async function trustedDrag(a, b) {
  const start = await showCursor(a.x, a.y, true);
  await sleep(220);
  await mouseEv("mouseMoved", a.x, a.y);
  await mouseEv("mousePressed", a.x, a.y, { button: "left", buttons: 1, clickCount: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(a.x + ((b.x - a.x) * i) / steps), y = Math.round(a.y + ((b.y - a.y) * i) / steps);
    await showCursor(x, y);
    await mouseEv("mouseMoved", x, y, { button: "left", buttons: 1 });
    await sleep(30);
  }
  await mouseEv("mouseReleased", b.x, b.y, { button: "left", buttons: 0, clickCount: 1 });
  const end = await showCursor(b.x, b.y, true);
  return { ok: true, trusted: true, from: { pixel: [a.x, a.y], hit: start?.hit }, to: { pixel: [b.x, b.y], hit: end?.hit } };
}

async function trustedScroll(x, y, dx, dy) {
  const cur = await showCursor(x, y);
  await sleep(200);
  await mouseEv("mouseMoved", x, y);
  await mouseEv("mouseWheel", x, y, { deltaX: dx, deltaY: dy });
  await sleep(450);
  return { ok: true, trusted: true, pixel: [x, y], hit: cur?.hit };
}

const KEYS = Object.fromEntries(Object.entries({
  enter: [13, "Enter", "\r"], escape: [27, "Escape"], esc: [27, "Escape"], tab: [9, "Tab"], backspace: [8, "Backspace"],
  delete: [46, "Delete"], arrowup: [38, "ArrowUp"], arrowdown: [40, "ArrowDown"], arrowleft: [37, "ArrowLeft"],
  arrowright: [39, "ArrowRight"], up: [38, "ArrowUp"], down: [40, "ArrowDown"], left: [37, "ArrowLeft"], right: [39, "ArrowRight"],
  home: [36, "Home"], end: [35, "End"], pageup: [33, "PageUp"], pagedown: [34, "PageDown"], space: [32, "Space", " "], " ": [32, "Space", " "],
}));
const MODS = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const EDIT_COMMANDS = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

async function trustedKey(spec) {
  const parts = String(spec).split("+");
  const main = parts.pop() || "+";
  let modifiers = 0;
  for (const m of parts) modifiers |= MODS[m.toLowerCase()] || 0;
  let key, code, vk, text;
  const named = KEYS[main.toLowerCase()];
  if (named) {
    [vk, key, text] = named;
    code = key === "Space" ? "Space" : key;
    key = key === "Space" ? " " : key;
  } else if (main.length === 1) {
    key = main; vk = main.toUpperCase().charCodeAt(0);
    code = /[a-z]/i.test(main) ? "Key" + main.toUpperCase() : /\d/.test(main) ? "Digit" + main : "";
    text = main;
  } else {
    key = code = main; vk = 0;
  }
  const shortcut = modifiers & (1 | 2 | 4);
  if (shortcut) text = undefined;
  const commands = shortcut && modifiers & (2 | 4) && EDIT_COMMANDS[main.toLowerCase()] ? [EDIT_COMMANDS[main.toLowerCase()]] : undefined;
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await cdp("Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", text, unmodifiedText: text, commands });
  await cdp("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

async function trustedType(text, clear, submit) {
  if (clear) await trustedKey("Control+a");
  if (text) await cdp("Input.insertText", { text });
  if (submit) await trustedKey("Enter");
}

const clipText = (str, n) => (str.length > n ? str.slice(0, n) + `… [truncated, ${str.length} chars total]` : str);

async function evalInPage(code) {
  const res = await cdp("Runtime.evaluate", {
    expression: code, awaitPromise: true, userGesture: true, replMode: true, timeout: 15000,
    returnByValue: false, objectGroup: "gx",
  });
  try {
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      return { ok: false, error: clipText(d.exception?.description || d.text || "Script threw an error", 2000) };
    }
    const r = res.result || {};
    if (r.type === "undefined") return { ok: true, result: "undefined" };
    let out;
    if (r.objectId) {
      // Serialize inside the page so DOM nodes, functions and odd objects give something useful instead of "{}".
      const ser = await cdp("Runtime.callFunctionOn", {
        objectId: r.objectId, returnByValue: true,
        functionDeclaration: `function () {
          if (typeof Node !== "undefined" && this instanceof Node) return this.outerHTML || this.textContent || String(this);
          try { const j = JSON.stringify(this); return j === undefined ? String(this) : j; } catch (e) { return String(this); }
        }`,
      });
      out = ser.exceptionDetails ? r.description || r.type : ser.result?.value;
    } else {
      out = "value" in r ? (typeof r.value === "string" ? r.value : JSON.stringify(r.value)) : r.unserializableValue || r.description || r.type;
    }
    return { ok: true, result: clipText(String(out), 8000) };
  } finally {
    cdp("Runtime.releaseObjectGroup", { objectGroup: "gx" }).catch(() => {});
  }
}

// Try real input first; fall back to synthetic DOM events (e.g. page can't be debugged).
async function viaTrusted(trusted, fallback) {
  try {
    return await trusted();
  } catch (e) {
    const r = await fallback();
    if (r && typeof r === "object") r.note = "Used synthetic events (trusted input unavailable: " + e.message + "). Some sites may ignore them.";
    return r;
  }
}

// name -> { risky, describe(args), run(args) }
const tools = {
  get_page_state: {
    risky: false,
    describe: () => "Read the current page",
    run: async () => ({ page: await stateText() }),
  },
  get_page_text: {
    risky: false,
    describe: () => "Read full page text",
    run: async () => await inPage(pageText),
  },
  click: {
    risky: true,
    describe: (a) => `Click [${a.index}] ${lastLabels[a.index] || ""}`,
    run: async (a) => {
      const loc = await inPage(pageLocate, [a.index]);
      if (!loc?.ok) return loc;
      await sleep(120);
      const r = await viaTrusted(
        () => trustedClickPx(loc.x, loc.y),
        () => inPage(pageClick, [a.index]),
      );
      if (!r?.ok) return r;
      await waitForLoad(activeTabId, 4000);
      return { ...r, page: await stateText() };
    },
  },
  type_text: {
    risky: true,
    describe: (a) => `Type "${a.text}" into [${a.index}] ${lastLabels[a.index] || ""}${a.submit ? " and press Enter" : ""}`,
    run: async (a) => {
      const r = await inPage(pageType, [a.index, String(a.text ?? ""), !!a.submit]);
      if (!r?.ok) return r;
      await waitForLoad(activeTabId, a.submit ? 6000 : 1000);
      return { ...r, page: await stateText() };
    },
  },
  press_key: {
    risky: true,
    describe: (a) => `Press key ${a.key}`,
    run: async (a) => {
      const r = await viaTrusted(
        async () => { await trustedKey(a.key); return { ok: true, trusted: true }; },
        () => inPage(pageKey, [String(a.key)]),
      );
      await waitForLoad(activeTabId, 3000);
      return { ...r, page: await stateText() };
    },
  },
  scroll: {
    risky: false,
    describe: (a) => `Scroll ${a.direction}`,
    run: async (a) => {
      const r = await inPage(pageScroll, [a.direction, a.pixels]);
      await sleep(300);
      return { ...r, page: await stateText() };
    },
  },
  move_mouse: {
    risky: false,
    describe: (a) => `Move cursor to (${a.x}, ${a.y})`,
    run: async (a) => viaTrusted(
      async () => { const [p] = await gridToPx([a.x, a.y]); return trustedMove(p.x, p.y); },
      () => inPage(pageMouse, ["move", a]),
    ),
  },
  click_at: {
    risky: true,
    describe: (a) => `${a.double ? "Double-click" : a.button === "right" ? "Right-click" : "Click"} at (${a.x}, ${a.y})`,
    run: async (a) => {
      const r = await viaTrusted(
        async () => { const [p] = await gridToPx([a.x, a.y]); return trustedClickPx(p.x, p.y, a); },
        () => inPage(pageMouse, ["click", a]),
      );
      if (!r?.ok) return r;
      await waitForLoad(activeTabId, 3000);
      return { ...r, page: await stateText() };
    },
  },
  drag: {
    risky: true,
    describe: (a) => `Drag (${a.x}, ${a.y}) → (${a.x2}, ${a.y2})`,
    run: async (a) => {
      const r = await viaTrusted(
        async () => { const [p, q] = await gridToPx([a.x, a.y], [a.x2, a.y2]); return trustedDrag(p, q); },
        () => inPage(pageMouse, ["drag", a]),
      );
      if (!r?.ok) return r;
      await sleep(400);
      return { ...r, page: await stateText() };
    },
  },
  scroll_at: {
    risky: false,
    describe: (a) => `Scroll at (${a.x}, ${a.y}) by (${a.dx || 0}, ${a.dy || 0})`,
    run: async (a) => {
      const r = await viaTrusted(
        async () => { const [p] = await gridToPx([a.x, a.y]); return trustedScroll(p.x, p.y, Number(a.dx) || 0, Number(a.dy) || 0); },
        () => inPage(pageMouse, ["scroll", a]),
      );
      if (!r?.ok) return r;
      return { ...r, page: await stateText() };
    },
  },
  type_keys: {
    risky: true,
    describe: (a) => `Type "${a.text}" into the focused element${a.submit ? " and press Enter" : ""}`,
    run: async (a) => {
      const f = await inPage(pageMouse, ["focused", {}]);
      if (!f?.ok) return f;
      const r = await viaTrusted(
        async () => { await trustedType(String(a.text ?? ""), !!a.clear, !!a.submit); return { ok: true, trusted: true, typed_into: f.typed_into }; },
        () => inPage(pageMouse, ["keys", a]),
      );
      if (!r?.ok) return r;
      await waitForLoad(activeTabId, a.submit ? 6000 : 800);
      return { ...r, page: await stateText() };
    },
  },
  run_javascript: {
    risky: true,
    describe: (a) => "Run JavaScript in the page:\n" + clipText(String(a.code || ""), 400),
    run: async (a) => {
      const r = await evalInPage(String(a.code || ""));
      if (r.ok) { await sleep(300); r.page = await stateText(); }
      return r;
    },
  },
  get_console_logs: {
    risky: false,
    describe: () => "Read console logs",
    run: async (a) => {
      await cdp("Runtime.enable"); // make sure the debugger is attached to this tab
      const mine = consoleBuf.filter((e) => e.tabId === activeTabId);
      const out = mine.slice(-(Number(a.limit) || 50)).map((e) => `[${e.level}] ${e.text}`);
      if (a.clear) for (let i = consoleBuf.length - 1; i >= 0; i--) if (consoleBuf[i].tabId === activeTabId) consoleBuf.splice(i, 1);
      return { logs: out.length ? out : "(no console output captured since the debugger attached to this tab)" };
    },
  },
  navigate: {
    risky: true,
    describe: (a) => `Navigate to ${a.url}`,
    run: async (a) => {
      await chrome.tabs.update(activeTabId, { url: ensureHttp(a.url) });
      await waitForLoad(activeTabId);
      return { ok: true, page: await stateText() };
    },
  },
  go_back: {
    risky: false,
    describe: () => "Go back",
    run: async () => {
      await chrome.tabs.goBack(activeTabId);
      await waitForLoad(activeTabId);
      return { ok: true, page: await stateText() };
    },
  },
  wait: {
    risky: false,
    describe: (a) => `Wait ${a.seconds}s`,
    run: async (a) => {
      await sleep(Math.min(Math.max(Number(a.seconds) || 1, 0), 15) * 1000);
      return { ok: true, page: await stateText() };
    },
  },
  list_tabs: {
    risky: false,
    describe: () => "List tabs",
    run: async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      return { active_tab_id: activeTabId, tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })) };
    },
  },
  switch_tab: {
    risky: true,
    describe: (a) => `Switch to tab ${a.tab_id}`,
    run: async (a) => {
      await chrome.tabs.update(a.tab_id, { active: true });
      activeTabId = a.tab_id;
      return { ok: true, page: await stateText() };
    },
  },
  open_tab: {
    risky: true,
    describe: (a) => `Open new tab: ${a.url}`,
    run: async (a) => {
      const t = await chrome.tabs.create({ url: ensureHttp(a.url), active: true });
      activeTabId = t.id;
      await waitForLoad(t.id);
      return { ok: true, tab_id: t.id, page: await stateText() };
    },
  },
  close_tab: {
    risky: true,
    describe: (a) => `Close tab ${a.tab_id}`,
    run: async (a) => {
      await chrome.tabs.remove(a.tab_id);
      if (a.tab_id === activeTabId) {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        activeTabId = t?.id ?? null;
      }
      return { ok: true, active_tab_id: activeTabId };
    },
  },
  screenshot: {
    risky: false,
    describe: () => "Take screenshot",
    run: async () => {
      const tab = await chrome.tabs.update(activeTabId, { active: true });
      const vp = await inPage(() => ({ w: innerWidth, h: innerHeight }));
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      let b64;
      if (vp?.w && vp?.h) {
        // Scale the capture (device pixels) down to CSS pixels to keep the image small.
        const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
        const canvas = new OffscreenCanvas(vp.w, vp.h);
        canvas.getContext("2d").drawImage(bmp, 0, 0, vp.w, vp.h);
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
        b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(",")[1]); fr.readAsDataURL(blob); });
      } else {
        b64 = dataUrl.split(",")[1];
      }
      return { ok: true, note: `Screenshot attached (${vp?.w}x${vp?.h}). For click_at/move_mouse/drag/scroll_at use a 0-999 grid over this image: x=0 is the left edge, x=999 the right edge, y=0 the top, y=999 the bottom (e.g. the center is 500,500). The blue arrow is the virtual cursor.`, _image: b64 };
    },
  },
};

// ---------------------------------------------------------------- Gemini

const S = "STRING", I = "INTEGER";
const obj = (properties, required = []) => ({ type: "OBJECT", properties, required });
const functionDeclarations = [
  { name: "get_page_state", description: "Get the current page URL, title, a numbered list of interactive elements, and a text excerpt. Use it to see the page and to refresh element indices.", parameters: obj({}) },
  { name: "get_page_text", description: "Get the full visible text of the page (up to 20k chars). Use for reading or summarizing content.", parameters: obj({}) },
  { name: "click", description: "PREFERRED way to click. Click an element by its index from the latest page state. Use this instead of coordinates or scripts whenever the element has an index.", parameters: obj({ index: { type: I } }, ["index"]) },
  { name: "type_text", description: "PREFERRED way to type or pick a dropdown option when the element has an index. Type text into an input/textarea/contenteditable, or choose an option in a select, by index. Replaces existing content.", parameters: obj({ index: { type: I }, text: { type: S }, submit: { type: "BOOLEAN", description: "Press Enter afterwards" } }, ["index", "text"]) },
  { name: "press_key", description: "Press a key (e.g. Enter, Escape, Tab) on the focused element.", parameters: obj({ key: { type: S } }, ["key"]) },
  { name: "scroll", description: "Scroll the page.", parameters: obj({ direction: { type: S, enum: ["up", "down", "top", "bottom"] }, pixels: { type: I } }, ["direction"]) },
  { name: "move_mouse", description: "Move the virtual cursor to (x, y) on a 0-999 grid over the viewport (0,0 = top-left, 999,999 = bottom-right) and fire hover events. Returns the element under the cursor.", parameters: obj({ x: { type: I }, y: { type: I } }, ["x", "y"]) },
  { name: "click_at", description: "Move the virtual cursor to (x, y) on a 0-999 grid over the viewport (0,0 = top-left, 999,999 = bottom-right) and click there. Use positions from a screenshot or the @x,y values in the page state (same grid). Supports right-click and double-click. Returns the element that was hit; verify it is what you intended.", parameters: obj({ x: { type: I }, y: { type: I }, button: { type: S, enum: ["left", "right", "middle"] }, double: { type: "BOOLEAN" } }, ["x", "y"]) },
  { name: "drag", description: "Press at (x, y), drag to (x2, y2) (0-999 grid coordinates) and release. For sliders, resizing, drag-and-drop and selecting.", parameters: obj({ x: { type: I }, y: { type: I }, x2: { type: I }, y2: { type: I } }, ["x", "y", "x2", "y2"]) },
  { name: "scroll_at", description: "Scroll whatever scrollable area is under (x, y) (0-999 grid) by dx/dy in pixels (positive dy = down, e.g. 400). Use this for scrollable panels, lists, modals and the page.", parameters: obj({ x: { type: I }, y: { type: I }, dx: { type: I }, dy: { type: I } }, ["x", "y"]) },
  { name: "type_keys", description: "Type text at the caret of the currently focused element (click a field with click_at first). Set clear=true to replace existing content.", parameters: obj({ text: { type: S }, clear: { type: "BOOLEAN" }, submit: { type: "BOOLEAN", description: "Press Enter afterwards" } }, ["text"]) },
  { name: "run_javascript", description: "LAST RESORT, rarely needed. Do NOT use it to click, type, fill forms, scroll, navigate, or to work around a failed click; use click/type_text/click_at/type_keys for those. Only use it to extract bulk or hidden data that get_page_state/get_page_text cannot give you. Executes JavaScript in the page's own context (main world) via the debugger. Supports top-level await; the value of the last expression (or a returned/awaited value) is returned as JSON, up to 8000 chars. Use it to extract data, read page state, call page APIs or do things the click/type tools can't. Keep scripts small and focused; return only what you need.", parameters: obj({ code: { type: S } }, ["code"]) },
  { name: "get_console_logs", description: "Get recent console output and uncaught errors from the current tab (captured since the debugger attached to it, i.e. after the first click/type/run_javascript call in that tab).", parameters: obj({ limit: { type: I }, clear: { type: "BOOLEAN" } }) },
  { name: "navigate", description: "Navigate the current tab to a URL.", parameters: obj({ url: { type: S } }, ["url"]) },
  { name: "go_back", description: "Go back in the current tab's history.", parameters: obj({}) },
  { name: "wait", description: "Wait for the page to update (max 15 seconds).", parameters: obj({ seconds: { type: I } }, ["seconds"]) },
  { name: "list_tabs", description: "List tabs in the current window.", parameters: obj({}) },
  { name: "switch_tab", description: "Switch to a tab by id.", parameters: obj({ tab_id: { type: I } }, ["tab_id"]) },
  { name: "open_tab", description: "Open a URL in a new tab and switch to it.", parameters: obj({ url: { type: S } }, ["url"]) },
  { name: "close_tab", description: "Close a tab by id.", parameters: obj({ tab_id: { type: I } }, ["tab_id"]) },
  { name: "screenshot", description: "Capture a screenshot of the visible part of the current tab. Use when the text state is not enough (images, canvas, layout).", parameters: obj({}) },
];


// Sleep that can be cancelled with the Stop button.
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Stopped."));
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error("Stopped.")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// How long Gemini wants us to wait (seconds): Retry-After header, RetryInfo detail, or "retry in 12.3s" in the message.
function retryDelaySeconds(res, errBody) {
  const header = parseFloat(res.headers.get("retry-after"));
  if (header > 0) return header;
  const info = (errBody?.error?.details || []).find((d) => /RetryInfo/.test(d["@type"] || ""));
  const fromInfo = parseFloat(info?.retryDelay);
  if (fromInfo > 0) return fromInfo;
  const headerMs = parseFloat(res.headers.get("retry-after-ms"));
  if (headerMs > 0) return headerMs / 1000;
  const m = /(?:retry|try again) in ([\d.]+)\s*(ms|s)/i.exec(apiErrorText(errBody, res));
  return m ? (m[2].toLowerCase() === "ms" ? parseFloat(m[1]) / 1000 : parseFloat(m[1])) : null;
}

const MAX_RATE_LIMIT_WAIT = 15 * 60; // a wait this long means a daily quota, not a per-minute limit

async function waitWithCountdown(seconds, label, signal) {
  const el = addMsg("tool", "", false);
  try {
    for (let left = Math.ceil(seconds); left > 0; left--) {
      el.textContent = `⏳ ${label} Retrying in ${left}s… (press Stop to cancel)`;
      await abortableSleep(1000, signal);
    }
  } finally {
    el.remove();
  }
}

function apiErrorText(errBody, res) {
  const e = errBody?.error;
  if (typeof e === "string") return e;
  return e?.message || errBody?.message || res?.statusText || "request failed";
}

// POST JSON with shared handling: waits out rate limits (429), retries brief server errors, friendly errors.
async function requestJson({ url, headers = {}, body, signal, cfg: c }) {
  const payload = JSON.stringify(body);
  let rateLimited = 0, serverErrors = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, { method: "POST", signal, headers: { "Content-Type": "application/json", ...headers }, body: payload });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new Error(`Could not reach ${c.label} at ${url} (${e.message}). ` +
        (c.type === "ollama" ? "Is Ollama running, and is the base URL right?" : "Check the base URL and your connection."));
    }
    if (res.ok) return res.json();

    let errBody = null;
    try { errBody = await res.json(); } catch {}
    const msg = apiErrorText(errBody, res);

    if (res.status === 429) {
      // Rate limited: wait as long as the provider asks (plus a small buffer), as many times as needed.
      rateLimited++;
      const asked = retryDelaySeconds(res, errBody);
      const wait = (asked ?? Math.min(5 * 2 ** Math.min(rateLimited - 1, 4), 60)) + 1;
      if (wait > MAX_RATE_LIMIT_WAIT) {
        throw new Error(`${c.label} rate limit: asked to wait ${Math.round(wait / 60)} min, which usually means a daily quota is used up. ${msg}`);
      }
      await waitWithCountdown(wait, `${c.label} rate limit hit.`, signal);
      continue;
    }
    if (res.status >= 500 && serverErrors < 5) {
      serverErrors++;
      await waitWithCountdown(Math.min(3 * 2 ** (serverErrors - 1), 30), `${c.label} server error (${res.status}).`, signal);
      continue;
    }
    let hint = "";
    if (/tool/i.test(msg) && /support|not (available|enabled)/i.test(msg)) hint = " Pick a model that supports tool/function calling.";
    else if (res.status === 403 && c.type === "ollama") hint = " Ollama rejected the request origin: save Settings again, or start Ollama with OLLAMA_ORIGINS=chrome-extension://*";
    else if (res.status === 404 && c.type === "ollama") hint = " Is the model pulled? Run: ollama pull " + c.model;
    throw new Error(`${c.label} API ${res.status}: ${msg}${hint}`);
  }
}

function buildSystemPrompt() {
  let t = SYSTEM_PROMPT + (settings.yolo ? YOLO_ADDENDUM : "");
  if (!cfg().vision) t += "\n\nNOTE: This model cannot see images, so screenshots are unavailable. Rely on get_page_state (element list with @x,y positions) and get_page_text.";
  return t;
}

function callModel(signal) {
  const c = cfg();
  const tools = functionDeclarations.filter((d) => c.vision || d.name !== "screenshot");
  return callProvider(c, buildSystemPrompt(), history, tools, signal);
}

// Keep history small so long (or unlimited) runs don't blow up the context window:
// only the newest page snapshot, the 2 newest screenshots, and clipped older tool outputs.
function pruneHistory() {
  let images = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    for (const p of history[i].parts || []) {
      if (p.inlineData && ++images > 2) { delete p.inlineData; p.text = "[older screenshot omitted]"; }
      const resp = p.functionResponse?.response;
      if (!resp) continue;
      if (resp.page) resp.page = "[older page state omitted]";
      for (const k of Object.keys(resp)) {
        if (typeof resp[k] === "string" && resp[k].length > 1500) resp[k] = resp[k].slice(0, 1500) + "… [older output clipped]";
        else if (Array.isArray(resp[k]) && JSON.stringify(resp[k]).length > 1500) resp[k] = JSON.stringify(resp[k]).slice(0, 1500) + "… [older output clipped]";
      }
    }
  }
}

// Safety net: if the prompt is still huge, drop the oldest (call, result) pairs after the first message.
const MAX_PROMPT_TOKENS = 600000;
function trimHistory(promptTokens) {
  if (!promptTokens || promptTokens < MAX_PROMPT_TOKENS) return;
  let dropped = 0;
  while (dropped < 40 && history.length > 4) {
    const a = history[1], b = history[2];
    const isPair = a?.role === "model" && a.parts?.some((p) => p.functionCall) && b?.role === "user" && b.parts?.some((p) => p.functionResponse);
    if (!isPair) break;
    history.splice(1, 2);
    dropped++;
  }
  if (dropped) addMsg("tool", `Trimmed ${dropped} old steps from memory to stay within the context window.`);
}

// ---------------------------------------------------------------- agent loop

async function send() {
  const text = $("input").value.trim();
  if (!text || running) return;
  const problem = providerProblem();
  if (problem) { $("settings").open = true; addMsg("error", problem, false); return; }
  $("input").value = "";
  if (!convId) { convId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); convCreated = Date.now(); }
  addMsg("user", text);
  // If the previous run was stopped mid-tool-call, close the dangling call so every provider accepts the next message.
  const lastTurn = history[history.length - 1];
  const dangling = lastTurn?.role === "model" ? (lastTurn.parts || []).filter((p) => p.functionCall) : [];
  history.push({
    role: "user",
    parts: [
      ...dangling.map((p) => ({ functionResponse: { name: p.functionCall.name, response: { error: "Interrupted before this action ran." } } })),
      { text },
    ],
  });

  abortCtl = new AbortController();
  setRunning(true);
  try {
    // Always target the tab the user is currently looking at (not a stale one from an earlier task).
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = t?.id ?? null;
    if (activeTabId == null) throw new Error("No active tab found.");
    addMsg("tool", `Working in tab ${activeTabId}: ${t.title || t.url}`);
    await agentLoop(abortCtl.signal);
  } catch (e) {
    addMsg("error", abortCtl.signal.aborted ? "Stopped." : e.message);
  } finally {
    await detachDebugger();
    setRunning(false);
    flushSave();
    $("input").focus();
  }
}

async function agentLoop(signal) {
  let lastSig = "", repeats = 0, fails = 0;
  for (let step = 0; settings.unlimited || step < settings.maxSteps; step++) {
    if (signal.aborted) throw new Error("Stopped.");
    const data = await callModel(signal);
    trimHistory(data.usageMetadata?.promptTokenCount);
    const content = data.candidates?.[0]?.content;
    if (!content?.parts?.length) {
      const why = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || "empty response";
      throw new Error("Gemini returned no content (" + why + ").");
    }
    // Store the model turn verbatim (keeps thought signatures that newer models require).
    history.push(content);

    for (const p of content.parts) if (p.text && !p.thought) addMsg("assistant", p.text);

    const calls = content.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (!calls.length) return;

    const responseParts = [];
    const images = [];
    for (const call of calls) {
      const args = call.args || {};
      const tool = tools[call.name];
      let result;
      if (!tool) {
        result = { error: "Unknown tool " + call.name };
      } else {
        const desc = tool.describe(args);
        const logLine = addMsg("tool", "▶ " + call.name + (Object.keys(args).length ? " " + JSON.stringify(args) : "") + (desc ? "\n  " + desc : ""));
        if (tool.risky && settings.approve && !settings.yolo && !(await askApproval(desc))) {
          result = { error: "The user denied this action. Do not retry it; ask the user what to do instead." };
          markErr(logLine);
        } else {
          try {
            result = await tool.run(args);
          } catch (e) {
            result = { error: e.message };
            markErr(logLine);
          }
        }
        if (result?.error) markErr(logLine);
      }
      // Code-level nudges so a stuck model backs off even if it ignores the prompt.
      const sig = call.name + JSON.stringify(args);
      repeats = sig === lastSig ? repeats + 1 : 0;
      lastSig = sig;
      const failed = !!(result && typeof result === "object" && (result.error || result.ok === false));
      fails = failed ? fails + 1 : 0;
      const warnings = [];
      if (repeats >= 2) warnings.push(`You have now run this exact action ${repeats + 1} times in a row. Do NOT run it again. Use a different method or a different route to the goal.`);
      if (fails >= 5) warnings.push(`STOP: ${fails} failed actions in a row. Do not attempt another action of this kind. Tell the user what is blocking you, what you tried, and what you need, then end your turn.`);
      else if (fails >= 3) warnings.push(`${fails} failed actions in a row. Stop repeating. Diagnose with get_page_state or a screenshot, then use a completely different approach, or report to the user. Do not switch to run_javascript to work around this.`);
      if (warnings.length && result && typeof result === "object") result.warning = warnings.join(" ");
      if (result?._image) { images.push(result._image); delete result._image; }
      responseParts.push({ functionResponse: { name: call.name, response: result ?? {} } });
      if (signal.aborted) throw new Error("Stopped.");
    }

    pruneHistory();
    for (const img of images) responseParts.push({ inlineData: { mimeType: "image/jpeg", data: img } });
    history.push({ role: "user", parts: responseParts });
    scheduleSave();
  }
  addMsg("error", `Reached the ${settings.maxSteps}-step limit. Send another message to continue, or enable Unlimited steps in Settings.`);
}

loadSettings().then(restoreLastConversation);
