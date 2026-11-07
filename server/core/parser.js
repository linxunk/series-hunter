'use strict';

const { getText } = require('../util/http');
const log = require('../util/log');

const M3U8_RE = /(https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*)/i;
const MP4_RE = /(https?:\/\/[^\s"'<>\\]+?\.(?:mp4|flv|mkv)[^\s"'<>\\]*)/i;

/**
 * 第三方解析服务：从配置的解析接口拿到视频直链。
 * 解析接口需返回 JSON（{"url": "..."} 之类）或包含 m3u8/mp4 直链的文本。
 */
async function resolveViaParsers(pageUrl, ctx) {
  const parsers = (ctx.config.parsers || []).filter((p) => p && p.enabled && p.url);
  if (!parsers.length) return null;

  for (const p of parsers) {
    const target = p.url
      .replace(/\{url\}/g, encodeURIComponent(pageUrl))
      .replace(/\{ref\}/g, encodeURIComponent(pageUrl));
    try {
      const text = await getText(target, {
        timeout: Math.min(ctx.config.requestTimeoutMs, 15000),
        headers: { Referer: pageUrl },
      });
      const direct = extractDirect(text);
      if (direct) {
        log.info('parser', `第三方解析成功: ${p.name} -> ${direct.slice(0, 60)}`);
        return { url: direct, from: p.name };
      }
      log.warn('parser', `第三方解析未返回直链: ${p.name}`);
    } catch (e) {
      log.warn('parser', `第三方解析失败: ${p.name} (${e.message})`);
    }
  }
  return null;
}

function extractDirect(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed);
      const found = findUrl(data);
      if (found) return found;
    } catch {
      /* ignore */
    }
  }
  const m = trimmed.match(M3U8_RE) || trimmed.match(MP4_RE);
  if (m) return m[1];
  return null;
}

function findUrl(node, depth = 0) {
  if (!node || depth > 4) return null;
  if (typeof node === 'string') {
    const m = node.match(M3U8_RE) || node.match(MP4_RE);
    if (m) return m[1];
    if (/^https?:\/\//i.test(node)) return node;
    return null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findUrl(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof node === 'object') {
    const preferred = ['url', 'm3u8', 'playUrl', 'play_url', 'videoUrl', 'src', 'data', 'urlList'];
    for (const key of preferred) {
      if (key in node) {
        const r = findUrl(node[key], depth + 1);
        if (r) return r;
      }
    }
    for (const key of Object.keys(node)) {
      const r = findUrl(node[key], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

module.exports = { resolveViaParsers, extractDirect };
