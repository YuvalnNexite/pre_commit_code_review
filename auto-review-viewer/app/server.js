const express = require('express');
const fs = require('fs');
const path = require('path');
const MarkdownIt = require('markdown-it');

const { parseBadAssessments, applySuggestionDiff } = require('./review-utils');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const SRC_DIR = path.resolve(process.env.SRC_DIR || '/data');
const FILENAME = process.env.FILENAME || 'auto_code_review.md';
const PORT = Number(process.env.PORT || 3000);

const targetPath = path.resolve(SRC_DIR, FILENAME);
const templatePath = path.join(__dirname, 'templates', 'index.html');
const REPO_DIR = process.env.REPO_DIR ? path.resolve(process.env.REPO_DIR) : SRC_DIR;

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

app.get('/api/assessments/bad', async (req, res) => {
  try {
    const [markdown, stats] = await Promise.all([
      readMarkdownFile(),
      fs.promises.stat(targetPath).catch(() => null)
    ]);
    const assessments = parseBadAssessments(markdown);

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.json({
      file: FILENAME,
      count: assessments.length,
      updatedAt: stats ? stats.mtimeMs : null,
      assessments: assessments.map((assessment) => ({
        id: assessment.id,
        verdict: assessment.verdict,
        position: assessment.position,
        title: assessment.title,
        file: assessment.file,
        function: assessment.function,
        lines: assessment.lines,
        details: assessment.details,
        reasoning: assessment.reasoning,
        suggestion: assessment.suggestion
      }))
    });
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : 500;
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.status(status).json({
      error: status === 404 ? 'Review file not found.' : 'Failed to parse review file.',
      details: error.message
    });
  }
});

app.post('/api/assessments/:id/apply', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid assessment identifier.' });
    return;
  }

  try {
    const markdown = await readMarkdownFile();
    const assessments = parseBadAssessments(markdown);
    const assessment = assessments.find((item) => item.id === id);

    if (!assessment) {
      res.status(404).json({ error: 'Assessment not found.' });
      return;
    }

    const overrideDiff = typeof req.body?.diff === 'string' ? req.body.diff : '';
    const diffToApply = overrideDiff.trim() ? overrideDiff : assessment.suggestion.diff;

    if (!diffToApply) {
      res.status(400).json({ error: 'This assessment does not include a diff suggestion to apply.' });
      return;
    }

    const result = await applySuggestionDiff(diffToApply, REPO_DIR);

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.json({
      success: true,
      assessment: {
        id: assessment.id,
        title: assessment.title,
        file: assessment.file
      },
      stdout: result.stdout,
      stderr: result.stderr
    });
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : error.exitCode ? 409 : 500;
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.status(status).json({
      success: false,
      error: status === 404 ? 'Review file not found.' : error.message,
      stdout: error.stdout || '',
      stderr: error.stderr || ''
    });
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
    console.log(`Applying suggestions to: ${REPO_DIR}`);
  });
}

start();
