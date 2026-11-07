'use strict';

const { getJson, getText } = require('../util/http');
const { wbiGet } = require('../util/wbi');
const { siteSearch } = require('./searchlib');
const { episodeNo, episodeRange } = require('../util/episode');
const log = require('../util/log');

function cleanTitle(t) {
  return String(t || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function search(query, ctx) {
  const out = [];
  const seen = new Set();

  // 1) 官方番剧搜索接口
  try {
    const r = await wbiGet(
      'https://api.bilibili.com/x/web-interface/wbi/search/type',
      { search_type: 'media_bangumi', keyword: query },
      { headers: { Referer: 'https://search.bilibili.com/', Cookie: await buvidCookie() } },
    );
    const list = (r && r.data && r.data.result) || [];
    for (const item of list) {
      const mediaId = item.media_id || item.season_id;
      if (!mediaId) continue;
      const url = item.season_id
        ? `https://www.bilibili.com/bangumi/media/${item.media_id || item.season_id}/`
        : `https://www.bilibili.com/bangumi/media/${mediaId}/`;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        title: cleanTitle(item.title),
        url,
        cover: item.cover || '',
        year: item.years ? String(item.years).slice(0, 4) : '',
        note: `共 ${item.eps ? item.eps.length : '?'} 集`,
      });
    }
  } catch (e) {
    log.warn('bilibili', `官方搜索失败: ${e.message}`);
  }

  // 2) 官方普通视频搜索（番剧接口为空时兜底）
  if (!out.length) {
    try {
      const r = await wbiGet(
        'https://api.bilibili.com/x/web-interface/wbi/search/type',
        { search_type: 'video', keyword: query, order: 'totalrank' },
        { headers: { Referer: 'https://search.bilibili.com/', Cookie: await buvidCookie() } },
      );
      const list = (r && r.data && r.data.result) || [];
      for (const item of list) {
        if (!item.bvid) continue;
        const title = cleanTitle(item.title);
        if (!title.includes(query)) continue;
        const url = `https://www.bilibili.com/video/${item.bvid}/`;
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({
          title,
          url,
          cover: item.pic || '',
          year: '',
          note: `UP：${cleanTitle(item.author) || '未知'}`,
        });
        if (out.length >= 12) break;
      }
    } catch (e) {
      log.warn('bilibili', `视频搜索失败: ${e.message}`);
    }
  }

  // 3) 站点搜索兜底
  if (!out.length) {
    const hits = await siteSearch(query, {
      domains: ['bilibili.com'],
      pattern: /\/(bangumi\/media\/md\d+|video\/BV[\w]+)/i,
      engine: ctx.config.fallbackSearchEngine,
    });
    for (const hit of hits) {
      if (!/\/(bangumi\/media\/md\d+|video\/BV[\w]+)/i.test(hit.url)) continue;
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      out.push({
        title: cleanTitle(hit.title),
        url: hit.url,
        cover: '',
        year: '',
        note: '来自哔哩哔哩',
      });
      if (out.length >= 12) break;
    }
  }

  return out;
}

let buvidCache = { at: 0, cookie: '' };
async function buvidCookie() {
  if (buvidCache.cookie && Date.now() - buvidCache.at < 30 * 60 * 1000) return buvidCache.cookie;
  try {
    const r = await getJson('https://api.bilibili.com/x/frontend/finger/spi');
    const cookie = `buvid3=${r.data.b_3}; buvid4=${r.data.b_4}; b_nut=${Math.floor(Date.now() / 1000)}`;
    buvidCache = { at: Date.now(), cookie };
    return cookie;
  } catch {
    return '';
  }
}

async function getSeries(url, ctx) {
  const seasonId = (url.match(/[?&]season_id=(\d+)/) || [])[1];
  const mediaId = (url.match(/md(\d+)/) || [])[1];
  const bvid = (url.match(/\/(BV[\w]+)/) || [])[1];
  const headers = { Referer: 'https://www.bilibili.com/', Cookie: await buvidCookie() };

  // 番剧 / 影视
  if (seasonId || mediaId) {
    const api = seasonId
      ? `https://api.bilibili.com/pgc/view/web/season?season_id=${seasonId}`
      : `https://api.bilibili.com/pgc/view/web/season?media_id=${mediaId}`;
    const r = await getJson(api, { headers });
    if (r.code === 0 && r.data) {
      const result = r.data;
      const episodes = (result.episodes || []).map((ep, i) => ({
        no: episodeNo(ep.title, i + 1),
        title: cleanTitle(ep.title) || `第${i + 1}集`,
        url: `https://www.bilibili.com/video/${ep.bvid}/`,
        vip: isVip(ep) || isVip(result),
        duration: ep.duration || 0,
        cover: ep.cover || '',
        bvid: ep.bvid,
      }));
      return {
        title: cleanTitle(result.title) || '哔哩哔哩剧集',
        cover: result.cover || '',
        total: result.total || episodes.length,
        episodes,
      };
    }
    log.warn('bilibili', `season 接口返回 code=${r.code} ${r.message || ''}`);
  }

  // 普通视频（分 P）
  if (bvid) {
    const r = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers });
    if (r.code === 0 && r.data) {
      const data = r.data;
      const episodes = (data.pages || []).map((p, i) => ({
        no: episodeNo(p.part, i + 1),
        range: episodeRange(p.part),
        title: cleanTitle(p.part) || `P${i + 1}`,
        url: `https://www.bilibili.com/video/${bvid}/?p=${p.page}`,
        vip: data.is_upower_exclusive === true || Number(data.pay || 0) > 0,
        duration: p.duration || 0,
        cover: data.pic || '',
        bvid,
      }));
      return {
        title: cleanTitle(data.title) || '哔哩哔哩视频',
        cover: data.pic || '',
        total: episodes.length,
        episodes,
      };
    }
  }

  throw new Error('无法解析该 B 站链接的剧集列表');
}

function isVip(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const rights = obj.rights || {};
  if (Number(rights.pay) === 1) return true;
  if (obj.is_upower_exclusive === true) return true;
  const badge = String(obj.badge || obj.badge_style || '');
  if (/会员|付费/.test(badge)) return true;
  return false;
}

async function probe(episode, ctx) {
  if (!episode.vip) return { ok: true, reason: '免费内容' };
  const ytdlp = require('../core/ytdlp');
  const cookie = ctx.cookieFor('bilibili');
  if (cookie) {
    const r = await ytdlp.probe(episode.url, { cookie, referer: 'https://www.bilibili.com/' });
    if (r.ok) return { ok: true, reason: '会员账号解析成功' };
  }
  return { ok: false, reason: '需要大会员（可配置大会员 Cookie 或第三方解析）' };
}

module.exports = { id: 'bilibili', name: '哔哩哔哩', color: '#fb7299', domains: ['www.bilibili.com'], search, getSeries, probe };
