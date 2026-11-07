'use strict';

const { getText } = require('../util/http');
const log = require('../util/log');

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 跨平台兜底搜索：同时使用 Bing 与百度移动端，抓取目标站点下的链接。
 *
 * @param {string} query 剧名
 * @param {object} options
 *   - domains: 允许的域名数组（如 ['iqiyi.com']）
 *   - pattern: 可选的 URL 正则（RegExp 或字符串），用于筛选剧集页
 *   - engine: 'auto' | 'bing' | 'baidu'
 */
async function siteSearch(query, options = {}) {
  const domains = options.domains || [];
  const pattern = options.pattern ? toRegExp(options.pattern) : null;
  const engine = options.engine || 'auto';
  const engines = engine === 'auto' ? ['bing', 'baidu'] : [engine];

  const out = [];
  for (const eng of engines) {
    try {
      const items = eng === 'bing' ? await bingSearch(query, domains) : await baiduSearch(query, domains);
      for (const it of items) {
        if (pattern && !pattern.test(it.url)) continue;
        if (!out.some((o) => o.url === it.url)) out.push(it);
      }
    } catch (e) {
      log.warn('search', `${eng} 搜索失败: ${e.message}`);
    }
    if (out.length >= 8) break;
  }
  return out;
}

function toRegExp(p) {
  return p instanceof RegExp ? p : new RegExp(p);
}

/** Bing：解析 <h2><a href> 结构 */
async function bingSearch(query, domains) {
  const kw = `site:${domains[0] || ''} ${query}`;
  const html = await getText(`https://cn.bing.com/search?q=${encodeURIComponent(kw)}&setmkt=zh-CN`, { timeout: 20000 });
  const results = [];
  const seen = new Set();

  const h2Re = /<h2[^>]*>\s*<a[^>]+href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = h2Re.exec(html))) {
    const url = m[1];
    if (!matchesDomains(url, domains)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ url, title: stripTags(m[2]) || fallbackTitle(url), engine: 'bing' });
  }

  if (!results.length) {
    for (const domain of domains) {
      const re = new RegExp(`https?://(?:[a-z0-9-]+\\.)*${escapeRe(domain)}/[A-Za-z0-9_./%-]*`, 'gi');
      let mm;
      while ((mm = re.exec(html))) {
        const url = mm[0];
        if (seen.has(url)) continue;
        seen.add(url);
        results.push({ url, title: fallbackTitle(url), engine: 'bing' });
      }
    }
  }
  return results;
}

/** 百度移动端：按结果卡片解析「真实地址 + 标题」 */
async function baiduSearch(query, domains) {
  const results = [];
  const seen = new Set();
  const doms = domains.length ? domains : [''];

  for (const dom of doms) {
    const kw = `${query}${dom ? ` site:${dom}` : ''}`;
    const html = await getText(`https://m.baidu.com/s?word=${encodeURIComponent(kw)}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      },
      timeout: 20000,
    });
    if (!html || html.length < 3000) continue;

    const blocks = html.split(/<div[^>]*class="c-result/i).slice(1);
    for (const block of blocks) {
      const mu =
        (block.match(/"mu":"(https?:[^"]+)"/) || [])[1] ||
        (block.match(/rl-link-href="(https?:[^"]+)"/) || [])[1] ||
        '';
      if (!mu) continue;
      const url = mu.replace(/&amp;/g, '&');
      if (!matchesDomains(url, domains)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      const h3 = (block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [])[1] || '';
      results.push({ url, title: stripTags(h3) || fallbackTitle(url), engine: 'baidu' });
    }

    if (!results.length) {
      for (const domain of domains) {
        const re = new RegExp(`https?://(?:[a-z0-9-]+\\.)*${escapeRe(domain)}/[A-Za-z0-9_./%-]*`, 'gi');
        let mm;
        while ((mm = re.exec(html))) {
          const url = mm[0];
          if (seen.has(url)) continue;
          seen.add(url);
          results.push({ url, title: fallbackTitle(url), engine: 'baidu' });
        }
      }
    }
    if (results.length) break;
  }
  return results;
}

function matchesDomains(url, domains) {
  if (!domains.length) return true;
  return domains.some((d) => url.includes(d.replace(/^www\./, '')));
}

function fallbackTitle(url) {
  const parts = url.split(/[/?#]/).filter(Boolean);
  const tail = parts[parts.length - 1] || url;
  return stripTags(tail.replace(/[._-]+/g, ' '));
}

module.exports = { siteSearch, stripTags };
