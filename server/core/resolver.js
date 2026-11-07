'use strict';

const platforms = require('../platforms');
const { load } = require('../config');
const { resolveViaParsers } = require('./parser');
const { titleSimilarity, isRealEpisode } = require('../util/episode');
const log = require('../util/log');

function makeCtx() {
  const config = load();
  return {
    config,
    cookieFor: (id) => (config.cookies || {})[id] || '',
  };
}

/** 限制并发地遍历数组 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * 解析一部剧的全部分集，并判定哪些集可下载。
 * 返回 { title, cover, total, episodes, found, missing, summary }
 */
async function resolveSeries({ platform, url, onProgress, probeLimit = 8, cross = false }) {
  const p = platforms.get(platform);
  if (!p) throw new Error(`未知平台: ${platform}`);
  const ctx = makeCtx();

  const series = await p.getSeries(url, ctx);
  const episodes = series.episodes.map((e, i) => ({
    ...e,
    index: i,
    available: undefined,
    reason: '',
  }));

  let done = 0;
  await mapLimit(episodes, probeLimit, async (ep) => {
    let result = { ok: false, reason: '未知状态' };
    try {
      result = await p.probe(ep, ctx);
    } catch (e) {
      result = { ok: false, reason: e.message };
    }
    if (!result.ok && ep.vip) {
      // 会员内容：尝试第三方解析方案
      try {
        const direct = await resolveViaParsers(ep.url, ctx);
        if (direct) {
          ep.directUrl = direct.url;
          ep.parsedFrom = direct.from;
          result = { ok: true, reason: `第三方解析成功（${direct.from}）` };
        }
      } catch (e) {
        log.warn('resolver', `第三方解析异常: ${e.message}`);
      }
    }
    ep.available = result.ok;
    ep.reason = result.reason || '';
    if (result.direct) ep.directUrl = result.direct;
    done += 1;
    if (onProgress) onProgress({ done, total: episodes.length });
  });

  const found = episodes.filter((e) => e.available).map((e) => e.no);
  let missing = episodes.filter((e) => !e.available).map((e) => e.no);
  const total = series.total || episodes.length;
  // 平台给出了总集数但没有直出分集（例如全部需要会员）时，视为整部都未找到
  if (!episodes.length && total > 0) {
    missing = Array.from({ length: total }, (_, i) => i + 1);
  }
  let summary = buildSummary(total, found, missing);

  // 跨平台补集：为缺失的集号寻找其它平台上的同集
  let alternatives = {};
  let altPlatforms = [];
  let bundles = {};
  if (cross && missing.length) {
    const res = await findAlternatives({ ...series, platform, missing }, ctx);
    alternatives = res.map;
    altPlatforms = res.platforms;
    bundles = res.bundles || {};
    const altCount = Object.keys(alternatives).length;
    const bundleCount = Object.keys(bundles).length;
    if (altCount) {
      summary += ` （其中${altCount}集可由${altPlatforms.join('、')}补齐）`;
    }
    if (bundleCount) {
      const cover = Object.values(bundles)
        .slice(0, 6)
        .map((b) => `${b.from}-${b.to}`)
        .join('、');
      summary += ` 另有${bundleCount}个合集来源覆盖：${cover}`;
    }
    // 把有替补来源的集标记为「可下载（替代来源）」
    for (const ep of episodes) {
      if (!ep.available && alternatives[ep.no] && alternatives[ep.no].length) {
        ep.alternative = alternatives[ep.no][0];
      }
    }
  }

  return {
    platform,
    platformName: p.name,
    platformColor: p.color,
    url,
    title: series.title,
    cover: series.cover,
    note: series.note || '',
    total,
    episodes,
    found,
    missing,
    alternatives,
    altPlatforms,
    bundles,
    summary,
  };
}

/**
 * 跨平台补集：同一部剧在别的平台常有免费集，这里按集号对齐，
 * 为缺失的集找到「同集号、且当前账号可直接观看」的替代来源。
 *
 * 返回 { map: { 集号: [替代来源...] }, platforms: [...] }
 */
async function findAlternatives(series, ctx, opts = {}) {
  const need = new Set((series.missing || []).map(Number));
  const map = {};
  const bundleMap = {};
  const usedPlatforms = [];
  if (!need.size) return { map, platforms: usedPlatforms, bundles: bundleMap };

  const perPlatform = opts.perPlatform || 2;
  const maxNeed = opts.maxNeed || 40;

  for (const p of platforms.PLATFORMS) {
    if (p.id === series.platform) continue;
    try {
      const cands = await p.search(series.title, ctx);
      const scored = (cands || [])
        .map((c) => ({ ...c, score: titleSimilarity(c.title, series.title) }))
        .filter((c) => c.score >= 0.72 && isRealEpisode(c.title))
        .sort((a, b) => b.score - a.score);
      if (!scored.length) continue;

      for (const cand of scored.slice(0, perPlatform)) {
        let s2;
        try {
          s2 = await p.getSeries(cand.url, ctx);
        } catch (e) {
          log.warn('cross', `${p.name} 剧集解析失败: ${e.message}`);
          continue;
        }
        const eps = (s2.episodes || []).filter((e) => need.has(Number(e.no))).slice(0, maxNeed);
        // 合集段（如 B 站「1-5 集合集」）单独收集，不参与按集号对齐
        const bundles = (s2.episodes || []).filter((e) => e.range && e.range.to >= e.range.from);
        for (const b of bundles) {
          if (!isRealEpisode(b.title)) continue;
          // 只保留与缺失集号有重叠的合集
          let overlap = 0;
          for (const no of need) if (no >= b.range.from && no <= b.range.to) overlap += 1;
          if (!overlap) continue;
          const key = `${b.range.from}-${b.range.to}`;
          if (!bundleMap[key]) {
            if (!usedPlatforms.includes(p.name)) usedPlatforms.push(p.name);
            bundleMap[key] = {
              platform: p.id,
              platformName: p.name,
              platformColor: p.color,
              url: b.url,
              title: b.title,
              from: b.range.from,
              to: b.range.to,
              overlap,
              seriesTitle: s2.title,
            };
          }
        }
        if (!eps.length && !bundles.length) continue;

        const probed = await mapLimit(eps, 6, async (e) => {
          if (!e.vip) return { ...e, available: true, reason: '免费内容' };
          const r = await p.probe(e, ctx);
          return { ...e, available: r.ok, reason: r.reason, directUrl: r.direct };
        });

        let hit = 0;
        for (const e of probed) {
          if (!e.available) continue;
          const no = Number(e.no);
          const list = map[no] || (map[no] = []);
          if (list.some((x) => x.platform === p.id && x.url === e.url)) continue;
          list.push({
            platform: p.id,
            platformName: p.name,
            platformColor: p.color,
            url: e.url,
            title: e.title,
            vip: Boolean(e.vip),
            reason: e.reason || '',
            seriesTitle: s2.title,
            tvId: e.tvId || '',
            vid: e.vid || '',
          });
          hit += 1;
        }
        if (hit) {
          if (!usedPlatforms.includes(p.name)) usedPlatforms.push(p.name);
          log.info('cross', `${p.name} 为 ${hit} 集提供替补来源`);
        }
        if (Object.keys(map).length >= need.size) break;
      }
    } catch (e) {
      log.warn('cross', `${p.name} 跨平台搜索失败: ${e.message}`);
    }
    if (Object.keys(map).length >= need.size) break;
  }

  // 去冗余：同一平台下，若已有更细粒度（区间更短）的合集覆盖了该区间，则丢弃粗粒度版本
  const kept = [];
  for (const [k, v] of Object.entries(bundleMap).sort(
    (a, b) => a[1].to - a[1].from - (b[1].to - b[1].from) || a[1].from - b[1].from,
  )) {
    const covered = kept.some(
      (o) => o.platform === v.platform && o.from <= v.from && o.to >= v.to,
    );
    if (!covered) kept.push(v);
  }
  const sortedBundles = Object.fromEntries(
    kept.sort((a, b) => a.from - b.from || a.to - b.to).slice(0, 24).map((v) => [`${v.from}-${v.to}`, v]),
  );
  return { map, platforms: usedPlatforms, bundles: sortedBundles };
}

function buildSummary(total, found, missing) {
  const f = found.length ? found.join(' ') : '无';
  const m = missing.length ? missing.join(' ') : '无';
  return `本部视频共${total}集 已找到的有${f}集 未找到的有${m}集`;
}

module.exports = { resolveSeries, buildSummary, makeCtx, mapLimit, findAlternatives };
