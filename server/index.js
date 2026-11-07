'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const config = require('./config');
const log = require('./util/log');
const platforms = require('./platforms');
const { resolveSeries } = require('./core/resolver');
const tasks = require('./core/tasks');
const ytdlp = require('./core/ytdlp');

const WEB_DIR = path.join(__dirname, '..', 'web');
// 剧集解析 / 跨平台补集都是长耗时任务，统一走任务表异步执行：
// 长连接容易被反向代理（隧道、CDN）按超时切断，短轮询则不会。
const jobs = new Map();

function createJob(type, payload) {
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { id: jobId, type, state: 'running', result: null, error: '', createdAt: Date.now(), payload });
  for (const [id, job] of jobs) {
    if (Date.now() - job.createdAt > 30 * 60 * 1000) jobs.delete(id);
  }
  return jobId;
}

function runJob(jobId, fn) {
  Promise.resolve()
    .then(fn)
    .then((result) => jobs.set(jobId, { ...jobs.get(jobId), state: 'done', result, error: '', finishedAt: Date.now() }))
    .catch((e) => jobs.set(jobId, { ...jobs.get(jobId), state: 'error', result: null, error: String(e.message || e), finishedAt: Date.now() }));
}
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { ok: false, error: message, ...extra });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`请求体不是合法 JSON: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel).replace(/\.\./g, '');
  const filePath = path.join(WEB_DIR, rel);
  if (!filePath.startsWith(WEB_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(filePath).pipe(res);
}

/** 以附件形式下载服务器上的文件（仅允许 downloads 目录内） */
function serveFile(req, res, filePath, downloadName) {
  const cfg = config.load();
  const base = path.resolve(cfg.downloadDir);
  const target = path.resolve(filePath);
  if (!target.startsWith(base)) {
    sendError(res, 403, '不允许访问该路径');
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    sendError(res, 404, '文件不存在或已被清理');
    return;
  }
  const stat = fs.statSync(target);
  const name = encodeURIComponent(downloadName || path.basename(target));
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${path.basename(target)}"; filename*=UTF-8''${name}`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(target).pipe(res);
}

async function handleApi(req, res, parsed) {
  const { pathname, query } = parsed;

  if (pathname === '/api/health') {
    const version = await ytdlp.checkInstalled();
    return sendJson(res, 200, {
      ok: true,
      ytdlp: version ? `yt-dlp ${version}` : '未安装 yt-dlp',
      ytdlpReady: Boolean(version),
      node: process.version,
      downloadDir: config.load().downloadDir,
    });
  }

  if (pathname === '/api/platforms') {
    return sendJson(res, 200, { ok: true, platforms: platforms.list() });
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, config: config.publicView() });
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const patch = {};
      if (body.cookies && typeof body.cookies === 'object') patch.cookies = body.cookies;
      if (Array.isArray(body.parsers)) patch.parsers = body.parsers;
      if (body.quality) patch.quality = body.quality;
      if (typeof body.mergeVideo === 'boolean') patch.mergeVideo = body.mergeVideo;
      if (typeof body.concurrency === 'number') patch.concurrency = body.concurrency;
      if (body.fallbackSearchEngine) patch.fallbackSearchEngine = body.fallbackSearchEngine;
      const saved = config.save(patch);
      log.info('config', '配置已更新');
      return sendJson(res, 200, { ok: true, config: config.publicView(), saved: Object.keys(saved) });
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }

  if (pathname === '/api/search' && req.method === 'GET') {
    const q = (query.q || '').trim();
    if (!q) return sendError(res, 400, '请输入要搜索的剧名');
    const ids = (query.platforms || '').split(',').filter(Boolean);
    try {
      const results = await platforms.searchAll(q, ids, { config: config.load() });
      return sendJson(res, 200, { ok: true, query: q, results });
    } catch (e) {
      return sendError(res, 500, e.message);
    }
  }

  if (pathname === '/api/series' && req.method === 'GET') {
    const platform = query.platform;
    const target = query.url;
    if (!platform || !target) return sendError(res, 400, '缺少 platform 或 url');
    try {
      const series = await resolveSeries({
        platform,
        url: target,
        cross: query.cross === '1' || query.cross === 'true',
      });
      return sendJson(res, 200, { ok: true, series });
    } catch (e) {
      log.warn('api', `解析失败 ${platform} ${target}: ${e.message}`);
      return sendError(res, 500, e.message);
    }
  }

  if (pathname === '/api/job' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const type = body.type === 'cross' ? 'cross' : 'series';
      if (!body.platform || !body.url) return sendError(res, 400, '缺少 platform 或 url');
      const jobId = createJob(type, body);
      runJob(jobId, () =>
        resolveSeries({ platform: body.platform, url: body.url, cross: type === 'cross' }),
      );
      return sendJson(res, 200, { ok: true, jobId, type });
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }

  if (pathname === '/api/job' && req.method === 'GET') {
    const job = jobs.get(query.jobId);
    if (!job) return sendError(res, 404, '任务不存在或已过期');
    return sendJson(res, 200, { ok: true, state: job.state, error: job.error, series: job.result, type: job.type });
  }

  if (pathname === '/api/download' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return sendError(res, 400, '没有需要下载的剧集');
      const task = tasks.startTask({
        title: body.title || '下载任务',
        platform: body.platform || '',
        mode: body.mode === 'zip' ? 'zip' : 'files',
        items: items.map((it) => ({
          no: it.no === undefined || it.no === null ? 0 : it.no,
          title: it.title || '',
          url: it.url,
          directUrl: it.directUrl || '',
          tvId: it.tvId || '',
          vid: it.vid || '',
          platform: it.platform || body.platform || '',
        })),
      });
      return sendJson(res, 200, { ok: true, taskId: task.id });
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }

  if (pathname === '/api/task' && req.method === 'GET') {
    const id = query.id;
    const task = tasks.getTask(id);
    if (!task) return sendError(res, 404, '任务不存在');
    return sendJson(res, 200, { ok: true, task });
  }

  if (pathname === '/api/tasks' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, tasks: tasks.listTasks() });
  }

  if (pathname === '/api/file' && req.method === 'GET') {
    const p = query.path;
    if (!p) return sendError(res, 400, '缺少 path');
    return serveFile(req, res, p, query.name);
  }

  return sendError(res, 404, `未知接口: ${pathname}`);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const { pathname } = parsed;
  // 跨域支持：前端独立部署时用 CORS_ORIGIN 指定白名单
  const corsOrigin = process.env.CORS_ORIGIN || config.load().corsOrigin || '';
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, parsed);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (e) {
    log.error('http', `未捕获异常: ${e.stack || e.message}`);
    if (!res.headersSent) sendError(res, 500, e.message);
    else res.end();
  }
});

server.listen(PORT, HOST, async () => {
  const cfg = config.load();
  log.info('boot', `剧集猎人已启动 → http://localhost:${PORT}`);
  log.info('boot', `下载目录: ${cfg.downloadDir}`);
  const version = await ytdlp.checkInstalled();
  if (version) log.info('boot', `yt-dlp: ${version}`);
  else log.warn('boot', '未检测到 yt-dlp，请先运行: bash tools/install.sh');
});

process.on('unhandledRejection', (e) => {
  log.error('process', `未处理的 Promise 异常: ${e && e.stack ? e.stack : e}`);
});
