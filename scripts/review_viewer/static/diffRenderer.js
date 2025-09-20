const DEFAULT_CLASSES = {
  base: "diff-line",
  added: "added",
  removed: "removed",
  hunk: "hunk",
  context: "context",
};

function classifyLine(line, classes) {
  if (!line) {
    return classes.context;
  }
  if (line.startsWith("diff --git")) {
    return classes.hunk;
  }
  if (line.startsWith("index ")) {
    return classes.hunk;
  }
  if (line.startsWith("+++")) {
    return classes.hunk;
  }
  if (line.startsWith("---")) {
    return classes.hunk;
  }
  if (line.startsWith("@@")) {
    return classes.hunk;
  }
  if (line.startsWith("+")) {
    return classes.added;
  }
  if (line.startsWith("-")) {
    return classes.removed;
  }
  return classes.context;
}

function createLineElement(line, classes) {
  const element = document.createElement("div");
  element.classList.add(classes.base);
  const kind = classifyLine(line, classes);
  if (kind) {
    element.classList.add(kind);
  }
  const text = line.length ? line : "\u00a0";
  element.appendChild(document.createTextNode(text));
  return element;
}

export function applyDiffHighlighting(root, options = {}) {
  const classes = { ...DEFAULT_CLASSES, ...options.classes };
  const scope = root instanceof HTMLElement ? root : document;
  const blocks = scope.querySelectorAll("pre code.language-diff");
  blocks.forEach((block) => {
    if (block.dataset.rendered === "true") {
      return;
    }
    const raw = block.textContent || "";
    const lines = raw.replace(/\n$/, "").split("\n");
    const fragment = document.createDocumentFragment();
    lines.forEach((line) => {
      fragment.appendChild(createLineElement(line, classes));
    });
    block.innerHTML = "";
    block.dataset.rendered = "true";
    block.appendChild(fragment);
  });
}

export default applyDiffHighlighting;
