const { spawn } = require('child_process');

const logger = require('./logger');

function normalizeNewlines(value) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n') : '';
}

function mapFieldLabel(label) {
  if (typeof label !== 'string') {
    return null;
  }
  const normalized = label
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .trim();

  if (normalized.startsWith('title')) return 'title';
  if (normalized.startsWith('file')) return 'file';
  if (normalized.startsWith('function')) return 'function';
  if (normalized.startsWith('lines')) return 'lines';
  if (normalized.startsWith('details')) return 'details';
  if (normalized.startsWith('suggestion')) return 'suggestion';
  if (normalized.startsWith('reasoning')) return 'reasoning';
  return null;
}

function joinFieldLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return '';
  }
  return normalizeNewlines(lines.join('\n')).trim();
}

function extractSuggestionParts(text) {
  const normalized = normalizeNewlines(text);
  if (!normalized) {
    return { text: '', diff: null };
  }

  const fenceRegex = /```(?:diff)?\s*([\s\S]*?)```/i;
  const match = fenceRegex.exec(normalized);
  if (!match) {
    return { text: normalized.trim(), diff: null };
  }

  const diffBody = match[1] ? match[1] : '';
  const before = normalized.slice(0, match.index).trim();
  const after = normalized.slice(match.index + match[0].length).trim();
  const summaryParts = [];
  if (before) summaryParts.push(before);
  if (after) summaryParts.push(after);

  return {
    text: summaryParts.join('\n\n'),
    diff: normalizeNewlines(diffBody)
  };
}

function parseBadAssessments(markdown) {
  logger.logDebug('parseBadAssessments invoked', {
    hasMarkdown: typeof markdown === 'string',
    length: typeof markdown === 'string' ? markdown.length : 0
  });
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    logger.logInfo('parseBadAssessments received empty markdown');
    return [];
  }

  const normalized = normalizeNewlines(markdown);
  const lines = normalized.split('\n');
  const allAssessments = [];

  let current = null;
  let currentField = null;
  let insideFence = false;

  const assessmentHeaderRegex = /^###\s+Assessment of the change:\s*(BAD|GOOD|NEUTRAL)\s*$/i;
  const fieldRegex = /^\*\*\s*([^*]+?)\s*:\*\*\s*(.*)$/;

  const finalizeCurrent = () => {
    if (!current) {
      return;
    }
    const snapshot = {
      verdict: current.verdict,
      position: current.position,
      fields: current.fields
    };
    allAssessments.push(snapshot);
    current = null;
    currentField = null;
    insideFence = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const headerMatch = !insideFence && assessmentHeaderRegex.exec(trimmed);
    if (headerMatch) {
      finalizeCurrent();
      current = {
        verdict: headerMatch[1].toUpperCase(),
        position: allAssessments.length + 1,
        fields: {}
      };
      currentField = null;
      continue;
    }

    if (!current) {
      continue;
    }

    if (!insideFence && trimmed === '---') {
      finalizeCurrent();
      continue;
    }

    const fieldMatch = !insideFence && fieldRegex.exec(line);
    if (fieldMatch) {
      const label = mapFieldLabel(fieldMatch[1]);
      const initialValue = fieldMatch[2] ? fieldMatch[2].trim() : '';
      currentField = label;
      if (label) {
        current.fields[label] = initialValue ? [initialValue] : [];
      }
      continue;
    }

    if (!currentField) {
      continue;
    }

    const fenceCandidate = line.trim();
    if (fenceCandidate.startsWith('```')) {
      insideFence = !insideFence;
    }

    current.fields[currentField].push(line);
  }

  finalizeCurrent();

  const badAssessments = [];

  for (const assessment of allAssessments) {
    if (assessment.verdict !== 'BAD') {
      continue;
    }

    const title = joinFieldLines(assessment.fields.title);
    const file = joinFieldLines(assessment.fields.file);
    const fn = joinFieldLines(assessment.fields.function);
    const linesChanged = joinFieldLines(assessment.fields.lines);
    const details = joinFieldLines(assessment.fields.details);
    const reasoning = joinFieldLines(assessment.fields.reasoning);
    const suggestionRaw = joinFieldLines(assessment.fields.suggestion);
    const suggestionParts = extractSuggestionParts(suggestionRaw);

    const parsedAssessment = {
      id: badAssessments.length + 1,
      position: assessment.position,
      verdict: 'BAD',
      title,
      file,
      function: fn,
      lines: linesChanged,
      details,
      reasoning,
      suggestion: {
        text: suggestionParts.text,
        diff: suggestionParts.diff
      }
    };

    badAssessments.push(parsedAssessment);

    logger.logDebug('Parsed BAD assessment', {
      id: parsedAssessment.id,
      position: parsedAssessment.position,
      title: parsedAssessment.title,
      file: parsedAssessment.file,
      hasDiff: Boolean(parsedAssessment.suggestion?.diff)
    });
  }

  logger.logInfo('parseBadAssessments completed', {
    totalAssessments: allAssessments.length,
    badAssessments: badAssessments.length
  });

  return badAssessments;
}

function ensureTrailingNewline(text) {
  if (text.endsWith('\n')) {
    return text;
  }
  return `${text}\n`;
}

function runGitCommand(args, cwd, diffText) {
  return new Promise((resolve, reject) => {
    logger.logInfo('Running git command', {
      args,
      cwd,
      diffBytes: typeof diffText === 'string' ? Buffer.byteLength(diffText) : 0
    });
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      logger.logError('Failed to start git command', {
        args,
        cwd,
        error
      });
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        logger.logInfo('git command completed successfully', {
          args,
          cwd,
          exitCode: code,
          stdout,
          stderr
        });
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`git ${args.join(' ')} failed with exit code ${code}`);
        error.exitCode = code;
        error.stdout = stdout;
        error.stderr = stderr;
        logger.logError('git command failed', {
          args,
          cwd,
          exitCode: code,
          stdout,
          stderr
        });
        reject(error);
      }
    });

    if (typeof diffText === 'string') {
      child.stdin.write(diffText);
    }
    child.stdin.end();
  });
}

async function applySuggestionDiff(diffText, repoDir) {
  if (typeof diffText !== 'string' || diffText.trim() === '') {
    logger.logWarn('applySuggestionDiff received empty diff', {
      repoDir
    });
    throw new Error('Suggestion diff is empty.');
  }
  if (typeof repoDir !== 'string' || repoDir.trim() === '') {
    logger.logWarn('applySuggestionDiff missing repository directory');
    throw new Error('Repository directory is required.');
  }

  const normalizedDiff = ensureTrailingNewline(normalizeNewlines(diffText));
  logger.logInfo('applySuggestionDiff begin', {
    repoDir,
    diffLength: normalizedDiff.length
  });

  try {
    await runGitCommand(['apply', '--check', '--whitespace=nowarn'], repoDir, normalizedDiff);
    const result = await runGitCommand(['apply', '--whitespace=nowarn'], repoDir, normalizedDiff);
    logger.logInfo('applySuggestionDiff succeeded', {
      repoDir,
      diffLength: normalizedDiff.length,
      stdout: result.stdout,
      stderr: result.stderr
    });
    return result;
  } catch (error) {
    logger.logError('applySuggestionDiff failed', {
      repoDir,
      error
    });
    throw error;
  }
}

module.exports = {
  parseBadAssessments,
  applySuggestionDiff
};

