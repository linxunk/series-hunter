'use strict';

const crypto = require('crypto');
const { getText } = require('../util/http');
const { extractJsonObjects } = require('../util/jsparse');
const { siteSearch } = require('./searchlib');
const log = require('../util/log');

const EXTRA_RE = /(预告|花絮|片花|独家|抢先看|完整版|回顾|片段|直拍|reaction|解读|盘点|专访|直播|会员)/i;
const TMTS_KEY = 'd5fb4bd9d50c4be6948c97edd7254b0e';
const TMTS_SRC = '76f90cbd92f94a2e925d83e8ccd22cb7';

function cleanTitle(t) {
  return String(t || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTitle(obj) {
  return cleanTitle(obj.title || obj.name || obj.shortTitle || obj.subtitle || '');
}

async function search(query, ctx) {
  const hits = await siteSearch(query, {
    domains: ['iqiyi.com'],
    pattern: /\/(a_[\w]+|v_[\w]+)\.html$/i,
    engine: ctx.config.fallbackSearchEngine,
  });

  const out = [];
  const seen = new Set();
  for (const hit of hits) {
    const url = hit.url.replace(/^http:/, 'https:').replace(/^https?:\/\/m\.iqiyi\.com/, 'https://www.iqiyi.com');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: cleanTitle(hit.title) || '爱奇艺剧集',
      url,
      cover: '',
      year: '',
      note: /\/a_/.test(url) ? '爱奇艺专辑' : '爱奇艺单集',
    });
    if (out.length >= 10) break;
  }
  // 专辑（整部剧）优先展示
  out.sort((a, b) => (/\/a_/.test(b.url) ? 1 : 0) - (/\/a_/.test(a.url) ? 1 : 0));
  return out;
}

async function getSeries(url, ctx) {
  const { getText, retry } = require('../util/http');
  const html = await retry(
    () => getText(url, { headers: { Referer: 'https://www.iqiyi.com/' }, timeout: ctx.config.requestTimeoutMs, noCache: true }),
    2,
    1500,
  );

  const objects = extractJsonObjects(html, 'playUrl', 600);
  const byUrl = new Map();
  for (const obj of objects) {
    const playUrl = obj.playUrl;
    if (!playUrl || typeof playUrl !== 'string') continue;
    const title = pickTitle(obj);
    if (!title) continue;
    const key = playUrl.split('?')[0];
    if (byUrl.has(key)) continue;
    byUrl.set(key, {
      title,
      url: playUrl.split('?')[0].replace(/^http:/, 'https:'),
      vip: Number(obj.payMark || 0) > 0,
      order: Number(obj.order || 0),
      duration: obj.duration || '',
      cover: obj.imageUrl || '',
      tvId: obj.tvId || '',
      vid: obj.vid || '',
    });
  }

  const all = [...byUrl.values()];
  const episodes = all
    .filter((e) => !EXTRA_RE.test(e.title))
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((e, i) => ({ ...e, no: e.order || i + 1 }));

  const total = readTotal(html) || episodes.length || all.length;

  const albumTitle =
    cleanTitle((html.match(/data-share-title="([^"]+)"/) || [])[1] || '') ||
    cleanTitle((html.match(/<title>([^<]+)<\/title>/) || [])[1] || '').split('-')[0] ||
    '爱奇艺剧集';

  return {
    title: albumTitle,
    cover: (html.match(/https:\/\/pic\d\.iqiyipic\.com\/common\/[^"']+\.jpg/) || [])[0] || '',
    total,
    episodes,
    note: episodes.length ? '' : '爱奇艺未在页面中直出正片列表，可通过第三方解析服务补全',
  };
}

/** 页面里带有 videoCount / total 字段，代表该专辑的总集数 */
function readTotal(html) {
  const m =
    html.match(/"videoCount":\s*(\d+)/) ||
    html.match(/"total":\s*(\d+)\s*,\s*"latestOrder"/) ||
    html.match(/"episodeCount":\s*(\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * 通过爱奇艺 tmts 接口换取真实播放地址（m3u8）。
 * 免费内容无需登录即可换到；会员内容需要用户自己的会员 Cookie。
 */
async function resolveDirectUrl(episode, ctx) {
  if (!episode || !episode.tvId || !episode.vid) return null;
  const tvid = String(episode.tvId);
  const tm = Date.now();
  const sc = crypto.createHash('md5').update(`${tm}${TMTS_KEY}${tvid}`).digest('hex');
  const url =
    `http://cache.m.iqiyi.com/jp/tmts/${tvid}/${episode.vid}/` +
    `?tvid=${tvid}&vid=${episode.vid}&src=${TMTS_SRC}&sc=${sc}&t=${tm}`;

  const headers = { Referer: 'https://www.iqiyi.com/' };
  const cookie = ctx.cookieFor('iqiyi');
  if (cookie) headers.Cookie = cookie;

  const text = await getText(url, { headers, timeout: 20000 });
  const raw = text.replace(/^var\s+tvInfoJs\s*=\s*/, '').trim();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    log.warn('iqiyi', `tmts 返回解析失败: ${e.message}`);
    return null;
  }
  const d = (data && data.data) || {};
  const vidl = Array.isArray(d.vidl) ? d.vidl : [];
  const direct = d.m3u8 || d.m3u || (vidl[0] && (vidl[0].m3u8 || vidl[0].m3u)) || null;
  return direct ? String(direct).replace(/\\\//g, '/') : null;
}

async function probe(episode, ctx) {
  try {
    const direct = await resolveDirectUrl(episode, ctx);
    if (direct) {
      return { ok: true, reason: episode.vip ? '会员账号解析成功' : '免费内容', direct };
    }
  } catch (e) {
    log.warn('iqiyi', `解析失败: ${e.message}`);
  }
  return {
    ok: false,
    reason: episode.vip ? '需要会员（可配置会员 Cookie 或第三方解析）' : '暂未找到可播放地址',
  };
}

module.exports = {
  id: 'iqiyi',
  name: '爱奇艺',
  color: '#00be06',
  domains: ['www.iqiyi.com'],
  search,
  getSeries,
  probe,
  resolveDirectUrl,
};
