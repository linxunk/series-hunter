'use strict';

const { load } = require('../config');
const log = require('./log');

const DEFAULT_HEADERS = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
};

function headers(extra = {}) {
  const cfg = load();
  return {
    'User-Agent': cfg.userAgent,
    ...DEFAULT_HEADERS,
    ...extra,
  };
}

function decodeBody(buf, contentType) {
  const ct = (contentType || '').toLowerCase();
  let charset = 'utf-8';
  const m = ct.match(/charset=([\w-]+)/);
  if (m) charset = m[1];
  if (charset === 'gb2312' || charset === 'gbk') charset = 'gbk';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch (e) {
    return buf.toString('utf8');
  }
}

const CACHE_TTL = Number(process.env.HTTP_CACHE_TTL || 180000); // 3 分钟
const CACHE_MAX = 300;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
}

async function request(url, opts = {}) {
  const cfg = load();
  const timeout = opts.timeout ?? cfg.requestTimeoutMs;
  const method = opts.method || 'GET';
  const cacheKey = method === 'GET' ? `${url}|${JSON.stringify(opts.headers || {})}` : null;
  if (cacheKey && !opts.noCache) {
    const hit = cacheGet(cacheKey);
    if (hit) return hit;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: headers(opts.headers),
      body: opts.body,
      redirect: opts.redirect || 'follow',
      signal: controller.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText} @ ${url}`);
      err.status = res.status;
      err.body = buf.toString('utf8').slice(0, 400);
      throw err;
    }
    log.debug('http', `${res.status} ${Date.now() - started}ms ${url}`);
    const result = {
      status: res.status,
      url: res.url,
      headers: res.headers,
      buffer: buf,
      text: decodeBody(buf, res.headers.get('content-type')),
    };
    if (cacheKey) cacheSet(cacheKey, result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url, opts = {}) {
  const r = await request(url, opts);
  return r.text;
}

async function getJson(url, opts = {}) {
  const r = await request(url, opts);
  try {
    return JSON.parse(r.text);
  } catch (e) {
    const err = new Error(`响应不是合法 JSON: ${url} (${e.message})`);
    err.body = r.text.slice(0, 300);
    throw err;
  }
}

async function getBuffer(url, opts = {}) {
  const r = await request(url, opts);
  return r.buffer;
}

/** 带重试的请求 */
async function retry(fn, times = 2, delayMs = 700) {
  let lastErr;
  for (let i = 0; i <= times; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < times) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

module.exports = { request, getText, getJson, getBuffer, retry, headers };
