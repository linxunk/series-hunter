'use strict';

const { findAlternatives } = require('./resolver');
const log = require('../util/log');

/**
 * 自动补齐：把「本站没找到」的集数，到其它平台（免费来源）找同集号内容，
 * 计算出一份下载计划；合集段（B 站常见 1-5 / 6-10 分段）会按区间整体覆盖。
 *
 * 返回 {
 *   plan:     [{ kind:'bundle'|'episode', no|from, to, url, title, platform, platformName }],
 *   covered:  { 集号: { kind, platform, platformName, title, url, from, to } },
 *   stillMissing: [集号]
 * }
 */
async function planAutofill(series, ctx, options = {}) {
  const maxItems = options.maxItems || 24;
  const missing = (series.missing || []).map(Number).filter((n) => n > 0);
  const res = await findAlternatives({ ...series, missing }, ctx);
  const map = res.map || {};
  const bundles = res.bundles || {};

  const uncovered = new Set(missing);
  const plan = [];
  const covered = {};

  // 1) 先用合集覆盖（文件数最少）
  const bundleList = Object.values(bundles).sort(
    (a, b) => hitCount(b, missing) - hitCount(a, missing) || a.from - b.from,
  );
  for (const b of bundleList) {
    if (plan.length >= maxItems) break;
    const hits = missing.filter((n) => n >= b.from && n <= b.to && uncovered.has(n));
    if (!hits.length) continue;
    // 若已有合集完全覆盖该区间，则跳过（避免重复下载）
    const redundant = plan.some(
      (p) => p.kind === 'bundle' && p.platform === b.platform && p.from <= b.from && p.to >= b.to,
    );
    if (redundant) continue;
    plan.push({
      kind: 'bundle',
      from: b.from,
      to: b.to,
      no: `${b.from}-${b.to}`,
      title: b.title || `第${b.from}-${b.to}集`,
      url: b.url,
      platform: b.platform,
      platformName: b.platformName,
    });
    for (const n of hits) {
      uncovered.delete(n);
      covered[n] = {
        kind: 'bundle',
        platform: b.platform,
        platformName: b.platformName,
        title: b.title,
        url: b.url,
        from: b.from,
        to: b.to,
      };
    }
  }

  // 2) 剩下的用单集替代
  for (const n of [...uncovered].sort((a, b) => a - b)) {
    if (plan.length >= maxItems) break;
    const alt = (map[n] || [])[0];
    if (!alt) continue;
    plan.push({
      kind: 'episode',
      no: n,
      title: alt.title || `第${n}集`,
      url: alt.url,
      platform: alt.platform,
      platformName: alt.platformName,
    });
    uncovered.delete(n);
    covered[n] = {
      kind: 'episode',
      platform: alt.platform,
      platformName: alt.platformName,
      title: alt.title,
      url: alt.url,
      from: n,
      to: n,
    };
  }

  log.info(
    'autofill',
    `补齐计划：${plan.length} 个文件，覆盖 ${Object.keys(covered).length} 集，仍缺 ${uncovered.size} 集`,
  );

  return { plan, covered, stillMissing: [...uncovered].sort((a, b) => a - b) };
}

function hitCount(bundle, missing) {
  return missing.filter((n) => n >= bundle.from && n <= bundle.to).length;
}

/**
 * 把补齐结果写回剧集对象：缺集标记为「已由其它平台补齐」，
 * 并让报告里的「已找到」包含这些集。
 */
function applyFill(series, fill) {
  for (const ep of series.episodes || []) {
    const src = fill.covered[ep.no];
    if (src) {
      ep.filledBy = src;
      ep.available = true;
      ep.reason = `由${src.platformName}补齐`;
    }
  }
  const filled = Object.keys(fill.covered).map(Number).sort((a, b) => a - b);
  const found = Array.from(new Set([...(series.found || []), ...filled])).sort((a, b) => a - b);
  const stillMissing = (series.missing || []).filter((n) => !fill.covered[n]);
  const { buildSummary } = require('./resolver');
  const summary = buildSummary(series.total || series.episodes.length, found, stillMissing);
  series.found = found;
  series.missing = stillMissing;
  series.filled = filled;
  series.fillPlan = fill.plan;
  series.summary = filled.length
    ? `${summary}（其中${filled.length}集由其它平台补齐）`
    : summary;
  return series;
}

module.exports = { planAutofill, applyFill };
