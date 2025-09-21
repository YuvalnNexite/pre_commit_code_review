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

const DEFAULT_SRC_DIR = path.resolve(process.env.SRC_DIR || '/data');
const FILENAME = process.env.FILENAME || 'auto_code_review.md';
const PORT = Number(process.env.PORT || 3000);

const templatePath = path.join(__dirname, 'templates', 'index.html');
const REPO_DIR = process.env.REPO_DIR ? path.resolve(process.env.REPO_DIR) : DEFAULT_SRC_DIR;
const DEFAULT_TARGET_PATH = path.resolve(DEFAULT_SRC_DIR, FILENAME);

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true
});

let cachedTemplate = null;

function escapeHtmlAttribute(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DEFAULT_ROOT_ATTR = escapeHtmlAttribute(DEFAULT_SRC_DIR);

function sanitizeRootInput(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveRootDirectory(rawRoot) {
  const sanitized = sanitizeRootInput(rawRoot);
  if (!sanitized) {
    return DEFAULT_SRC_DIR;
  }
  return path.resolve(DEFAULT_SRC_DIR, sanitized);
}

function resolveReviewPath(rootDir) {
  return path.resolve(rootDir, FILENAME);
}

function getPathsForRequest(req) {
  const rawRoot = Array.isArray(req.query?.root) ? req.query.root[0] : req.query?.root;
  const rootDir = resolveRootDirectory(rawRoot);
  const reviewPath = resolveReviewPath(rootDir);
  return { rootDir, reviewPath };
}

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

async function readMarkdownFile(reviewPath) {
  logger.logDebug('Reading markdown review file', { reviewPath });
  const content = await fs.promises.readFile(reviewPath, 'utf8');
  logger.logDebug('Finished reading markdown review file', {
    reviewPath,
    bytes: content.length
  });
  return content;
}

function createTemplateContext({ rootDir, reviewPath }) {
  const safeRootDir = typeof rootDir === 'string' ? rootDir : '';
  const safeReviewPath = typeof reviewPath === 'string' ? reviewPath : '';
  return {
    fileName: FILENAME,
    reviewPath: safeReviewPath,
    rootDir: safeRootDir,
    rootDirAttr: escapeHtmlAttribute(safeRootDir),
    defaultRootDir: DEFAULT_SRC_DIR,
    defaultRootDirAttr: DEFAULT_ROOT_ATTR
  };
}

function injectTemplate(template, renderedMarkdown, context) {
  return template
    .replace(/\{\{FILE_NAME\}\}/g, context.fileName)
    .replace(/\{\{FILE_PATH\}\}/g, context.reviewPath)
    .replace(/\{\{ROOT_PATH\}\}/g, context.rootDir)
    .replace(/\{\{ROOT_PATH_ATTR\}\}/g, context.rootDirAttr)
    .replace(/\{\{DEFAULT_ROOT_PATH\}\}/g, context.defaultRootDir)
    .replace(/\{\{DEFAULT_ROOT_PATH_ATTR\}\}/g, context.defaultRootDirAttr)
    .replace(/\{\{CONTENT\}\}/g, renderedMarkdown);
}

async function renderErrorPage(res, context, { status, message, details }) {
  const instructions = 'Use the root directory form above to select a different location and reload the review.';
  const lines = [
    `> **${message}**`
  ];

  if (context.reviewPath) {
    lines.push('', `- Looked for: \`${context.reviewPath}\`.`);
  }

  lines.push('', instructions);

  const trimmedDetails = typeof details === 'string' ? details.trim() : '';
  if (trimmedDetails) {
    lines.push('', '```', trimmedDetails, '```');
  }

  const fallbackMarkdown = lines.join('\n');

  try {
    const template = await loadTemplate();
    const rendered = md.render(fallbackMarkdown);
    const html = injectTemplate(template, rendered, context);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.status(status).send(html);
  } catch (templateError) {
    logger.logError('Failed to render error template', {
      error: templateError,
      status,
      message,
      reviewPath: context.reviewPath
    });

    const safeMessage = escapeHtml(message);
    const safeDetails = escapeHtml(trimmedDetails || templateError.message || '');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.status(status).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Error</title><style>body{font-family:system-ui,sans-serif;padding:2rem;background:#f8f8f8;color:#111}pre{background:#fff;border-radius:0.5rem;padding:1rem;overflow:auto;border:1px solid #e5e5e5}</style></head><body><h1>Auto Code Review Viewer</h1><p>${safeMessage}</p><pre>${safeDetails}</pre></body></html>`);
  }
}

app.get('/', async (req, res) => {
  const requestId = createRequestId();
  const { rootDir, reviewPath } = getPathsForRequest(req);
  logger.logInfo('Received request for index page', {
    requestId,
    path: req.path,
    method: req.method,
    ip: req.ip,
    rootDir
  });
  try {
    const [template, markdown] = await Promise.all([
      loadTemplate(),
      readMarkdownFile(reviewPath)
    ]);
    const rendered = md.render(markdown);
    const context = createTemplateContext({ rootDir, reviewPath });
    const html = injectTemplate(template, rendered, context);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.send(html);
    logger.logInfo('Served index page successfully', { requestId, rootDir, reviewPath });
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : 500;
    const message = error.code === 'ENOENT'
      ? `Could not find markdown file at ${reviewPath}`
      : 'Failed to render markdown file.';
    const details = error.message || 'Unknown error';
    logger.logError('Failed to serve index page', {
      requestId,
      error,
      message,
      rootDir,
      reviewPath
    });
    const context = createTemplateContext({ rootDir, reviewPath });
    await renderErrorPage(res, context, { status, message, details });
  }
});

app.get('/api/assessments/bad', async (req, res) => {
  const requestId = createRequestId();
  const { rootDir, reviewPath } = getPathsForRequest(req);
  logger.logInfo('Received request for bad assessments', {
    requestId,
    path: req.path,
    method: req.method,
    rootDir
  });
  try {
    const [markdown, stats] = await Promise.all([
      readMarkdownFile(reviewPath),
      fs.promises.stat(reviewPath).catch(() => null)
    ]);
    const assessments = parseBadAssessments(markdown);

    logger.logInfo('Returning bad assessments', {
      requestId,
      count: assessments.length,
      updatedAt: stats ? stats.mtimeMs : null,
      rootDir,
      reviewPath
    });

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.json({
      file: FILENAME,
      rootDirectory: rootDir,
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
      error,
      rootDir,
      reviewPath
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
  const { rootDir, reviewPath } = getPathsForRequest(req);
  logger.logInfo('Received apply request', {
    requestId,
    method: req.method,
    path: req.path,
    id,
    rootDir
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
    const markdown = await readMarkdownFile(reviewPath);
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
      rootDir,
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
      rootDir,
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
      stderr: error.stderr,
      rootDir,
      reviewPath
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
  const { rootDir, reviewPath } = getPathsForRequest(req);
  logger.logDebug('Received mtime request', {
    requestId,
    method: req.method,
    path: req.path,
    rootDir
  });
  try {
    const stats = await fs.promises.stat(reviewPath);
    logger.logInfo('Resolved mtime', {
      requestId,
      mtimeMs: stats.mtimeMs,
      iso: stats.mtime.toISOString(),
      rootDir,
      reviewPath
    });
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.json({
      file: FILENAME,
      rootDirectory: rootDir,
      mtimeMs: stats.mtimeMs,
      iso: stats.mtime.toISOString()
    });
  } catch (error) {
    logger.logError('Failed to resolve mtime', {
      requestId,
      error,
      rootDir,
      reviewPath
    });
    const status = error.code === 'ENOENT' ? 404 : 500;
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.status(status).json({
      error: error.message,
      file: FILENAME,
      rootDirectory: rootDir
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
  return fs.promises.access(DEFAULT_TARGET_PATH, fs.constants.R_OK)
    .then(() => {
      logger.logInfo('Verified markdown source is accessible', {
        reviewPath: DEFAULT_TARGET_PATH,
        rootDir: DEFAULT_SRC_DIR
      });
    })
    .catch((error) => {
      const message = error.code === 'ENOENT'
        ? `Markdown file not found at ${DEFAULT_TARGET_PATH}`
        : `Cannot read markdown file at ${DEFAULT_TARGET_PATH}: ${error.message}`;
      logger.logError('Failed to verify markdown source', {
        reviewPath: DEFAULT_TARGET_PATH,
        rootDir: DEFAULT_SRC_DIR,
        error,
        message
      });
    });
}

async function start() {
  await ensureSourceDirectory();

  logger.logInfo('Starting Auto Code Review Viewer server', {
    port: PORT,
    reviewFile: DEFAULT_TARGET_PATH,
    repoDirectory: REPO_DIR
  });

  app.listen(PORT, () => {
    logger.logInfo('Auto Code Review Viewer listening', {
      port: PORT,
      reviewFile: DEFAULT_TARGET_PATH,
      repoDirectory: REPO_DIR
    });
  });
}

start();
