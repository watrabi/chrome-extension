# Gemini Browser Agent

A small Chrome extension (Manifest V3) that connects to the Gemini API and lets the model drive your browser from a side-panel chat, similar to Claude in Chrome.

## Install

1. Get a Gemini API key at <https://aistudio.google.com/apikey>.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and pick this folder.
3. Click the extension icon to open the side panel, open **Settings**, paste your key and click **Save**.
4. Type a task, e.g. "Search for the cheapest USB-C hub on this page and summarize the top 3".

## What the agent can do

`get_page_state`, `get_page_text`, `click`, `type_text`, `press_key`, `scroll`, `navigate`, `go_back`, `wait`, `list_tabs`, `switch_tab`, `open_tab`, `close_tab`, `screenshot`.

**Virtual cursor** (a blue arrow drawn on the page, also visible in screenshots): `move_mouse`, `click_at` (left/right/double), `drag`, `scroll_at` (scrolls the panel under the point, or the page), `type_keys` (types into the focused field). Coordinates are viewport CSS pixels; screenshots are scaled so image pixels match them 1:1, and the page state lists each element's `@x,y` center. Use these for canvases, maps, custom widgets and anything without a usable element index.

It sees pages as a numbered list of interactive elements plus a text excerpt, and refers to elements by number. It works in the current window's active tab at the time you send a message.

## Safety

- **Approval mode** (on by default): every click, keystroke, navigation and tab change needs your Allow/Deny in the panel. Turn it off in Settings only if you trust the task and the sites.
- **YOLO mode** (toggle in the panel header): skips all approval prompts and tells the model not to pause for confirmation, even for purchases, sending messages or deleting data. The header turns red while it's on. It's off by default and turns off nothing else, so use it only on tasks and sites you trust.
- The agent acts in your real, logged-in browser. Web pages can contain prompt-injection text; the system prompt tells the model to treat page text as data, but this is not a guarantee. Keep approval mode on for anything sensitive.
- Your API key is stored in `chrome.storage.local` and sent only to `generativelanguage.googleapis.com`.

## Limitations

- Synthetic DOM events: some sites ignore non-trusted clicks/keys, and elements inside shadow DOM or cross-origin iframes are not seen.
- Cannot run on `chrome://` pages or the Chrome Web Store.
- The default model is `gemini-3.5-flash-lite`; change it in Settings (any Gemini model that supports function calling).
- No icons are bundled; Chrome shows a default one.
