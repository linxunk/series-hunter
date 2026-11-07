'use strict';

/** 环境自检：node tools/doctor.js */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../server/config');

function which(cmd) {
  try {
    return execSync(`command -v ${cmd}`, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function version(cmd, args = ['--version']) {
  try {
    const out = execSync(`${cmd} ${args.join(' ')} 2>&1`, { encoding: 'utf8' }).split('\n')[0].trim();
    return out.length > 120 ? `${out.slice(0, 60)}…` : out;
  } catch {
    return '';
  }
}

const items = [
  ['Node.js', process.version, true],
  ['yt-dlp', which('yt-dlp') ? version('yt-dlp') : '未安装（bash tools/install.sh）', Boolean(which('yt-dlp'))],
  ['ffmpeg', which('ffmpeg') ? version('ffmpeg', ['-version']) : '未安装（音视频无法合并）', Boolean(which('ffmpeg'))],
  ['下载目录', config.load().downloadDir, fs.existsSync(config.load().downloadDir)],
  ['配置文件', config.SETTINGS_FILE, fs.existsSync(config.SETTINGS_FILE)],
];

console.log('=== 剧集猎人 环境自检 ===');
for (const [name, val, good] of items) {
  console.log(`${good ? '✓' : '!'} ${name.padEnd(10)} ${val}`);
}
console.log('\n平台适配器：爱奇艺 / 芒果TV / 哔哩哔哩 / 腾讯视频 / 优酷');
console.log('提示：国内网络下解析成功率最高；海外 IP 可能被平台区域限制。');
