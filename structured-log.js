const fs = require('node:fs');
const path = require('node:path');
const { redactSensitive } = require('./auth-session');

const BLOCKED_KEYS = /transcript|ocr(?:Text)?|prompt|cookie|authorization|password|token/i;

function sanitize(value, key = '') {
  if (BLOCKED_KEYS.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
  return typeof value === 'string' ? redactSensitive(value).slice(0, 1000) : value;
}

class StructuredLogger {
  constructor({ filePath, maxBytes = 5 * 1024 * 1024, fileSystem = fs, now = () => new Date().toISOString() } = {}) {
    this.filePath = filePath; this.maxBytes = maxBytes; this.fs = fileSystem; this.now = now;
  }
  write(record) {
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (this.fs.existsSync(this.filePath) && this.fs.statSync(this.filePath).size >= this.maxBytes) {
      const previous = `${this.filePath}.1`;
      this.fs.rmSync(previous, { force: true }); this.fs.renameSync(this.filePath, previous);
    }
    this.fs.appendFileSync(this.filePath, `${JSON.stringify({ timestamp: this.now(), ...sanitize(record) })}\n`, 'utf8');
  }
}

module.exports = { StructuredLogger, sanitize };
