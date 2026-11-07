'use strict';

const iqiyi = require('./iqiyi');
const mgtv = require('./mgtv');
const bilibili = require('./bilibili');
const tencent = require('./tencent');
const youku = require('./youku');
const log = require('../util/log');

const PLATFORMS = [bilibili, iqiyi, mgtv, tencent, youku];
const BY_ID = Object.fromEntries(PLATFORMS.map((p) => [p.id, p]));

function get(id) {
  return BY_ID[id] || null;
}

function list() {
  return PLATFORMS.map((p) => ({ id: p.id, name: p.name, color: p.color }));
}

/**
 * 并发在多个平台搜索，返回聚合结果。
 * 每个平台失败不影响其它平台。
 */
async function searchAll(query, platformIds, ctx) {
  const ids = (platformIds && platformIds.length ? platformIds : PLATFORMS.map((p) => p.id)).filter((id) => BY_ID[id]);
  const results = await Promise.all(
    ids.map(async (id) => {
      const p = BY_ID[id];
      const started = Date.now();
      try {
        const items = await p.search(query, ctx);
        log.info('search', `${p.name} 返回 ${items.length} 条 (${Date.now() - started}ms)`);
        return items.map((it) => ({ ...it, platform: id, platformName: p.name, platformColor: p.color }));
      } catch (e) {
        log.warn('search', `${p.name} 搜索失败: ${e.message}`);
        return [];
      }
    }),
  );
  return results.flat();
}

module.exports = { PLATFORMS, get, list, searchAll };
