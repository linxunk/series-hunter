'use strict';

const { siteSearch } = require('./searchlib');
const { episodeNo } = require('../util/episode');
const log = require('../util/log');

function cleanTitle(t) {
  return String(t || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function search(query, ctx) {
  const hits = await siteSearch(query, {
    domains: ['v.qq.com'],
    pattern: /\/x\/(cover|page)\//i,
    engine: ctx.config.fallbackSearchEngine,
  });
  const out = [];
  const seen = new Set();
  for (const hit of hits) {
    if (!/\/x\/(cover|page)\//i.test(hit.url)) continue;
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    out.push({
      title: cleanTitle(hit.title) || '腾讯视频剧集',
      url: hit.url,
      cover: '',
      year: '',
      note: '腾讯视频',
    });
    if (out.length >= 10) break;
  }
  return out;
}

async function getSeries(url, ctx) {
  const ytdlp = require('../core/ytdlp');
  const cookie = ctx.cookieFor('qq');
  const res = await ytdlp.listEntries(url, { cookie, referer: 'https://v.qq.com/' });
  if (!res.ok) throw new Error(res.error || '腾讯视频解析失败');

  const entries = res.entries;
  const episodes = entries.map((e, i) => ({
    no: episodeNo(e.title, Number(e.playlist_index || i + 1)),
    title: cleanTitle(e.title) || `第${i + 1}集`,
    url: e.url || e.webpage_url,
    vip: false,
    duration: e.duration || 0,
    cover: e.thumbnail || '',
  }));
  return {
    title: cleanTitle(res.title) || '腾讯视频剧集',
    cover: res.thumbnail || '',
    total: episodes.length,
    episodes,
  };
}

async function probe(episode, ctx) {
  const ytdlp = require('../core/ytdlp');
  const cookie = ctx.cookieFor('qq');
  const r = await ytdlp.probe(episode.url, { cookie, referer: 'https://v.qq.com/' });
  if (r.ok) return { ok: true, reason: '解析成功' };
  return { ok: false, reason: r.error || '需要会员或解析失败' };
}

module.exports = { id: 'qq', name: '腾讯视频', color: '#ff820e', domains: ['v.qq.com'], search, getSeries, probe };
