const fs = require('fs');
const path = require('path');

const LOG_FILE_PATH = path.join(__dirname, '..', 'new.log');
const MAX_STRING_LENGTH = 2000;
const LOG_TO_CONSOLE = process.env.LOG_TO_CONSOLE === 'true';

function truncateString(value) {
  if (typeof value !== 'string') {
    return value;
  }
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }
  const truncated = value.slice(0, MAX_STRING_LENGTH);
  const omitted = value.length - MAX_STRING_LENGTH;
  return `${truncated}\u2026 (truncated ${omitted} characters)`;
}

function sanitizeForLog(value, seen = new WeakSet()) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (Buffer.isBuffer(value)) {
    return `<Buffer length=${value.length}>`;
  }

  if (typeof value === 'string') {
    return truncateString(value);
  }

  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'undefined') {
    return undefined;
  }

  if (typeof value === 'symbol') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return value.name ? `[Function: ${value.name}]` : '[Function]';
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const result = value.map((item) => sanitizeForLog(item, seen));
    seen.delete(value);
    return result;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      const sanitized = sanitizeForLog(val, seen);
      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
    }
    seen.delete(value);
    return result;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return String(value);
  }
}

function writeLog(level, message, metadata) {
  const timestamp = new Date().toISOString();
  const textMessage = truncateString(
    typeof message === 'string' ? message : String(message)
  );
  const sanitizedMeta = sanitizeForLog(metadata);

  let line = `[${timestamp}] [${level}] ${textMessage}`;
  if (sanitizedMeta !== undefined && !(typeof sanitizedMeta === 'object' && Object.keys(sanitizedMeta).length === 0)) {
    const metaString = typeof sanitizedMeta === 'object'
      ? JSON.stringify(sanitizedMeta)
      : String(sanitizedMeta);
    line += ` ${metaString}`;
  }
  line += '\n';

  fs.promises.appendFile(LOG_FILE_PATH, line).catch((error) => {
    const consoleLine = `[${timestamp}] [ERROR] Failed to write log entry`;
    console.error(consoleLine, sanitizeForLog(error));
  });

  if (level === 'ERROR') {
    const consoleLine = `[${timestamp}] [${level}] ${textMessage}`;
    if (sanitizedMeta !== undefined) {
      console.error(consoleLine, sanitizedMeta);
    } else {
      console.error(consoleLine);
    }
  } else if (level === 'WARN') {
    const consoleLine = `[${timestamp}] [${level}] ${textMessage}`;
    if (sanitizedMeta !== undefined) {
      console.warn(consoleLine, sanitizedMeta);
    } else {
      console.warn(consoleLine);
    }
  } else if (LOG_TO_CONSOLE) {
    const consoleLine = `[${timestamp}] [${level}] ${textMessage}`;
    if (sanitizedMeta !== undefined) {
      console.log(consoleLine, sanitizedMeta);
    } else {
      console.log(consoleLine);
    }
  }
}

function logDebug(message, metadata) {
  writeLog('DEBUG', message, metadata);
}

function logInfo(message, metadata) {
  writeLog('INFO', message, metadata);
}

function logWarn(message, metadata) {
  writeLog('WARN', message, metadata);
}

function logError(message, metadata) {
  writeLog('ERROR', message, metadata);
}

module.exports = {
  logDebug,
  logInfo,
  logWarn,
  logError,
  logPath: LOG_FILE_PATH
};
