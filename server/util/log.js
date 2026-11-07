'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function emit(level, tag, msg, extra) {
  if (LEVELS[level] < current) return;
  const line = `${ts()} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra !== undefined) out(line, extra);
  else out(line);
}

module.exports = {
  debug: (tag, msg, extra) => emit('debug', tag, msg, extra),
  info: (tag, msg, extra) => emit('info', tag, msg, extra),
  warn: (tag, msg, extra) => emit('warn', tag, msg, extra),
  error: (tag, msg, extra) => emit('error', tag, msg, extra),
};
