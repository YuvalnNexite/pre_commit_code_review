import applyDiffHighlighting from "./diffRenderer.js";

const STATUS_CLASSES = [
  "status--muted",
  "status--success",
  "status--warning",
  "status--error",
  "status--loading",
];

const HTML_ESCAPE = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPE[char] || char);
}

function sanitizeLanguage(lang) {
  if (!lang) {
    return "plain";
  }
  return lang
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9+#.-]+/g, "-");
}

function sanitizeHref(url) {
  const trimmed = String(url || "").trim();
  if (/^(https?:|mailto:|\/|#)/i.test(trimmed)) {
    return trimmed;
  }
  return "#";
}

function renderInline(text) {
  const codeSnippets = [];
  let working = String(text).replace(/`([^`]+)`/g, (_, code) => {
    const index = codeSnippets.length;
    codeSnippets.push(`<code class="code-inline">${escapeHtml(code)}</code>`);
    return `@@CODE${index}@@`;
  });

  working = escapeHtml(working);
  working = working.replace(/\*\*([^*]+)\*\*/g, (_, value) => `<strong>${value}</strong>`);
  working = working.replace(/\*([^*]+)\*/g, (_, value) => `<em>${value}</em>`);
  working = working.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    return `<a href="${sanitizeHref(url)}" target="_blank" rel="noopener">${label}</a>`;
  });

  codeSnippets.forEach((snippet, index) => {
    working = working.replace(`@@CODE${index}@@`, snippet);
  });
  return working;
}

function flushParagraph(buffer, output) {
  if (!buffer.length) {
    return;
  }
  output.push(`<p>${renderInline(buffer.join(" "))}</p>`);
  buffer.length = 0;
}

function flushList(listState, output) {
  if (!listState.type) {
    return;
  }
  output.push(`</${listState.type}>`);
  listState.type = null;
}

function flushCode(codeState, output) {
  if (!codeState.active) {
    return;
  }
  const language = sanitizeLanguage(codeState.lang);
  const content = escapeHtml(codeState.lines.join("\n"));
  output.push(`<pre><code class="language-${language}">${content}</code></pre>`);
  codeState.active = false;
  codeState.lines = [];
  codeState.lang = "plain";
}

function renderMarkdown(source) {
  if (!source) {
    return "";
  }

  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const output = [];
  const paragraph = [];
  const listState = { type: null };
  const codeState = { active: false, lang: "plain", lines: [] };

  const closeParagraphAndList = () => {
    flushParagraph(paragraph, output);
    flushList(listState, output);
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();

    if (codeState.active) {
      if (trimmed.startsWith("```") && trimmed.length >= 3) {
        flushCode(codeState, output);
      } else {
        codeState.lines.push(rawLine.replace(/\r$/, ""));
      }
      continue;
    }

    if (trimmed.startsWith("```") && trimmed.length >= 3) {
      closeParagraphAndList();
      codeState.active = true;
      codeState.lang = trimmed.slice(3).trim() || "plain";
      codeState.lines = [];
      continue;
    }

    if (!trimmed) {
      flushParagraph(paragraph, output);
      flushList(listState, output);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      closeParagraphAndList();
      const level = headingMatch[1].length;
      output.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      closeParagraphAndList();
      output.push("<hr />");
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      flushParagraph(paragraph, output);
      if (listState.type !== "ol") {
        flushList(listState, output);
        output.push("<ol>");
        listState.type = "ol";
      }
      const item = trimmed.replace(/^\d+\.\s+/, "");
      output.push(`<li>${renderInline(item)}</li>`);
      continue;
    }

    if (/^[*-]\s+/.test(trimmed)) {
      flushParagraph(paragraph, output);
      if (listState.type !== "ul") {
        flushList(listState, output);
        output.push("<ul>");
        listState.type = "ul";
      }
      const item = trimmed.replace(/^[*-]\s+/, "");
      output.push(`<li>${renderInline(item)}</li>`);
      continue;
    }

    paragraph.push(line);
  }

  flushCode(codeState, output);
  flushParagraph(paragraph, output);
  flushList(listState, output);

  return output.join("\n");
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("directory-form");
  const input = document.getElementById("directory-input");
  const content = document.getElementById("content");
  const statusEl = document.getElementById("status");
  const liveStatusEl = document.getElementById("last-updated");

  if (!form || !input || !content) {
    return;
  }

  let currentDir = ".";
  let eventSource = null;
  let lastPayload = null;

  const setStatus = (message, level = "muted") => {
    if (!statusEl) {
      return;
    }
    STATUS_CLASSES.forEach((cls) => statusEl.classList.remove(cls));
    if (!message) {
      statusEl.textContent = "";
      return;
    }
    statusEl.textContent = message;
    statusEl.classList.add(`status--${level}`);
  };

  const updateLiveStatus = (payload) => {
    if (!liveStatusEl) {
      return;
    }
    if (!payload) {
      liveStatusEl.textContent = "";
      return;
    }
    if (!payload.exists) {
      liveStatusEl.textContent = "Watching for changes… (file not found)";
      return;
    }
    if (payload.mtime) {
      const timestamp = new Date(payload.mtime);
      if (!Number.isNaN(timestamp.valueOf())) {
        liveStatusEl.textContent = `Live updates ready — last change ${timestamp.toLocaleString()}`;
        return;
      }
    }
    liveStatusEl.textContent = "Live updates ready.";
  };

  const showNotFound = (dir) => {
    content.innerHTML = `<p class="empty">auto_code_review.md not found in <code>${escapeHtml(dir || ".")}</code>.</p>`;
  };

  const renderContent = (markdown) => {
    if (!markdown || !markdown.trim()) {
      content.innerHTML = '<p class="empty">auto_code_review.md is empty.</p>';
      return;
    }
    const html = renderMarkdown(markdown);
    content.innerHTML = html;
    applyDiffHighlighting(content);
  };

  const fetchContent = async (dir, { silent = false } = {}) => {
    const targetDir = dir || ".";
    if (!silent) {
      setStatus(`Loading review for “${targetDir}”…`, "loading");
    }
    try {
      const response = await fetch(`/api/review?dir=${encodeURIComponent(targetDir)}`);
      if (response.ok) {
        const data = await response.json();
        renderContent(data.content);
        const displayDir = data.directory || targetDir;
        if (silent) {
          const refreshedAt = new Date();
          setStatus(
            `auto_code_review.md refreshed automatically (${refreshedAt.toLocaleTimeString()}).`,
            "success",
          );
        } else {
          setStatus(`Loaded review for “${displayDir}”.`, "success");
        }
        return;
      }
      if (response.status === 404) {
        showNotFound(targetDir);
        setStatus(`No auto_code_review.md found in “${targetDir}”.`, "warning");
        return;
      }
      setStatus(`Failed to load review (status ${response.status}).`, "error");
    } catch (error) {
      setStatus("Unable to reach the server.", "error");
    }
  };

  const connectStream = (dir) => {
    if (eventSource) {
      eventSource.close();
    }
    const targetDir = dir || ".";
    lastPayload = null;
    updateLiveStatus(null);
    eventSource = new EventSource(`/stream?dir=${encodeURIComponent(targetDir)}`);
    eventSource.onopen = () => {
      if (liveStatusEl) {
        liveStatusEl.textContent = "Live updates connected.";
      }
    };
    eventSource.onmessage = (event) => {
      if (!event.data) {
        return;
      }
      try {
        const payload = JSON.parse(event.data);
        lastPayload = payload;
        updateLiveStatus(payload);
        if (payload.type === "update") {
          fetchContent(currentDir, { silent: true });
        }
      } catch (err) {
        // Ignore malformed payloads
      }
    };
    eventSource.onerror = () => {
      updateLiveStatus(lastPayload);
      if (liveStatusEl) {
        liveStatusEl.textContent = "Reconnecting for live updates…";
      }
    };
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = (input.value || "").trim() || ".";
    currentDir = value;
    fetchContent(currentDir);
    connectStream(currentDir);
  });

  input.value = currentDir;
  fetchContent(currentDir);
  connectStream(currentDir);
});
