'use strict';

const { getJson, getText } = require('../util/http');
const { sliceAssignment } = require('../util/jsparse');
const { siteSearch } = require('./searchlib');
const log = require('../util/log');

const EXTRA_RE = /(预告|花絮|片花|独家|抢先看|片段|直播|回顾|纪录片|访谈|解说|专访|纯享|Reaction)/i;

function cleanTitle(t) {
  return String(t || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function search(query, ctx) {
  const hits = await siteSearch(query, {
    domains: ['mgtv.com'],
    pattern: /\/(b\/\d+\/\d+|v\/\d+\/\d+\/\d+)\.html/i,
    engine: ctx.config.fallbackSearchEngine,
  });

  const out = [];
  const seen = new Set();
  for (const hit of hits) {
    const url = hit.url.replace(/^http:/, 'https:').replace(/^https?:\/\/m\.mgtv\.com/, 'https://www.mgtv.com');
    if (seen.has(url)) continue;
    seen.add(url);
    const title = cleanTitle(hit.title);
    // 相关性过滤：标题里没有剧名的多半是无关内容
    if (!relevant(title, query)) continue;
    seen.add(url);
    out.push({
      title: title || '芒果TV剧集',
      url,
      cover: '',
      year: '',
      note: '芒果TV',
    });
    if (out.length >= 8) break;
  }

  await Promise.all(
    out.slice(0, 4).map(async (item) => {
      try {
        const html = await getText(item.url, { headers: { Referer: 'https://www.mgtv.com/' }, timeout: 12000 });
        const t = cleanTitle((html.match(/<title>([^<]+)<\/title>/) || [])[1] || '');
        const cleaned = t.replace(/[-_|].*(芒果TV|mgtv).*$/i, '').trim();
        if (cleaned && relevant(cleaned, query)) item.title = cleaned;
      } catch {
        /* ignore */
      }
    }),
  );

  return out;
}

function relevant(title, query) {
  if (!title) return false;
  const t = title.toLowerCase();
  const q = String(query).toLowerCase().trim();
  if (!q) return true;
  if (t.includes(q)) return true;
  // 去掉「电视剧/综艺/高清/全集」等修饰后的包含判断
  const core = q.replace(/[第季部集全集高清在线观看电视剧电影综艺]/g, '').trim();
  return core.length >= 2 && t.includes(core);
}

async function getSeries(url, ctx) {
  const bMatch = url.match(/\/b\/(\d+)\/(\d+)\.html/i);
  const vMatch = url.match(/\/v\/(\d+)\/(\d+)\/(\d+)\.html/i);

  if (vMatch) {
    return {
      title: '芒果TV视频',
      cover: '',
      total: 1,
      episodes: [
        {
          no: 1,
          title: '正片',
          url: `https://www.mgtv.com/v/${vMatch[1]}/${vMatch[2]}/f/${vMatch[3]}.html`,
          vip: false,
          duration: 0,
          cover: '',
        },
      ],
    };
  }
  if (!bMatch) throw new Error('无法识别的芒果TV链接');

  const clipId = bMatch[1];
  const videoId = bMatch[2];
  const html = await getText(url, { headers: { Referer: 'https://www.mgtv.com/' }, timeout: 20000 }).catch(() => '');

  let title = '';
  let episodes = [];
  const state = html ? parseNuxt(html) : null;
  if (state) {
    const media = findMedia(state);
    if (media) {
      title = cleanTitle(media.info?.title || media.title || '');
      const feature = (media.filters || []).find((f) => f.contentType === 'feature') ||
        (media.filters || [])[0];
      if (feature && Array.isArray(feature.list) && feature.list.length) {
        episodes = feature.list
          .filter((it) => it && it.videoId && !EXTRA_RE.test(it.title || ''))
          .map((it, i) => ({
            no: Number(it.serialno || i + 1),
            title: cleanTitle(it.detailTitle?.title || it.title || ''),
            url: `https://www.mgtv.com/b/${it.clipId || clipId}/${it.videoId}.html`,
            vip: Number(it.vipMark || 0) > 0,
            duration: it.duration || 0,
            cover: it.hImgUrl || '',
            videoId: it.videoId,
          }));
      }
    }
  }

  if (!episodes.length) {
    episodes = await positivesFallback(clipId, videoId);
  }

  if (!title) {
    const t = cleanTitle((html.match(/<title>([^<]+)<\/title>/) || [])[1] || '');
    title = t.replace(/[-_|].*(芒果TV|mgtv).*$/i, '').trim();
  }

  episodes.sort((a, b) => a.no - b.no);
  episodes.forEach((e, i) => {
    if (!e.no) e.no = i + 1;
  });

  return {
    title: title || '芒果TV剧集',
    cover: episodes[0]?.cover || '',
    total: episodes.length,
    episodes,
  };
}

function parseNuxt(html) {
  try {
    const expr = sliceAssignment(html, '__NUXT__');
    if (!expr) return null;
    return new Function(`return ${expr}`)();
  } catch (e) {
    log.warn('mgtv', `页面状态解析失败: ${e.message}`);
    return null;
  }
}

function findMedia(state) {
  const d0 = state && state.data && state.data[0];
  if (!d0) return null;
  const aside = d0.asideData;
  if (aside && Array.isArray(aside.modules)) {
    for (const mod of aside.modules) {
      if (mod && mod.media && (mod.media.filters || mod.media.list)) return mod.media;
    }
  }
  if (d0.media) return d0.media;
  return null;
}

/** 兜底：使用芒果选集接口 */
async function positivesFallback(clipId, videoId) {
  const all = [];
  for (let page = 1; page <= 6; page += 1) {
    const api = `https://mobile.api.mgtv.com/vod/video/positives?clipId=${clipId}&videoId=${videoId}&t_userIsVip=unknown&pageSize=100&pageNum=${page}`;
    const r = await getJson(api, { headers: { Referer: 'https://www.mgtv.com/' } });
    if (r.code !== 0 || !r.data) break;
    const list = r.data.list || [];
    if (!list.length) break;
    all.push(...list);
    if (page >= (r.data.page?.pageTotal || 1)) break;
  }
  const tab = all.filter((i) => i.clipId === clipId);
  return tab
    .filter((it) => it && it.videoId && !EXTRA_RE.test(it.title || ''))
    .map((it, i) => ({
      no: Number(it.serialno || i + 1),
      title: cleanTitle(it.detailTitle?.title || it.title || ''),
      url: `https://www.mgtv.com/b/${it.clipId || clipId}/${it.videoId}.html`,
      vip: Number(it.vipMark || 0) > 0,
      duration: it.duration || 0,
      cover: it.hImgUrl || '',
      videoId: it.videoId,
    }));
}

async function probe(episode, ctx) {
  if (!episode.vip) return { ok: true, reason: '免费内容' };
  const ytdlp = require('../core/ytdlp');
  const cookie = ctx.cookieFor('mgtv');
  if (cookie) {
    const r = await ytdlp.probe(episode.url, { cookie, referer: 'https://www.mgtv.com/' });
    if (r.ok) return { ok: true, reason: '会员账号解析成功' };
  }
  return { ok: false, reason: '需要会员（可配置会员 Cookie 或第三方解析）' };
}

module.exports = { id: 'mgtv', name: '芒果TV', color: '#ff7f24', domains: ['www.mgtv.com'], search, getSeries, probe };
