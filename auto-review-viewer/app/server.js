const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const MarkdownIt = require('markdown-it');

const logger = require('./logger');
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

function createRequestId() {
  if (typeof randomUUID === 'function') {
    try {
      return randomUUID();
    } catch (error) {
      logger.logWarn('randomUUID threw error, falling back to timestamp-based id', { error });
    }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function loadTemplate() {
  if (cachedTemplate) {
    logger.logDebug('Returning cached HTML template', { templatePath });
    return cachedTemplate;
  }

  logger.logInfo('Loading HTML template from disk', { templatePath });
  cachedTemplate = await fs.promises.readFile(templatePath, 'utf8');
  logger.logDebug('Template loaded from disk', {
    templatePath,
    bytes: cachedTemplate.length
  });
  return cachedTemplate;
}

async function readMarkdownFile() {
  logger.logDebug('Reading markdown review file', { targetPath });
  const content = await fs.promises.readFile(targetPath, 'utf8');
  logger.logDebug('Finished reading markdown review file', {
    targetPath,
    bytes: content.length
  });
  return content;
}

function injectTemplate(template, renderedMarkdown) {
  return template
    .replace(/\{\{FILE_NAME\}\}/g, FILENAME)
    .replace(/\{\{FILE_PATH\}\}/g, targetPath)
    .replace(/\{\{CONTENT\}\}/g, renderedMarkdown);
}

app.get('/', async (req, res) => {
  const requestId = createRequestId();
  logger.logInfo('Received request for index page', {
    requestId,
    path: req.path,
    method: req.method,
    ip: req.ip
  });
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
    logger.logInfo('Served index page successfully', { requestId });
  } catch (error) {
    const message = error.code === 'ENOENT'
      ? `Could not find markdown file at ${targetPath}`
      : 'Failed to render markdown file.';
    const details = error.message || 'Unknown error';
    logger.logError('Failed to serve index page', {
      requestId,
      error,
      message
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.status(500).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Error</title><style>body{font-family:system-ui,sans-serif;padding:2rem;background:#f8f8f8;color:#111}pre{background:#fff;border-radius:0.5rem;padding:1rem;overflow:auto;border:1px solid #e5e5e5}</style></head><body><h1>Auto Code Review Viewer</h1><p>${message}</p><pre>${details}</pre></body></html>`);
  }
});

app.get('/api/assessments/bad', async (req, res) => {
  const requestId = createRequestId();
  logger.logInfo('Received request for bad assessments', {
    requestId,
    path: req.path,
    method: req.method
  });
  try {
    const [markdown, stats] = await Promise.all([
      readMarkdownFile(),
      fs.promises.stat(targetPath).catch(() => null)
    ]);
    const assessments = parseBadAssessments(markdown);

    logger.logInfo('Returning bad assessments', {
      requestId,
      count: assessments.length,
      updatedAt: stats ? stats.mtimeMs : null
    });

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
    logger.logError('Failed to load bad assessments', {
      requestId,
      error
    });
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
  const requestId = createRequestId();
  logger.logInfo('Received apply request', {
    requestId,
    method: req.method,
    path: req.path,
    id
  });
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid assessment identifier.' });
    logger.logWarn('Rejecting apply request due to invalid identifier', {
      requestId,
      providedId: req.params.id
    });
    return;
  }

  try {
    const markdown = await readMarkdownFile();
    const assessments = parseBadAssessments(markdown);
    const assessment = assessments.find((item) => item.id === id);

    if (!assessment) {
      res.status(404).json({ error: 'Assessment not found.' });
      logger.logWarn('Apply request referenced missing assessment', {
        requestId,
        id
      });
      return;
    }

    const overrideDiff = typeof req.body?.diff === 'string' ? req.body.diff : '';
    const diffToApply = overrideDiff.trim() ? overrideDiff : assessment.suggestion.diff;

    if (!diffToApply) {
      res.status(400).json({ error: 'This assessment does not include a diff suggestion to apply.' });
      logger.logWarn('Apply request missing diff suggestion', {
        requestId,
        id
      });
      return;
    }

    const diffPreview = diffToApply.length > 2000
      ? `${diffToApply.slice(0, 2000)}…`
      : diffToApply;
    logger.logDebug('Preparing to apply suggestion diff', {
      requestId,
      id,
      repoDir: REPO_DIR,
      diffLength: diffToApply.length,
      diffPreview
    });

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
    logger.logInfo('Applied suggestion successfully', {
      requestId,
      id,
      file: assessment.file,
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
    logger.logError('Failed to apply suggestion', {
      requestId,
      id,
      status,
      error,
      stdout: error.stdout,
      stderr: error.stderr
    });
  }
});

app.post('/api/logs', (req, res) => {
  const requestId = createRequestId();
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const eventType = typeof payload.eventType === 'string' ? payload.eventType : 'client_event';

  logger.logInfo('Received client interaction log', {
    requestId,
    eventType,
    viewerMode: typeof payload.viewerMode === 'string' ? payload.viewerMode : undefined,
    timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : undefined,
    index: typeof payload.index === 'number' ? payload.index : undefined,
    total: typeof payload.total === 'number' ? payload.total : undefined,
    detail: payload.detail
  });

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(204).end();
});

app.get('/mtime', async (req, res) => {
  const requestId = createRequestId();
  logger.logDebug('Received mtime request', {
    requestId,
    method: req.method,
    path: req.path
  });
  try {
    const stats = await fs.promises.stat(targetPath);
    logger.logInfo('Resolved mtime', {
      requestId,
      mtimeMs: stats.mtimeMs,
      iso: stats.mtime.toISOString()
    });
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.json({
      file: FILENAME,
      mtimeMs: stats.mtimeMs,
      iso: stats.mtime.toISOString()
    });
  } catch (error) {
    logger.logError('Failed to resolve mtime', {
      requestId,
      error
    });
    const status = error.code === 'ENOENT' ? 404 : 500;
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.status(status).json({
      error: error.message,
      file: FILENAME
    });
  }
});

app.get('/healthz', (req, res) => {
  logger.logDebug('Health check request received', {
    method: req.method,
    path: req.path,
    ip: req.ip
  });
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.json({ status: 'ok' });
});

function ensureSourceDirectory() {
  return fs.promises.access(targetPath, fs.constants.R_OK)
    .then(() => {
      logger.logInfo('Verified markdown source is accessible', { targetPath });
    })
    .catch((error) => {
      const message = error.code === 'ENOENT'
        ? `Markdown file not found at ${targetPath}`
        : `Cannot read markdown file at ${targetPath}: ${error.message}`;
      logger.logError('Failed to verify markdown source', {
        targetPath,
        error,
        message
      });
    });
}

async function start() {
  await ensureSourceDirectory();

  logger.logInfo('Starting Auto Code Review Viewer server', {
    port: PORT,
    reviewFile: targetPath,
    repoDirectory: REPO_DIR
  });

  app.listen(PORT, () => {
    logger.logInfo('Auto Code Review Viewer listening', {
      port: PORT,
      reviewFile: targetPath,
      repoDirectory: REPO_DIR
    });
  });
}

start();
