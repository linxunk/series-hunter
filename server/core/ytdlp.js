'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { load } = require('../config');
const log = require('../util/log');

/**
 * 找到可用的 yt-dlp：
 *   1) 显式配置 YT_DLP_PATH
 *   2) 项目内置 tools/yt-dlp（会自动带上 vendor/ 的 PYTHONPATH）
 *   3) 系统里的 yt-dlp
 *   4) python3 -m yt_dlp（pip 装过但没进 PATH 时兜底）
 * 返回 { cmd, args }，args 是固定前缀参数。
 */
function ytdlpCmd() {
  const cfg = load();
  if (cfg.ytdlpPath) return { cmd: cfg.ytdlpPath, args: [] };
  if (process.env.YT_DLP_PATH) return { cmd: process.env.YT_DLP_PATH, args: [] };
  const bundled = path.join(__dirname, '..', '..', 'tools', 'yt-dlp');
  if (fs.existsSync(bundled)) return { cmd: bundled, args: [] };
  if (fs.existsSync('/usr/local/bin/yt-dlp')) return { cmd: '/usr/local/bin/yt-dlp', args: [] };
  if (fs.existsSync('/usr/bin/yt-dlp')) return { cmd: '/usr/bin/yt-dlp', args: [] };
  return { cmd: 'python3', args: ['-m', 'yt_dlp'] };
}

function ytdlpBin() {
  return ytdlpCmd().cmd;
}

function buildCookieArgs(cookie) {
  if (!cookie) return [];
  const raw = String(cookie).trim();
  if (!raw) return [];
  if (raw.includes('Netscape HTTP Cookie File')) {
    return ['--cookies', raw];
  }
  if (raw.includes('\n') && raw.includes('\t')) {
    // 多行内容按 Cookie 文件处理
    return ['--cookies', raw];
  }
  return ['--add-header', `Cookie: ${raw}`];
}

function qualityFormat(quality) {
  switch (String(quality || 'best')) {
    case '1080':
      return 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b';
    case '720':
      return 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b';
    case '480':
      return 'bv*[height<=480]+ba/b[height<=480]/bv*+ba/b';
    default:
      return 'bv*+ba/b';
  }
}

/**
 * 探测视频是否可解析（不下载）。返回 { ok, title, duration, error }
 */
async function probe(url, opts = {}) {
  const timeout = opts.timeout ?? 45000;
  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--no-playlist',
    '--skip-download',
    '--socket-timeout',
    '15',
    '--retries',
    '2',
    ...buildCookieArgs(opts.cookie),
  ];
  if (opts.referer) args.push('--referer', opts.referer);
  if (opts.extraArgs) args.push(...opts.extraArgs);
  args.push(url);

  const res = await run(args, { timeout, capture: true });
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || '解析失败').split('\n').slice(-3).join(' ').trim() };
  }
  let info = {};
  try {
    const text = res.stdout.trim().split('\n').filter(Boolean).pop();
    info = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `解析结果异常: ${e.message}` };
  }
  if (!info || (!info.url && !(info.formats || []).length)) {
    return { ok: false, error: '未找到可播放地址' };
  }
  return { ok: true, title: info.title, duration: info.duration, info };
}

/**
 * 列出剧集（扁平播放列表，不解析具体地址）。
 * 返回 { ok, title, entries: [{no,title,url,thumbnail,duration}], error }
 */
async function listEntries(url, opts = {}) {
  const timeout = opts.timeout ?? 60000;
  const args = [
    '--dump-single-json',
    '--flat-playlist',
    '--no-warnings',
    '--socket-timeout',
    '15',
    '--retries',
    '2',
    ...buildCookieArgs(opts.cookie),
  ];
  if (opts.referer) args.push('--referer', opts.referer);
  if (opts.extraArgs) args.push(...opts.extraArgs);
  args.push(url);

  const res = await run(args, { timeout, capture: true });
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || '解析失败').split('\n').slice(-3).join(' ').trim() };
  }
  let info = {};
  try {
    const text = res.stdout.trim().split('\n').filter(Boolean).pop();
    info = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `解析结果异常: ${e.message}` };
  }
  const entries = (info.entries || []).filter(Boolean);
  if (!entries.length) return { ok: false, error: '未解析到任何剧集', info };
  return { ok: true, title: info.title, thumbnail: info.thumbnail, entries, info };
}

/**
 * 下载单个视频，返回 { file, title }
 */
async function download(url, opts = {}) {
  const cfg = load();
  const outDir = opts.outDir || cfg.downloadDir;
  fs.mkdirSync(outDir, { recursive: true });
  const outTpl = path.join(outDir, opts.filename || '%(title)s.%(ext)s');

  const args = ['--newline', '--no-warnings', '--no-part', '--continue', '--no-playlist'];
  args.push('--progress-template', 'DLPROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.status)s');
  args.push('-f', qualityFormat(opts.quality || cfg.quality));
  if (opts.mergeVideo === false || cfg.mergeVideo === false) args.push('--no-merge-output-format');
  args.push('--socket-timeout', '20', '--retries', '5', '--fragment-retries', '5');
  args.push('--concurrent-fragments', '4');
  args.push('-o', outTpl);
  if (opts.referer) args.push('--referer', opts.referer);
  args.push(...buildCookieArgs(opts.cookie));
  if (opts.extraArgs) args.push(...opts.extraArgs);
  args.push(url);

  const started = Date.now();
  const res = await run(args, {
    timeout: opts.timeout ?? cfg.taskTimeoutMs,
    capture: false,
    onLine: (line) => {
      if (!line.startsWith('DLPROGRESS')) return;
      const parts = line.split(' ').filter(Boolean);
      const nums = parts.slice(1).map((x) => Number(x));
      const [downloaded, total, estimate, speed] = nums;
      const size = total || estimate || 0;
      if (opts.onProgress) {
        opts.onProgress({
          downloaded: downloaded || 0,
          total: size,
          speed: speed || 0,
          percent: size ? Math.min(100, ((downloaded || 0) / size) * 100) : 0,
        });
      }
    },
  });

  if (res.code !== 0) {
    const err = new Error(`下载失败: ${(res.stderr || '').split('\n').filter(Boolean).slice(-2).join(' ')}`);
    err.stderr = res.stderr;
    throw err;
  }
  const file = res.stdout
    .split('\n')
    .filter((l) => l.startsWith('[Merger]') || l.startsWith('[download] Destination:'))
    .map((l) => l.split(': ').pop())
    .pop();
  const merged = res.stdout.includes('[Merger]')
    ? res.stdout.split('\n').filter((l) => l.startsWith('[Merger]')).map((l) => l.split(': ').pop()).pop()
    : null;
  return {
    file: merged || file || '',
    title: opts.title,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

function run(args, opts = {}) {
  return new Promise((resolve) => {
    const bin = ytdlpBin();
    void bin;
    let child;
    try {
      const spec = ytdlpCmd();
      child = spawn(spec.cmd, [...spec.args, ...args], { cwd: opts.cwd });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: `无法启动 ${bin}: ${e.message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let buffer = '';
    let timer = null;
    let finished = false;

    const finish = (code) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    if (opts.timeout) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        stderr += `\n超时(${opts.timeout}ms)`;
        finish(124);
      }, opts.timeout);
    }

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (!opts.onLine) return;
      buffer += s;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) opts.onLine(line.trim());
      }
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (opts.onLine && process.env.DEBUG_YTDLP) log.debug('ytdlp', s.trim());
    });
    child.on('error', (e) => {
      stderr += `\n${e.message}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code === null ? -1 : code));
  });
}

async function checkInstalled() {
  const res = await run(['--version'], { timeout: 15000, capture: true });
  return res.code === 0 ? res.stdout.trim() : null;
}

module.exports = { probe, listEntries, download, checkInstalled, buildCookieArgs, qualityFormat };
