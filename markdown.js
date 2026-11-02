// Small, dependency-free Markdown renderer for the chat panel.
// It builds DOM nodes with createElement/textContent (never innerHTML), so model output - which may echo
// untrusted web page text - cannot inject markup or script. Images are never loaded (a remote image URL
// is a data-exfiltration channel); they are shown as links. Only http(s) and mailto links are clickable.
//
// Supported: headings, paragraphs (single newlines kept as line breaks), **bold**, *italic*, ~~strike~~,
// `code`, fenced code blocks, links and bare URLs, blockquotes, nested ordered/unordered/task lists,
// tables, horizontal rules, backslash escapes.

function renderMarkdown(src) {
  const root = document.createElement("div");
  root.className = "md";
  mdBlocks(String(src ?? "").replace(/\r\n?/g, "\n").split("\n"), root);
  return root;
}

const mdEl = (tag, text) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
};

const MD_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const MD_TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function mdBlocks(lines, parent) {
  let i = 0;
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const p = mdEl("p");
    para.forEach((ln, k) => { if (k) p.appendChild(mdEl("br")); mdInline(p, ln); });
    parent.appendChild(p);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    let m;

    if ((m = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line))) {
      flush();
      const fence = m[1];
      const close = new RegExp("^\\s*" + (fence[0] === "`" ? "`" : "~") + "{" + fence.length + ",}\\s*$");
      const buf = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence (or end of text)
      const pre = mdEl("pre");
      const code = mdEl("code", buf.join("\n"));
      if (m[2]) pre.dataset.lang = m[2];
      pre.appendChild(code);
      parent.appendChild(pre);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      flush();
      const h = mdEl("h" + m[1].length);
      mdInline(h, m[2]);
      parent.appendChild(h);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); parent.appendChild(mdEl("hr")); i++; continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      const bq = mdEl("blockquote");
      mdBlocks(buf, bq);
      parent.appendChild(bq);
      continue;
    }
    if (i + 1 < lines.length && line.includes("|") && MD_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flush();
      i = mdTable(lines, i, parent);
      continue;
    }
    if (MD_LIST.test(line)) { flush(); i = mdList(lines, i, parent); continue; }
    para.push(line.replace(/\s+$/, ""));
    i++;
  }
  flush();
}

function mdList(lines, i, parent) {
  const items = [];
  while (i < lines.length) {
    const m = MD_LIST.exec(lines[i]);
    if (m && items.length && m[1].replace(/\t/g, "    ").length <= items[0].indent && /\d/.test(m[2]) !== items[0].ordered) break; // bullets -> numbers starts a new list
    if (m) {
      items.push({ indent: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] });
      i++;
    } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) {
      items[items.length - 1].text += " " + lines[i].trim(); // wrapped continuation of the previous item
      i++;
    } else if (!lines[i].trim() && i + 1 < lines.length && MD_LIST.test(lines[i + 1])) {
      i++; // blank line between items of the same list
    } else break;
  }
  const mk = (it) => {
    const l = mdEl(it.ordered ? "ol" : "ul");
    if (it.ordered && it.start > 1) l.start = it.start;
    return l;
  };
  const rootList = mk(items[0]);
  parent.appendChild(rootList);
  const stack = [{ indent: items[0].indent, list: rootList, lastLi: null }];
  for (const it of items) {
    while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) stack.pop();
    let top = stack[stack.length - 1];
    if (it.indent > top.indent && top.lastLi) {
      const nested = mk(it);
      top.lastLi.appendChild(nested);
      stack.push({ indent: it.indent, list: nested, lastLi: null });
      top = stack[stack.length - 1];
    }
    const li = mdEl("li");
    let text = it.text;
    const task = /^\[( |x|X)\]\s+/.exec(text);
    if (task) { li.className = "task"; text = (task[1] === " " ? "☐ " : "☑ ") + text.slice(task[0].length); }
    mdInline(li, text);
    top.list.appendChild(li);
    top.lastLi = li;
  }
  return i;
}

function mdTable(lines, i, parent) {
  const cells = (row) => {
    let r = row.trim();
    if (r.startsWith("|")) r = r.slice(1);
    if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
    return r.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
  };
  const head = cells(lines[i]);
  const aligns = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : /^:-/.test(c) ? "left" : ""));
  const table = mdEl("table");
  const thead = mdEl("thead");
  const hr = mdEl("tr");
  head.forEach((c, k) => { const th = mdEl("th"); if (aligns[k]) th.style.textAlign = aligns[k]; mdInline(th, c); hr.appendChild(th); });
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = mdEl("tbody");
  i += 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
    const tr = mdEl("tr");
    const row = cells(lines[i]);
    for (let k = 0; k < head.length; k++) {
      const td = mdEl("td");
      if (aligns[k]) td.style.textAlign = aligns[k];
      mdInline(td, row[k] ?? "");
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
    i++;
  }
  table.appendChild(tbody);
  const wrap = mdEl("div");
  wrap.className = "mdscroll";
  wrap.appendChild(table);
  parent.appendChild(wrap);
  return i;
}

function mdSafeUrl(u) {
  try {
    const url = new URL(u);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const MD_INLINE = new RegExp(
  [
    "\\\\([\\\\`*_{}\\[\\]()#+\\-.!~|>])",                       // 1: backslash escape
    "(`+)([\\s\\S]*?[^`])\\2(?!`)",                               // 2,3: inline code
    "\\*\\*([\\s\\S]+?)\\*\\*",                                   // 4: bold
    "__([\\s\\S]+?)__",                                           // 5: bold
    "~~([\\s\\S]+?)~~",                                           // 6: strikethrough
    "\\*([^\\s*][\\s\\S]*?)\\*",                                  // 7: italic
    "(?<![\\w])_([^\\s_][\\s\\S]*?)_(?![\\w])",                   // 8: italic
    "(!?)\\[([^\\]]*)\\]\\(\\s*<?([^)\\s>]+)>?(?:\\s+\"[^\"]*\")?\\s*\\)", // 9,10,11: link / image
    "(https?:\\/\\/[^\\s<>]+[^\\s<>.,;:!?'\")\\]])",              // 12: bare URL
  ].join("|"),
  "g",
);

function mdInline(parent, text) {
  let last = 0;
  // A fresh regex per call: nested calls (bold inside italic, etc.) must not share lastIndex.
  const re = new RegExp(MD_INLINE.source, "g");
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      parent.appendChild(document.createTextNode(m[1]));
    } else if (m[2] !== undefined) {
      parent.appendChild(mdEl("code", m[3].replace(/^ (.*) $/, "$1")));
    } else if (m[4] !== undefined || m[5] !== undefined) {
      const b = mdEl("strong"); mdInline(b, m[4] ?? m[5]); parent.appendChild(b);
    } else if (m[6] !== undefined) {
      const s = mdEl("del"); mdInline(s, m[6]); parent.appendChild(s);
    } else if (m[7] !== undefined || m[8] !== undefined) {
      const e = mdEl("em"); mdInline(e, m[7] ?? m[8]); parent.appendChild(e);
    } else if (m[11] !== undefined) {
      const href = mdSafeUrl(m[11]);
      const label = m[10] || m[11];
      if (m[9] === "!") {
        // never load remote images; show a link to it instead
        const a = mdEl("a", "🖼 " + (m[10] || "image"));
        if (href) { a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = href; }
        parent.appendChild(a);
      } else if (href) {
        const a = mdEl("a");
        a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = href;
        mdInline(a, label);
        parent.appendChild(a);
      } else {
        parent.appendChild(document.createTextNode(m[0]));
      }
    } else if (m[12] !== undefined) {
      const href = mdSafeUrl(m[12]);
      if (href) {
        const a = mdEl("a", m[12]);
        a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = href;
        parent.appendChild(a);
      } else parent.appendChild(document.createTextNode(m[12]));
    }
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}
