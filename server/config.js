'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./util/log');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

const DEFAULTS = {
  // 各平台会员 Cookie（用户自己的账号，用于下载已购会员内容）
  cookies: {
    bilibili: '',
    iqiyi: '',
    mgtv: '',
    qq: '',
    youku: '',
  },
  // 第三方解析服务：url 模板中使用 {url} 占位符，{ref} 为来源页
  parsers: [
    {
      name: '示例解析服务',
      // 例如：https://your-parser.example/api?url={url}
      url: '',
      enabled: false,
    },
  ],
  // 下载设置
  downloadDir: path.join(ROOT, 'downloads'),
  // 视频清晰度：best | 1080 | 720 | 480
  quality: 'best',
  // 是否合并音视频（需要 ffmpeg）
  mergeVideo: true,
  // 并发下载数
  concurrency: 2,
  // 单个任务超时（毫秒）
  taskTimeoutMs: 30 * 60 * 1000,
  // 全局请求超时（毫秒）
  requestTimeoutMs: 20000,
  // 自定义 UA
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  // 搜索站点（用于跨平台兜底搜索）
  fallbackSearchEngine: 'auto', // auto | baidu | bing
  // 跨域白名单（前端与后端分开部署时填前端域名，如 https://cdn.example.com）
  corsOrigin: '',
};

let cached = null;
let logLevel = null;

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    /* ignore */
  }
}

function load() {
  if (cached) return cached;
  ensureDir(CONFIG_DIR);
  let data = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {
    log.warn('config', `配置文件解析失败，使用默认配置: ${e.message}`);
  }
  cached = {
    ...DEFAULTS,
    ...data,
    cookies: { ...DEFAULTS.cookies, ...(data.cookies || {}) },
    parsers: Array.isArray(data.parsers) ? data.parsers : DEFAULTS.parsers,
  };
  // 环境变量优先（容器/服务器部署常用）
  if (process.env.DOWNLOAD_DIR) cached.downloadDir = process.env.DOWNLOAD_DIR;
  if (process.env.CORS_ORIGIN) cached.corsOrigin = process.env.CORS_ORIGIN;
  if (process.env.YT_DLP_PATH) cached.ytdlpPath = process.env.YT_DLP_PATH;
  if (process.env.LOG_LEVEL) logLevel = process.env.LOG_LEVEL;

  // 相对路径按项目根目录解析
  if (!path.isAbsolute(cached.downloadDir)) {
    cached.downloadDir = path.resolve(ROOT, cached.downloadDir);
  }
  ensureDir(cached.downloadDir);
  return cached;
}

function save(patch) {
  const cur = load();
  const next = { ...cur, ...patch };
  if (patch && patch.cookies) next.cookies = { ...cur.cookies, ...patch.cookies };
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  cached = next;
  return cached;
}

/** 对外暴露时隐藏敏感字段 */
function publicView() {
  const c = load();
  const cookies = {};
  for (const [k, v] of Object.entries(c.cookies || {})) {
    cookies[k] = { set: Boolean(v && String(v).trim()), length: v ? String(v).length : 0 };
  }
  return {
    cookies,
    parsers: (c.parsers || []).map((p) => ({ name: p.name, url: p.url, enabled: p.enabled })),
    downloadDir: c.downloadDir,
    quality: c.quality,
    mergeVideo: c.mergeVideo,
    concurrency: c.concurrency,
    fallbackSearchEngine: c.fallbackSearchEngine,
  };
}

module.exports = { load, save, publicView, DEFAULTS, ROOT, CONFIG_DIR, SETTINGS_FILE };
