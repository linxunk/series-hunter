'use strict';

/**
 * 判断标题是否是「合集段」（如：庆余年1-5、第6-10集、EP01-05）。
 * 返回 { from, to } 或 null。
 */
function episodeRange(title) {
  const t = String(title || '');
  const patterns = [
    /第?\s*(\d{1,4})\s*[-–—~至到]\s*(\d{1,4})\s*[集期话]/,
    /(\d{1,4})\s*[-–—~]\s*(\d{1,4})\s*$/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const from = Number(m[1]);
      const to = Number(m[2]);
      if (from > 0 && to > from && to < 10000) return { from, to };
    }
  }
  return null;
}

/**
 * 从剧集标题里推断集号，用于跨平台对齐同一集。
 * 支持：第12集 / 12集 / 12：标题 / 12.标题 / 纯数字 / E12 / EP12 / 【12】
 * 合集段标题（1-5）返回 0，表示「不对应单集」。
 */
function episodeNo(title, fallback = 0) {
  const t = String(title || '').trim();
  if (!t) return fallback;
  if (episodeRange(t)) return 0;

  const patterns = [
    /第\s*(\d{1,4})\s*[集期话]/,
    /(?:^|[\s【\[（(])(\d{1,4})(?:[\s\]】）)]|[:：、.．\-—])/,
    /^(?:EP?|ep)\s*(\d{1,4})\b/i,
    /【\s*(\d{1,4})\s*】/,
    /^\s*(\d{1,4})\s*$/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n < 10000) return n;
    }
  }
  return fallback;
}

/** 标题相似度（0~1），用于跨平台匹配同一部剧 */
function titleSimilarity(a, b) {
  const norm = (s) =>
    String(s || '')
      .replace(/[\s\-—_·:：()（）【】\[\]]/g, '')
      .replace(/第[一二三四五六七八九十\d]+季.*$/, '')
      .replace(/(电视剧|电视连续剧|剧集|全网独播|高清|在线观看|全集|正版|免费|完整版|高清在线)/g, '')
      .toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.92;
  // 字符重合度
  const setA = new Set(x.split(''));
  let hit = 0;
  for (const ch of new Set(y.split(''))) if (setA.has(ch)) hit += 1;
  const ratio = hit / Math.max(setA.size, new Set(y.split('')).size);
  return x.length >= 2 && y.length >= 2 && ratio >= 0.7 ? ratio : 0;
}

/** 明显不是正片的标题（解说/有声书/剪辑等） */
const NON_EPISODE_RE =
  /(有声书|解说|解读|盘点|杂谈|混剪|影视杂谈|吐槽|访谈|花絮|预告|片花|片段|速看|一口气|重温|解说版)/i;

function isRealEpisode(title) {
  return !NON_EPISODE_RE.test(String(title || ''));
}

module.exports = { episodeNo, titleSimilarity, episodeRange, isRealEpisode, NON_EPISODE_RE };
