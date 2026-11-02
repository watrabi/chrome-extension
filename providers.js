// Model providers. The agent keeps its conversation in Gemini's "contents" format (that is what chats are
// saved in). Each adapter below turns that into one provider's request and turns the reply back into a
// Gemini-shaped response: { candidates: [{ content: { role: "model", parts } }], usageMetadata }.
// Loaded before sidepanel.js; relies on requestJson() defined there (called only at runtime).

const PROVIDERS = {
  gemini:     { label: "Google Gemini",              type: "gemini",    baseUrl: "https://generativelanguage.googleapis.com/v1beta", needsKey: true,  vision: true,  defaultModel: "gemini-3.5-flash-lite", keyHelp: "Get a key at aistudio.google.com/apikey." },
  ollama:     { label: "Ollama (local)",             type: "ollama",    baseUrl: "http://localhost:11434",                           needsKey: false, vision: false, defaultModel: "qwen3:8b", numCtx: 32768, keyHelp: "Needs a model with tool support (e.g. qwen3, llama3.1, mistral-nemo). Tick Vision only for vision models (e.g. qwen2.5vl, llama3.2-vision, gemma3)." },
  openai:     { label: "OpenAI",                     type: "openai",    baseUrl: "https://api.openai.com/v1",                        needsKey: true,  vision: true,  defaultModel: "gpt-4.1-mini", keyHelp: "Get a key at platform.openai.com/api-keys." },
  anthropic:  { label: "Anthropic (Claude)",         type: "anthropic", baseUrl: "https://api.anthropic.com/v1",                     needsKey: true,  vision: true,  defaultModel: "claude-sonnet-5-5", keyHelp: "Get a key at console.anthropic.com." },
  openrouter: { label: "OpenRouter",                 type: "openai",    baseUrl: "https://openrouter.ai/api/v1",                     needsKey: true,  vision: true,  defaultModel: "google/gemini-2.5-flash", keyHelp: "One key for many models: openrouter.ai/keys." },
  groq:       { label: "Groq",                       type: "openai",    baseUrl: "https://api.groq.com/openai/v1",                   needsKey: true,  vision: false, defaultModel: "llama-3.3-70b-versatile", keyHelp: "Get a key at console.groq.com/keys." },
  lmstudio:   { label: "LM Studio (local)",          type: "openai",    baseUrl: "http://localhost:1234/v1",                         needsKey: false, vision: false, defaultModel: "", keyHelp: "Start the LM Studio local server and load a tool-capable model." },
  custom:     { label: "Custom (OpenAI-compatible)", type: "openai",    baseUrl: "",                                                 needsKey: false, vision: false, defaultModel: "", keyHelp: "Any server with /chat/completions: vLLM, llama.cpp, LiteLLM, Together, DeepSeek, Mistral, ... Base URL usually ends in /v1." },
};

function providerConfig(id, saved = {}) {
  const base = PROVIDERS[id] || PROVIDERS.gemini;
  const cfg = { id: PROVIDERS[id] ? id : "gemini", ...base };
  for (const k of ["apiKey", "baseUrl", "model", "vision", "numCtx"]) if (saved[k] !== undefined && saved[k] !== "") cfg[k] = saved[k];
  cfg.apiKey = cfg.apiKey || "";
  cfg.model = cfg.model || base.defaultModel || "";
  cfg.baseUrl = String(cfg.baseUrl || "").trim().replace(/\/+$/, "");
  return cfg;
}

// ---------------------------------------------------------------- shared helpers

// Gemini function schemas use upper-case types ("OBJECT"); everyone else wants JSON Schema ("object").
function toJsonSchema(node) {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = k === "type" && typeof v === "string" ? v.toLowerCase() : toJsonSchema(v);
    return out;
  }
  return node;
}

// Gemini-format history -> a neutral message list:
//   { role: "user", text, images }, { role: "assistant", text, calls: [{id,name,args}] },
//   { role: "tool", results: [{id,name,response}], images }
// Tool-call ids are derived from position so they stay stable and need no storing.
function toNeutral(contents) {
  const out = [];
  let pending = [];
  contents.forEach((c, i) => {
    const parts = c.parts || [];
    if (c.role === "model") {
      const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n");
      const calls = parts.filter((p) => p.functionCall).map((p, j) => ({ id: `call_${i}_${j}`, name: p.functionCall.name, args: p.functionCall.args || {} }));
      out.push({ role: "assistant", text, calls });
      pending = calls.slice();
      return;
    }
    const resps = parts.filter((p) => p.functionResponse);
    const images = parts.filter((p) => p.inlineData).map((p) => p.inlineData);
    const text = parts.filter((p) => p.text).map((p) => p.text).join("\n");
    if (resps.length) {
      const results = resps.map((p, j) => {
        const k = pending.findIndex((c2) => c2.name === p.functionResponse.name);
        const call = k >= 0 ? pending.splice(k, 1)[0] : { id: `call_${i}_r${j}` };
        return { id: call.id, name: p.functionResponse.name, response: p.functionResponse.response ?? {} };
      });
      out.push({ role: "tool", results, images });
      const extra = text.replace(/\[(older screenshot omitted|screenshot not saved)\]/g, "").trim();
      if (extra) out.push({ role: "user", text: extra, images: [] });
    } else if (text || images.length) {
      out.push({ role: "user", text, images });
    }
  });
  return out;
}

const jsonStr = (o) => { try { return JSON.stringify(o); } catch { return String(o); } };
const mimeOf = (img) => img.mimeType || "image/jpeg";

function geminiShaped(parts, finishReason, promptTokens) {
  return { candidates: [{ content: { role: "model", parts }, finishReason }], usageMetadata: { promptTokenCount: promptTokens } };
}

// ---------------------------------------------------------------- Gemini

async function callGeminiApi(cfg, system, contents, tools, signal) {
  return requestJson({
    url: `${cfg.baseUrl}/models/${encodeURIComponent(cfg.model)}:generateContent`,
    headers: { "x-goog-api-key": cfg.apiKey },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: tools }],
    },
    signal, cfg,
  });
}

// ---------------------------------------------------------------- OpenAI-compatible (OpenAI, OpenRouter, Groq, LM Studio, vLLM, ...)

async function callOpenAICompatible(cfg, system, contents, tools, signal) {
  const messages = [{ role: "system", content: system }];
  for (const m of toNeutral(contents)) {
    if (m.role === "user") {
      const imgs = cfg.vision ? m.images : [];
      messages.push({
        role: "user",
        content: imgs.length
          ? [{ type: "text", text: m.text || "(image)" }, ...imgs.map((im) => ({ type: "image_url", image_url: { url: `data:${mimeOf(im)};base64,${im.data}` } }))]
          : m.text,
      });
    } else if (m.role === "assistant") {
      const msg = { role: "assistant", content: m.text || null };
      if (m.calls.length) msg.tool_calls = m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: jsonStr(c.args) } }));
      messages.push(msg);
    } else {
      for (const r of m.results) messages.push({ role: "tool", tool_call_id: r.id, content: jsonStr(r.response) });
      if (cfg.vision && m.images.length) {
        messages.push({ role: "user", content: [{ type: "text", text: "Screenshot from the previous tool call:" }, ...m.images.map((im) => ({ type: "image_url", image_url: { url: `data:${mimeOf(im)};base64,${im.data}` } }))] });
      }
    }
  }
  const headers = cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
  if (cfg.id === "openrouter") Object.assign(headers, { "X-Title": "Gemini Browser Agent" });
  const data = await requestJson({
    url: `${cfg.baseUrl}/chat/completions`,
    headers,
    body: {
      model: cfg.model,
      messages,
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: toJsonSchema(t.parameters) } })),
    },
    signal, cfg,
  });
  const choice = data.choices?.[0];
  const msg = choice?.message || {};
  const parts = [];
  const text = Array.isArray(msg.content) ? msg.content.map((c) => c.text || "").join("") : msg.content;
  if (text) parts.push({ text });
  for (const tc of msg.tool_calls || []) {
    let args = tc.function?.arguments ?? {};
    if (typeof args === "string") { try { args = JSON.parse(args || "{}"); } catch { args = {}; } }
    parts.push({ functionCall: { name: tc.function?.name, args } });
  }
  return geminiShaped(parts, choice?.finish_reason, data.usage?.prompt_tokens);
}

// ---------------------------------------------------------------- Ollama (native /api/chat)

async function callOllama(cfg, system, contents, tools, signal) {
  const messages = [{ role: "system", content: system }];
  for (const m of toNeutral(contents)) {
    if (m.role === "user") {
      const msg = { role: "user", content: m.text || "(image)" };
      if (cfg.vision && m.images.length) msg.images = m.images.map((im) => im.data);
      messages.push(msg);
    } else if (m.role === "assistant") {
      const msg = { role: "assistant", content: m.text || "" };
      if (m.calls.length) msg.tool_calls = m.calls.map((c) => ({ function: { name: c.name, arguments: c.args } }));
      messages.push(msg);
    } else {
      for (const r of m.results) messages.push({ role: "tool", tool_name: r.name, content: jsonStr(r.response) });
      if (cfg.vision && m.images.length) messages.push({ role: "user", content: "Screenshot from the previous tool call:", images: m.images.map((im) => im.data) });
    }
  }
  const data = await requestJson({
    url: `${cfg.baseUrl}/api/chat`,
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
    body: {
      model: cfg.model,
      messages,
      stream: false,
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: toJsonSchema(t.parameters) } })),
      // Ollama's default context (4096) is far too small for this agent's prompt + page states.
      options: { num_ctx: Number(cfg.numCtx) || 32768 },
    },
    signal, cfg,
  });
  const msg = data.message || {};
  const parts = [];
  if (msg.content) parts.push({ text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let args = tc.function?.arguments ?? {};
    if (typeof args === "string") { try { args = JSON.parse(args || "{}"); } catch { args = {}; } }
    parts.push({ functionCall: { name: tc.function?.name, args } });
  }
  return geminiShaped(parts, data.done_reason, data.prompt_eval_count);
}

// ---------------------------------------------------------------- Anthropic (Messages API)

async function callAnthropic(cfg, system, contents, tools, signal) {
  const img = (im) => ({ type: "image", source: { type: "base64", media_type: mimeOf(im), data: im.data } });
  const messages = [];
  for (const m of toNeutral(contents)) {
    if (m.role === "user") {
      const blocks = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      if (cfg.vision) blocks.push(...m.images.map(img));
      if (blocks.length) messages.push({ role: "user", content: blocks });
    } else if (m.role === "assistant") {
      const blocks = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const c of m.calls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      if (blocks.length) messages.push({ role: "assistant", content: blocks });
    } else {
      const blocks = m.results.map((r, k) => ({
        type: "tool_result",
        tool_use_id: r.id,
        content: k === 0 && cfg.vision && m.images.length
          ? [{ type: "text", text: jsonStr(r.response) }, ...m.images.map(img)]
          : jsonStr(r.response),
      }));
      messages.push({ role: "user", content: blocks });
    }
  }
  const data = await requestJson({
    url: `${cfg.baseUrl}/messages`,
    headers: {
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: {
      model: cfg.model,
      max_tokens: 8192,
      system,
      messages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: toJsonSchema(t.parameters) })),
    },
    signal, cfg,
  });
  const parts = [];
  for (const b of data.content || []) {
    if (b.type === "text" && b.text) parts.push({ text: b.text });
    else if (b.type === "tool_use") parts.push({ functionCall: { name: b.name, args: b.input || {} } });
  }
  const u = data.usage || {};
  return geminiShaped(parts, data.stop_reason, (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0));
}

// ---------------------------------------------------------------- dispatch + model listing

function callProvider(cfg, system, contents, tools, signal) {
  switch (cfg.type) {
    case "ollama": return callOllama(cfg, system, contents, tools, signal);
    case "openai": return callOpenAICompatible(cfg, system, contents, tools, signal);
    case "anthropic": return callAnthropic(cfg, system, contents, tools, signal);
    default: return callGeminiApi(cfg, system, contents, tools, signal);
  }
}

async function listModels(cfg) {
  const get = async (url, headers = {}) => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  };
  if (cfg.type === "ollama") return ((await get(`${cfg.baseUrl}/api/tags`)).models || []).map((m) => m.name);
  if (cfg.type === "anthropic") return ((await get(`${cfg.baseUrl}/models?limit=100`, { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" })).data || []).map((m) => m.id);
  if (cfg.type === "openai") return ((await get(`${cfg.baseUrl}/models`, cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})).data || []).map((m) => m.id);
  const data = await get(`${cfg.baseUrl}/models?pageSize=200`, { "x-goog-api-key": cfg.apiKey });
  return (data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => m.name.replace(/^models\//, ""));
}

// Local servers (Ollama etc.) often reject requests whose Origin is chrome-extension://... unless they were started
// with OLLAMA_ORIGINS. Strip the Origin header for plain-http providers so it works out of the box.
async function updateOriginRule(cfg) {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr) return;
  const addRules = [];
  try {
    const u = new URL(cfg.baseUrl);
    if (u.protocol === "http:" && cfg.type !== "gemini") {
      addRules.push({
        id: 1, priority: 1,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] },
        condition: { requestDomains: [u.hostname], resourceTypes: ["xmlhttprequest"], initiatorDomains: [chrome.runtime.id] },
      });
    }
  } catch {}
  await dnr.updateDynamicRules({ removeRuleIds: [1], addRules });
}
