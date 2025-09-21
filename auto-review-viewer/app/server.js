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

const FILENAME = process.env.FILENAME || 'auto_code_review.md';
const PORT = Number(process.env.PORT || 3000);

let currentSourceDirectory = null;
let currentSourceDirectoryInput = '';
let targetPath = null;
const templatePath = path.join(__dirname, 'templates', 'index.html');
const rawRepoDirEnv = typeof process.env.REPO_DIR === 'string' ? process.env.REPO_DIR.trim() : '';
const rawSourceDirEnv = typeof process.env.SRC_DIR === 'string' ? process.env.SRC_DIR.trim() : '';
const repoDirCandidate = rawRepoDirEnv || rawSourceDirEnv;
const normalizedRepoDir = repoDirCandidate ? normalizeDirectorySeparators(repoDirCandidate) : '';
const REPO_DIR = normalizedRepoDir ? path.resolve(normalizedRepoDir) : process.cwd();

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true
});

let cachedTemplate = null;

function getReviewSource() {
  return {
    directory: currentSourceDirectoryInput,
    filename: FILENAME,
    path: targetPath
  };
}

function normalizeDirectorySeparators(value) {
  if (typeof value !== 'string') {
    return value;
  }
  if (path.sep === path.win32.sep) {
    return value.split('/').join(path.win32.sep);
  }
  return value.split(path.win32.sep).join('/');
}

function resolveSourceDirectory(input) {
  if (typeof input !== 'string') {
    return null;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeDirectorySeparators(trimmed);
  return path.resolve(normalized);
}

function updateSourceDirectory(nextDirectory, rawInput) {
  currentSourceDirectory = nextDirectory;
  if (typeof rawInput === 'string') {
    currentSourceDirectoryInput = rawInput;
  } else if (!nextDirectory) {
    currentSourceDirectoryInput = '';
  }
  targetPath = currentSourceDirectory ? path.resolve(currentSourceDirectory, FILENAME) : null;
  return getReviewSource();
}

const initialSourceDirectoryEnv = rawSourceDirEnv;
if (initialSourceDirectoryEnv) {
  const normalizedInitialSourceInput = normalizeDirectorySeparators(initialSourceDirectoryEnv);
  const resolvedInitialSourceDirectory = resolveSourceDirectory(initialSourceDirectoryEnv);
  const initializedSource = updateSourceDirectory(resolvedInitialSourceDirectory, normalizedInitialSourceInput);
  logger.logInfo('Initialized review source directory from environment', {
    configuredDirectory: initializedSource.directory,
    resolvedPath: initializedSource.path
  });
}

async function checkReviewFileExists() {
  if (!targetPath) {
    return false;
  }
  try {
    await fs.promises.access(targetPath, fs.constants.R_OK);
    return true;
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      logger.logWarn('Failed to access review file during existence check', {
        error,
        targetPath
      });
    }
    return false;
  }
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

async function readMarkdownFile() {
  const { path: reviewPath } = getReviewSource();
  if (!reviewPath) {
    const error = new Error('Review folder not configured.');
    error.code = 'ENOENT';
    throw error;
  }
  logger.logDebug('Reading markdown review file', { targetPath: reviewPath });
  const content = await fs.promises.readFile(reviewPath, 'utf8');
  logger.logDebug('Finished reading markdown review file', {
    targetPath: reviewPath,
    bytes: content.length
  });
  return content;
}

function injectTemplate(template, renderedMarkdown) {
  const { path: reviewPath, directory } = getReviewSource();
  const displayPath = directory || reviewPath || 'Not configured';
  return template
    .replace(/\{\{FILE_NAME\}\}/g, FILENAME)
    .replace(/\{\{FILE_PATH\}\}/g, displayPath)
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
    const templatePromise = loadTemplate();
    let markdown = '';
    let missingReviewFile = false;

    const { path: reviewPath } = getReviewSource();

    if (!reviewPath) {
      missingReviewFile = true;
      logger.logWarn('Review folder not configured while rendering index page', {
        requestId
      });
      markdown = `# Review folder not configured\n\n` +
        `No folder has been selected for \`${FILENAME}\` yet.\n\n` +
        'Open the settings menu and choose the folder that contains the review file.';
    } else {
      try {
        markdown = await readMarkdownFile();
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          missingReviewFile = true;
          logger.logWarn('Review markdown file not found while rendering index page', {
            requestId,
            reviewPath
          });
          markdown = `# Review file not found\n\n` +
            `The selected folder does not contain \`${FILENAME}\`.\n\n` +
            `**Current location:** \`${reviewPath}\`\n\n` +
            'You can update the folder path from the settings menu.';
        } else {
          throw error;
        }
      }
    }

    const template = await templatePromise;
    const rendered = md.render(markdown);
    const html = injectTemplate(template, rendered);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.send(html);
    logger.logInfo('Served index page successfully', {
      requestId,
      missingReviewFile,
      reviewPath
    });
  } catch (error) {
    const missingMessage = targetPath
      ? `Could not find markdown file at ${targetPath}`
      : 'Review folder not configured.';
    const message = error.code === 'ENOENT'
      ? missingMessage
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
    const reviewPath = targetPath;
    const statsPromise = reviewPath
      ? fs.promises.stat(reviewPath).catch(() => null)
      : Promise.resolve(null);
    const [markdown, stats] = await Promise.all([
      readMarkdownFile(),
      statsPromise
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
    const responseMessage = status === 404
      ? error.message || 'Review file not found.'
      : 'Failed to parse review file.';
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.status(status).json({
      error: responseMessage,
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
    const responseMessage = status === 404 ? (error.message || 'Review file not found.') : error.message;
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.status(status).json({
      success: false,
      error: responseMessage,
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

app.get('/api/review-source', async (req, res) => {
  const requestId = createRequestId();
  logger.logInfo('Received request for review source information', {
    requestId,
    method: req.method,
    path: req.path
  });

  const exists = await checkReviewFileExists();
  const source = getReviewSource();

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.json({
    ...source,
    exists
  });
});

app.post('/api/review-source', async (req, res) => {
  const requestId = createRequestId();
  const rawDirectory = typeof req.body?.directory === 'string' ? req.body.directory : '';
  const trimmedDirectory = rawDirectory.trim();
  const normalizedInput = trimmedDirectory ? normalizeDirectorySeparators(trimmedDirectory) : '';
  const resolvedDirectory = resolveSourceDirectory(rawDirectory);
  const previous = getReviewSource();

  logger.logInfo('Received request to update review source directory', {
    requestId,
    previousDirectory: previous.directory,
    requestedDirectory: rawDirectory,
    normalizedDirectory: normalizedInput,
    resolvedDirectory
  });

  const updated = updateSourceDirectory(resolvedDirectory, normalizedInput);
  const exists = await checkReviewFileExists();

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.json({
    ...updated,
    exists
  });
});

app.get('/mtime', async (req, res) => {
  const requestId = createRequestId();
  logger.logDebug('Received mtime request', {
    requestId,
    method: req.method,
    path: req.path
  });
  try {
    if (!targetPath) {
      logger.logWarn('Mtime requested without configured review folder', {
        requestId
      });
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.status(404).json({
        error: 'Review folder not configured.',
        file: FILENAME
      });
      return;
    }
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
  const { path: reviewPath } = getReviewSource();
  if (!reviewPath) {
    logger.logInfo('Skipping markdown source verification: no folder configured yet.');
    return Promise.resolve();
  }
  return fs.promises.access(reviewPath, fs.constants.R_OK)
    .then(() => {
      logger.logInfo('Verified markdown source is accessible', { targetPath: reviewPath });
    })
    .catch((error) => {
      const message = error.code === 'ENOENT'
        ? `Markdown file not found at ${reviewPath}`
        : `Cannot read markdown file at ${reviewPath}: ${error.message}`;
      logger.logError('Failed to verify markdown source', {
        targetPath: reviewPath,
        error,
        message
      });
    });
}

async function start() {
  await ensureSourceDirectory();

  const { path: reviewPath } = getReviewSource();
  logger.logInfo('Starting Auto Code Review Viewer server', {
    port: PORT,
    reviewFile: reviewPath,
    reviewFolderConfigured: Boolean(reviewPath),
    repoDirectory: REPO_DIR
  });

  app.listen(PORT, () => {
    const { path: listenReviewPath } = getReviewSource();
    logger.logInfo('Auto Code Review Viewer listening', {
      port: PORT,
      reviewFile: listenReviewPath,
      reviewFolderConfigured: Boolean(listenReviewPath),
      repoDirectory: REPO_DIR
    });
  });
}

start();
