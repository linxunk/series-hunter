'use strict';

const { getText } = require('../util/http');
const { extractWindowState } = require('../util/jsparse');
const { episodeNo } = require('../util/episode');
const log = require('../util/log');

function cleanTitle(t) {
  return String(t || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function search(query, ctx) {
  const url = `https://search.youku.com/search_video?q=${encodeURIComponent(query)}`;
  const html = await getText(url, { headers: { 'User-Agent': DESKTOP_UA }, timeout: ctx.config.requestTimeoutMs });
  const state = extractWindowState(html, '__INITIAL_DATA__');
  const comps = (state && state.pageComponentList) || [];
  const out = [];
  const seen = new Set();

  for (const comp of comps) {
    const cd = comp.commonData || {};
    // 剧集卡片
    if (cd.showId && cd.titleDTO && cd.titleDTO.displayName) {
      const link = `https://www.youku.com/show/id_${cd.showId}.html`;
      if (!seen.has(link)) {
        seen.add(link);
        out.push({
          title: cleanTitle(cd.titleDTO.displayName),
          url: link,
          cover: (cd.posterDTO && cd.posterDTO.vThumbUrl) || '',
          year: '',
          note: `优酷 · 共${cd.episodeTotal || '?'}集`,
          total: cd.episodeTotal || 0,
        });
      }
    }
    // 用户上传的单集
    const map = comp.componentMap || {};
    for (const key of Object.keys(map)) {
      const list = (map[key] && map[key].data) || [];
      for (const d of list) {
        if (!d.videoId || !d.titleDTO || !d.titleDTO.displayName) continue;
        const link = `https://v.youku.com/v_show/id_${d.videoId}.html`;
        if (seen.has(link)) continue;
        seen.add(link);
        out.push({
          title: cleanTitle(d.titleDTO.displayName),
          url: link,
          cover: '',
          year: '',
          note: '优酷单集',
          total: 0,
        });
      }
    }
  }
  return out.slice(0, 12);
}

async function getSeries(url, ctx) {
  const showMatch = url.match(/\/show\/id_([\w-]+)\.html/i);
  const vidMatch = url.match(/\/v_show\/id_([\w=+/]+)/i);

  if (vidMatch) {
    return {
      title: '优酷单集',
      cover: '',
      total: 1,
      episodes: [
        {
          no: 1,
          title: '正片',
          url: `https://v.youku.com/v_show/id_${vidMatch[1]}.html`,
          vip: false,
          duration: 0,
          cover: '',
        },
      ],
    };
  }

  if (showMatch) {
    const showId = showMatch[1];
    const pageUrl = `https://www.youku.com/show/id_${showId}.html`;
    let html = '';
    try {
      html = await getText(pageUrl, { headers: { 'User-Agent': DESKTOP_UA, Referer: 'https://search.youku.com/' }, timeout: ctx.config.requestTimeoutMs });
    } catch (e) {
      log.warn('youku', `剧集页抓取失败: ${e.message}`);
    }
    const eps = parseEpisodesFromHtml(html, showId);
    if (eps.length) {
      return {
        title: await fetchSeriesTitle(html) || '优酷剧集',
        cover: '',
        total: eps.length,
        episodes: eps,
      };
    }
    // 剧集页拿不到分集时，退回 yt-dlp
    const ytdlp = require('../core/ytdlp');
    const res = await ytdlp.listEntries(pageUrl, { cookie: ctx.cookieFor('youku'), referer: 'https://www.youku.com/' });
    if (res.ok) {
      const episodes = res.entries.map((e, i) => ({
        no: episodeNo(e.title, i + 1),
        title: cleanTitle(e.title) || `第${i + 1}集`,
        url: e.url || e.webpage_url,
        vip: false,
        duration: e.duration || 0,
        cover: e.thumbnail || '',
      }));
      return {
        title: cleanTitle(res.title) || '优酷剧集',
        cover: res.thumbnail || '',
        total: episodes.length,
        episodes,
      };
    }
    throw new Error('优酷剧集页未返回分集列表（可能被风控拦截，换网络重试）');
  }

  throw new Error('无法识别的优酷链接');
}

/** 从优酷剧集页 HTML 里抽取 v_show 列表 */
function parseEpisodesFromHtml(html, showId) {
  if (!html) return [];
  const seen = new Set();
  const eps = [];
  const re = /v_show\/id_([\w=+/]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const vid = m[1];
    if (seen.has(vid)) continue;
    seen.add(vid);
    // 往前找标题
    const around = html.slice(Math.max(0, m.index - 400), m.index + 120);
    const t =
      (around.match(/"(?:title|displayName|name)"\s*:\s*"([^"]{2,60})"/) || [])[1] ||
      (around.match(/title="([^"]{2,60})"/) || [])[1] ||
      '';
    const title = cleanTitle(t);
    eps.push({
      no: episodeNo(title, eps.length + 1),
      title: title || `第${eps.length + 1}集`,
      url: `https://v.youku.com/v_show/id_${vid}.html`,
      vip: false,
      duration: 0,
      cover: '',
    });
  }
  return eps.sort((a, b) => a.no - b.no);
}

async function fetchSeriesTitle(html) {
  const state = extractWindowState(html, '__INITIAL_DATA__');
  const comps = (state && state.pageComponentList) || [];
  for (const c of comps) {
    const cd = c.commonData || {};
    if (cd.titleDTO && cd.titleDTO.displayName) return cleanTitle(cd.titleDTO.displayName);
  }
  const m = cleanTitle((html.match(/<title>([^<]+)<\/title>/) || [])[1] || '');
  return m.replace(/[-_|].*(优酷|youku).*$/i, '').trim();
}

async function probe(episode, ctx) {
  const ytdlp = require('../core/ytdlp');
  const cookie = ctx.cookieFor('youku');
  const r = await ytdlp.probe(episode.url, { cookie, referer: 'https://www.youku.com/' });
  if (r.ok) return { ok: true, reason: '解析成功' };
  return { ok: false, reason: r.error || '需要会员或解析失败' };
}

module.exports = { id: 'youku', name: '优酷', color: '#1890ff', domains: ['www.youku.com'], search, getSeries, probe };
