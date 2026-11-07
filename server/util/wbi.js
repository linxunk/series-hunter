'use strict';

const crypto = require('crypto');
const { getJson } = require('./http');

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21,
  56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

let mixinCache = { at: 0, key: '' };

async function getMixinKey() {
  if (mixinCache.key && Date.now() - mixinCache.at < 30 * 60 * 1000) return mixinCache.key;
  const nav = await getJson('https://api.bilibili.com/x/web-interface/nav');
  const img = nav?.data?.wbi_img?.img_url;
  const sub = nav?.data?.wbi_img?.sub_url;
  if (!img || !sub) throw new Error('获取 wbi key 失败');
  const raw = img.split('/').pop().split('.')[0] + sub.split('/').pop().split('.')[0];
  mixinCache = { at: Date.now(), key: MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32) };
  return mixinCache.key;
}

function sign(params, mixinKey) {
  const wts = Math.floor(Date.now() / 1000);
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(all[k])}`)
    .join('&');
  const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${w_rid}`;
}

/** 带 WBI 签名的 GET（自动追加 wts / w_rid） */
async function wbiGet(url, params = {}, opts = {}) {
  const mixinKey = await getMixinKey();
  const query = sign(params, mixinKey);
  return getJson(`${url}?${query}`, opts);
}

module.exports = { wbiGet, getMixinKey, sign };
