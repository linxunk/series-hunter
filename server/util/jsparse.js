'use strict';

/**
 * 提取页面中「元素包含指定 key 的 JSON 数组」。
 * 视频站的剧集列表通常以 [{...},{...}] 形式内联，这种结构可以一次性解析出来。
 */
function extractJsonArrays(text, key, limit = 10) {
  const out = [];
  const re = /\[\s*\{/g;
  let m;
  while ((m = re.exec(text)) && out.length < limit) {
    const raw = sliceBalanced(text, m.index, '[', ']');
    if (!raw || raw.length > 4000000) continue;
    if (!raw.includes(`"${key}"`)) continue;
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) out.push(arr);
    } catch {
      /* 不是合法 JSON 就跳过 */
    }
  }
  return out;
}

/**
 * 从一段 HTML / JS 文本中提取「包含指定 key 的 JSON 对象」。
 * 页面常把数据以 `window.xxx = [...]` 或 `{...}` 的形式内联，
 * 这里通过一次线性括号配平扫描拿到所有候选块，再逐个 JSON.parse。
 */
function extractJsonObjects(text, key, limit = 500) {
  const results = [];
  const seen = new WeakSet();

  const push = (val) => {
    if (Array.isArray(val)) {
      for (const item of val) push(item);
      return;
    }
    if (!val || typeof val !== 'object') return;
    if (seen.has(val)) return;
    seen.add(val);
    if (key in val && results.length < limit) results.push(val);
  };

  // 1) 优先尝试整体数组
  for (const arr of extractJsonArrays(text, key)) {
    for (const item of arr) push(item);
  }
  if (results.length) return results;

  // 2) 回退：线性括号配平扫描
  const stack = [];
  let inStr = false;
  let quote = '';
  let esc = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === '{') {
      stack.push(i);
      continue;
    }
    if (ch === '}') {
      const start = stack.pop();
      if (start === undefined) continue;
      const block = text.slice(start, i + 1);
      if (block.length > 400000) continue;
      if (!block.includes(`"${key}"`)) continue;
      try {
        push(JSON.parse(block));
      } catch {
        /* 不是合法 JSON 就跳过 */
      }
    }
  }
  return results;
}

/** 向前找到可能的对象起点（忽略字符串内的括号） */
function findObjectStart(text, from) {
  let i = from;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '{') return i;
    if (ch === '}' || ch === ']' || ch === ';') return -1; // 明显越界
    i -= 1;
    if (from - i > 4000) return -1;
  }
  return -1;
}

/** 从 start 处按括号配平截取完整片段 */
function sliceBalanced(text, start, open, close) {
  let depth = 0;
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 容错的 JS 对象字面量解析器（支持无引号 key / 单引号 / 尾逗号），
 * 用于解析 Nuxt / QUA 这类压缩后的 window.__NUXT__ 状态。
 */
function parseJsObject(text) {
  let i = 0;
  const n = text.length;

  function skipWs() {
    while (i < n && /[\s;]/.test(text[i])) i += 1;
  }
  function parseValue() {
    skipWs();
    const ch = text[i];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"' || ch === "'") return parseString();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber();
    return parseKeyword();
  }
  function parseString() {
    const quote = text[i];
    i += 1;
    let out = '';
    while (i < n) {
      const ch = text[i];
      if (ch === '\\') {
        const nx = text[i + 1];
        const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
        if (nx === 'u') {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        out += map[nx] ?? nx;
        i += 2;
        continue;
      }
      if (ch === quote) {
        i += 1;
        return out;
      }
      out += ch;
      i += 1;
    }
    return out;
  }
  function parseNumber() {
    const start = i;
    while (i < n && /[-+0-9.eE]/.test(text[i])) i += 1;
    return Number(text.slice(start, i));
  }
  function parseKeyword() {
    const start = i;
    while (i < n && /[A-Za-z_$]/.test(text[i])) i += 1;
    const word = text.slice(start, i);
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null' || word === 'undefined') return null;
    return word;
  }
  function parseKey() {
    skipWs();
    const ch = text[i];
    if (ch === '"' || ch === "'") return parseString();
    const start = i;
    while (i < n && /[A-Za-z0-9_$]/.test(text[i])) i += 1;
    return text.slice(start, i);
  }
  function parseObject() {
    i += 1; // {
    const obj = {};
    for (;;) {
      skipWs();
      if (text[i] === '}') {
        i += 1;
        return obj;
      }
      if (i >= n) return obj;
      const key = parseKey();
      skipWs();
      if (text[i] === ':') {
        i += 1;
        obj[key] = parseValue();
      } else {
        obj[key] = null;
      }
      skipWs();
      if (text[i] === ',') i += 1;
    }
  }
  function parseArray() {
    i += 1; // [
    const arr = [];
    for (;;) {
      skipWs();
      if (text[i] === ']') {
        i += 1;
        return arr;
      }
      if (i >= n) return arr;
      arr.push(parseValue());
      skipWs();
      if (text[i] === ',') i += 1;
    }
  }

  const value = parseValue();
  return value;
}

/** 从文本中截取 `window.<name> = <expr>` 的表达式部分 */
function sliceAssignment(text, name) {
  const re = new RegExp(`(?:window\\.|globalThis\\.)?${name}\\s*=\\s*`);
  const m = re.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const ch = text[start];
  if (ch === '(') {
    const end = matchParen(text, start);
    return end === -1 ? null : text.slice(start, end + 1);
  }
  if (ch === '{' || ch === '[') {
    const raw = sliceBalanced(text, start, ch, ch === '{' ? '}' : ']');
    return raw;
  }
  const m2 = /^[\w.$]+/.exec(text.slice(start));
  return m2 ? m2[0] : null;
}

function matchParen(text, start) {
  let depth = 0;
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 提取页面里 window.NAME = {...} 的内容并解析 */
function extractWindowState(html, name) {
  const expr = sliceAssignment(html, name);
  if (!expr) return null;
  const trimmed = expr.trim();
  if (trimmed.startsWith('(')) {
    // Nuxt 2: window.__NUXT__ = (function(a,b,c){return {...}}(1,2,3))
    try {
      const fn = new Function(`return ${trimmed}`);
      return fn();
    } catch (e) {
      /* 退化为容错解析 */
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      return parseJsObject(trimmed);
    } catch {
      return null;
    }
  }
}

module.exports = {
  extractJsonObjects,
  extractJsonArrays,
  extractWindowState,
  parseJsObject,
  sliceBalanced,
  sliceAssignment,
};
