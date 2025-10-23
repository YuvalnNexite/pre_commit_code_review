const express = require('express');
const fs = require('fs');
const path = require('path');
const MarkdownIt = require('markdown-it');

const app = express();
app.disable('x-powered-by');

const SRC_DIR = process.env.SRC_DIR || '/data';
const FILENAME = process.env.FILENAME || 'auto_code_review.md';
const PORT = Number(process.env.PORT || 3000);

const targetPath = path.resolve(SRC_DIR, FILENAME);
const templatePath = path.join(__dirname, 'templates', 'index.html');

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true
});

let cachedTemplate = null;

async function loadTemplate() {
  if (cachedTemplate) {
    return cachedTemplate;
  }

  cachedTemplate = await fs.promises.readFile(templatePath, 'utf8');
  return cachedTemplate;
}

async function readMarkdownFile() {
  return fs.promises.readFile(targetPath, 'utf8');
}

function injectTemplate(template, renderedMarkdown) {
  return template
    .replace(/\{\{FILE_NAME\}\}/g, FILENAME)
    .replace(/\{\{FILE_PATH\}\}/g, targetPath)
    .replace(/\{\{CONTENT\}\}/g, renderedMarkdown);
}

app.get('/', async (req, res) => {
  try {
    const [template, markdown] = await Promise.all([
      loadTemplate(),
      readMarkdownFile()
    ]);
    const rendered = md.render(markdown);
    const html = injectTemplate(template, rendered);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.send(html);
  } catch (error) {
    const message = error.code === 'ENOENT'
      ? `Could not find markdown file at ${targetPath}`
      : 'Failed to render markdown file.';
    const details = error.message || 'Unknown error';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.status(500).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Error</title><style>body{font-family:system-ui,sans-serif;padding:2rem;background:#f8f8f8;color:#111}pre{background:#fff;border-radius:0.5rem;padding:1rem;overflow:auto;border:1px solid #e5e5e5}</style></head><body><h1>Auto Code Review Viewer</h1><p>${message}</p><pre>${details}</pre></body></html>`);
  }
});

app.get('/mtime', async (req, res) => {
  try {
    const stats = await fs.promises.stat(targetPath);
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.json({
      file: FILENAME,
      mtimeMs: stats.mtimeMs,
      iso: stats.mtime.toISOString()
    });
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : 500;
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.status(status).json({
      error: error.message,
      file: FILENAME
    });
  }
});

app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.json({ status: 'ok' });
});

function ensureSourceDirectory() {
  return fs.promises.access(targetPath, fs.constants.R_OK)
    .catch((error) => {
      const message = error.code === 'ENOENT'
        ? `Markdown file not found at ${targetPath}`
        : `Cannot read markdown file at ${targetPath}: ${error.message}`;
      console.warn(message);
    });
}

async function start() {
  await ensureSourceDirectory();

  app.listen(PORT, () => {
    console.log(`Auto Code Review Viewer listening on port ${PORT}`);
    console.log(`Rendering markdown from: ${targetPath}`);
  });
}

start();
