# Gemini Browser Agent

A small Chrome extension (Manifest V3) that connects to the AI provider of your choice (Gemini, Ollama, OpenAI, Anthropic, OpenRouter, Groq, LM Studio, or any OpenAI-compatible server) and lets the model drive your browser from a side-panel chat, similar to Claude in Chrome.

## Install

1. Pick a provider (see **Providers** below) and get an API key if it needs one, e.g. Gemini at <https://aistudio.google.com/apikey>. Ollama and LM Studio need none.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and pick this folder.
3. Click the extension icon to open the side panel, open **Settings**, paste your key and click **Save**.
4. Type a task, e.g. "Search for the cheapest USB-C hub on this page and summarize the top 3".

## Providers

Choose one in **Settings -> Provider**. Each provider remembers its own key, URL and model, and **Load** lists the models it offers. Chats are stored in one neutral format, so you can switch provider mid-conversation.

| Provider | Notes |
| --- | --- |
| Google Gemini | Default (`gemini-3.5-flash-lite`). |
| Ollama (local) | `http://localhost:11434`, no key. Pick a model with tool support (e.g. `qwen3`, `llama3.1`). Tick **Vision** only for vision models (`qwen2.5vl`, `llama3.2-vision`, `gemma3`). The context length defaults to 32768 tokens because Ollama's own default (4096) is too small for this agent. |
| OpenAI, OpenRouter, Groq | Hosted, need an API key. |
| Anthropic (Claude) | Needs an API key. |
| LM Studio (local) | `http://localhost:1234/v1`, no key. |
| Custom (OpenAI-compatible) | Any server with `/chat/completions` (vLLM, llama.cpp, LiteLLM, Together, DeepSeek, Mistral, ...). Base URL usually ends in `/v1`. |

Models that can't see images (**Vision** unticked) don't get the screenshot tool; they work from the page's element list and text instead.

**Ollama and CORS:** Ollama refuses requests from `chrome-extension://` origins unless started with `OLLAMA_ORIGINS`. For plain-http providers the extension removes the `Origin` header from its own requests (using `declarativeNetRequest`), so it works out of the box; you can also start Ollama with `OLLAMA_ORIGINS=chrome-extension://*`.

## What the agent can do

`get_page_state`, `get_page_text`, `click`, `type_text`, `press_key`, `scroll`, `navigate`, `go_back`, `wait`, `list_tabs`, `switch_tab`, `open_tab`, `close_tab`, `screenshot`.

**Scripting** (via the debugger): `run_javascript` executes code in the page's own context (top-level `await` works; results come back as JSON, DOM nodes as HTML, capped at 8000 chars) and `get_console_logs` returns console output and uncaught errors captured since the debugger attached to the tab. `run_javascript` always needs your approval unless YOLO mode is on, and the approval prompt shows the code.

**Virtual cursor** (a blue arrow drawn on the page, also visible in screenshots): `move_mouse`, `click_at` (left/right/double), `drag`, `scroll_at` (scrolls the panel under the point, or the page), `type_keys` (types into the focused field). Coordinates use a 0-999 grid over the viewport (0,0 = top-left, 999,999 = bottom-right), which is how Gemini natively reports positions; the page state lists each element's `@x,y` center on the same grid. Use these for canvases, maps, custom widgets and anything without a usable element index.

It sees pages as a numbered list of interactive elements plus a text excerpt, and refers to elements by number. It works in the current window's active tab at the time you send a message.

## Real input

Clicks, typing, key presses, drags and scrolling are sent as **trusted browser input** through the Chrome DevTools Protocol (`chrome.debugger`), so pages treat them like a real mouse and keyboard. While the agent is working, Chrome shows a "Gemini Browser Agent started debugging this browser" bar; it disappears when the task ends. If a page can't be debugged (e.g. `chrome://` pages) or another debugger is attached, the agent falls back to synthetic DOM events and tells the model so.

## Saved chats

Every conversation is saved automatically in the browser (`chrome.storage.local`) and the last one reopens when you open the panel. **History** lists saved chats (click one to continue it, ✕ to delete), **New** starts a fresh chat while keeping the old one, and **Export** downloads the current chat as a Markdown file. Screenshots aren't saved; everything else is, so a reopened chat keeps its full context. Your API key is never included in exports.

## Web search (Exa)

Add an [Exa](https://dashboard.exa.ai/api-keys) API key in **Settings** and the agent gains two tools: `web_search` (titles, URLs, dates and text snippets, with optional domain, category and date filters) and `read_url` (clean text of up to 5 URLs without opening a tab). Without a key the tools are hidden from the model entirely. Searching is much faster than driving a search engine through the browser; the agent opens a result in the browser only when it needs to interact with it. Rate limits get the same wait-and-retry handling as the model.

Notes: search results are treated as untrusted web content. Your queries and the URLs it reads are sent to Exa. `read_url` asks for your approval (unless YOLO mode is on) because a fetched URL leaves your machine, which a malicious page could otherwise abuse to smuggle data out.

## Notebook, knowledge and past chats

The agent has a persistent **notebook** that survives across chats: `save_note` (create, update, or append), `search_notes`, `read_note` and `delete_note`. Notes are Markdown with tags. The titles of its notes are included in its prompt each turn, so it knows what it already knows and can check before redoing research. It's also useful as a scratchpad on long tasks, since old steps get trimmed from its context but notes stay. Open the **Notes** panel to browse, edit, add, delete or export (JSON) its notes yourself. Deleting a note asks for approval unless YOLO mode is on, and the prompt forbids saving secrets or instructions found on web pages.

With `search_past_chats` and `read_past_chat` it can look through your earlier saved chats (the one in progress is excluded) when you say things like "like last time" or "continue that". Past chats and notes can contain text that came from web pages, so the prompt tells the model to treat them as data, never as instructions.

## Several tool calls per turn

The model may issue multiple tool calls in one turn (for example reads, notebook saves, or filling several form fields then one click). They run in order. If a call changes the page (click, navigation, Enter-submit, key press, tab switch), later calls in the same turn that rely on element numbers or coordinates are skipped with a message telling the model to re-read the page, and only the newest page state is kept in the context.

## Markdown

Agent replies and notes are rendered as Markdown: headings, bold/italic, lists, task lists, tables, code blocks, quotes and links. The renderer builds DOM nodes (never raw HTML), so page text echoed by the model can't inject markup. Only `http(s)` and `mailto` links are clickable, and images are never loaded (a remote image URL could leak data); they appear as links.

## The system prompt

The agent's instructions live in `prompt.js` and are easy to edit. They tell it to click and type first, to treat `run_javascript` as a last resort, and to back off after failures (never repeat the same action more than twice, at most 3 approaches per goal, stop and report when blocked). The extension also enforces this in code: after 3 failed actions in a row the tool result carries a "change approach" warning, and after 5 it tells the model to stop and report to you.

## Safety

- **Approval mode** (on by default): every click, keystroke, navigation and tab change needs your Allow/Deny in the panel. Turn it off in Settings only if you trust the task and the sites.
- **YOLO mode** (toggle in the panel header): skips all approval prompts and tells the model not to pause for confirmation, even for purchases, sending messages or deleting data. The header turns red while it's on. It's off by default and turns off nothing else, so use it only on tasks and sites you trust.
- The agent acts in your real, logged-in browser. Web pages can contain prompt-injection text; the system prompt tells the model to treat page text as data, but this is not a guarantee. Keep approval mode on for anything sensitive.
- Your API keys are stored in `chrome.storage.local` and sent only to the provider you select.

## Step limit / unlimited steps

By default a task stops after 40 steps (model turns). In **Settings** you can change that number or tick **Unlimited steps**, which takes effect immediately, even mid-task; the agent then runs until it finishes or you press **Stop**. To keep very long runs from overflowing the context window, only the newest page state and the 2 newest screenshots are kept, older tool output is clipped, and if the prompt still grows past ~600k tokens the oldest steps are dropped. If the model repeats the exact same action 5+ times in a row it gets a warning to try something else. Unlimited runs spend API quota the whole time, so keep an eye on them.

## Rate limits

If the provider returns a 429 (rate limit), the agent waits for the delay it asks for (plus a second), shows a live countdown in the panel, and retries automatically, as many times as needed. **Stop** cancels the wait. If the requested wait is over 15 minutes (which usually means a daily quota is used up) it stops with an error instead of hanging. Temporary 5xx server errors are retried up to 5 times with backoff.

## Limitations

- Element indices don't cover shadow DOM or cross-origin iframes (use the screenshot + cursor tools for those). Native browser popups, like an open `<select>` dropdown, can't be operated.
- Cannot run on `chrome://` pages or the Chrome Web Store.
- Whatever model you choose must support tool/function calling. Small local models are noticeably less reliable at multi-step browsing than large hosted ones.
- No icons are bundled; Chrome shows a default one.
