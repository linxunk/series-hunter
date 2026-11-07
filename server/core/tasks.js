'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { load } = require('../config');
const ytdlp = require('./ytdlp');
const { zipFiles } = require('./zip');
const log = require('../util/log');

const tasks = new Map();

function sanitize(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function createTask({ title, mode = 'files', items = [], platform = '' }) {
  const id = crypto.randomUUID();
  const task = {
    id,
    title: title || '下载任务',
    mode, // files | zip
    platform,
    state: 'running',
    createdAt: Date.now(),
    finishedAt: 0,
    zipFile: null,
    error: '',
    items: items.map((it, i) => ({
      id: `${id}-${i}`,
      no: it.no,
      title: it.title || '',
      url: it.url,
      directUrl: it.directUrl || '',
      tvId: it.tvId || '',
      vid: it.vid || '',
      platform: it.platform || task.platform,
      state: 'pending',
      percent: 0,
      speed: 0,
      size: 0,
      file: '',
      error: '',
    })),
  };
  tasks.set(id, task);
  return task;
}

function getTask(id) {
  return tasks.get(id) || null;
}

function listTasks() {
  return [...tasks.values()].map((t) => ({
    id: t.id,
    title: t.title,
    mode: t.mode,
    state: t.state,
    createdAt: t.createdAt,
    zipFile: t.zipFile,
    items: t.items.length,
    done: t.items.filter((i) => i.state === 'done').length,
  }));
}

function outputDirFor(task) {
  const cfg = load();
  const base = path.join(cfg.downloadDir, sanitize(task.title) || task.id);
  fs.mkdirSync(base, { recursive: true });
  return base;
}

async function runTask(task) {
  const cfg = load();
  const outDir = outputDirFor(task);
  const cookie = (cfg.cookies || {})[task.platform] || '';
  const referer = refererFor(task.platform);
  let platformMod = null;
  try {
    platformMod = require('../platforms').get(task.platform);
  } catch {
    platformMod = null;
  }

  for (const item of task.items) {
    if (task.state === 'cancelled') return task;
    item.state = 'running';
    const itemPlatform = item.platform || task.platform;
    const itemCookie = (cfg.cookies || {})[itemPlatform] || cookie;
    const itemReferer = refererFor(itemPlatform) || referer;
    let itemPlatformMod = platformMod;
    try {
      itemPlatformMod = require('../platforms').get(itemPlatform) || platformMod;
    } catch {
      itemPlatformMod = platformMod;
    }
    const prefix = `${sanitize(task.title)} - 第${pad(item.no)}集`;
    const filename = `${prefix} - ${sanitize(item.title)}.%(ext)s`;
    try {
      let target = item.directUrl || item.url;
      // 平台直连通道（如爱奇艺 tmts）：先换取真实播放地址
      if (!item.directUrl && itemPlatformMod && typeof itemPlatformMod.resolveDirectUrl === 'function' && item.tvId) {
        try {
          const direct = await itemPlatformMod.resolveDirectUrl(
            { url: item.url, tvId: item.tvId, vid: item.vid, title: item.title },
            { config: cfg, cookieFor: (id) => (cfg.cookies || {})[id] || '' },
          );
          if (direct) {
            target = direct;
            log.info('task', `直连地址获取成功: ${item.title}`);
          }
        } catch (e) {
          log.warn('task', `直连地址获取失败: ${e.message}`);
        }
      }
      const res = await ytdlp.download(target, {
        outDir,
        filename,
        cookie: itemCookie,
        referer: item.directUrl || target !== item.url ? item.url : itemReferer,
        quality: cfg.quality,
        timeout: cfg.taskTimeoutMs,
        onProgress: (p) => {
          item.percent = Math.round(p.percent * 10) / 10;
          item.speed = p.speed;
          if (p.total) item.size = p.total;
        },
      });
      let file = res.file;
      if (!file || !fs.existsSync(file)) {
        file = findNewest(outDir, prefix);
      }
      item.file = file || '';
      item.state = 'done';
      item.percent = 100;
      if (file && fs.existsSync(file)) item.size = fs.statSync(file).size;
    } catch (e) {
      item.state = 'error';
      item.error = String(e.message || e).slice(0, 400);
      log.warn('task', `下载失败 ${item.title}: ${item.error}`);
    }
  }

  const okFiles = task.items.filter((i) => i.state === 'done' && i.file);
  if (task.mode === 'zip' && okFiles.length) {
    try {
      const zipPath = path.join(outDir, `${sanitize(task.title)}.zip`);
      const res = await zipFiles(
        okFiles.map((f) => ({ path: f.file, name: path.basename(f.file) })),
        zipPath,
      );
      task.zipFile = { path: zipPath, name: path.basename(zipPath), size: res.size, entries: res.entries };
      log.info('task', `打包完成: ${zipPath} (${okFiles.length} 个文件)`);
    } catch (e) {
      task.error = `打包失败: ${e.message}`;
      log.error('task', task.error);
    }
  }

  task.state = task.items.some((i) => i.state === 'error') ? 'partial' : 'done';
  task.finishedAt = Date.now();
  return task;
}

function findNewest(dir, prefix) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (files.length) return path.join(dir, files[0].f);
  } catch {
    /* ignore */
  }
  return '';
}

function refererFor(platform) {
  switch (platform) {
    case 'iqiyi':
      return 'https://www.iqiyi.com/';
    case 'mgtv':
      return 'https://www.mgtv.com/';
    case 'bilibili':
      return 'https://www.bilibili.com/';
    case 'qq':
      return 'https://v.qq.com/';
    case 'youku':
      return 'https://www.youku.com/';
    default:
      return '';
  }
}

/** 启动后台下载（立即返回任务对象） */
function startTask(opts) {
  const task = createTask(opts);
  setImmediate(async () => {
    try {
      await runTask(task);
    } catch (e) {
      task.state = 'error';
      task.error = String(e.message || e);
      log.error('task', `任务异常: ${task.error}`);
    }
  });
  return task;
}

module.exports = { createTask, getTask, listTasks, startTask, runTask, sanitize };
