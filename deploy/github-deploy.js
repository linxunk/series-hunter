'use strict';

/**
 * 一键部署到 GitHub Codespaces（用 GitHub 账号当云服务器）
 *
 * 步骤：
 *   1. 在你的 GitHub 账号下创建一个私有仓库
 *   2. 用 Git Data API 一次性把整个项目推上去
 *   3. 创建 Codespace（云端 Linux 容器，自动装 yt-dlp / ffmpeg）
 *   4. 把 8787 端口设为 Public，得到公网地址 https://<name>-8787.app.github.dev
 *
 * 用法：
 *   GITHUB_TOKEN=ghp_xxx GITHUB_USER=yourname node deploy/github-deploy.js [repoName]
 */

const fs = require('fs');
const path = require('path');

const API = 'https://api.github.com';
const ROOT = path.resolve(__dirname, '..');
const TOKEN = process.env.GITHUB_TOKEN;
const USER = process.env.GITHUB_USER;
const REPO = process.argv[2] || 'series-hunter';
const MACHINE = process.env.CS_MACHINE || 'basicLinux32gb';
const PORT = 8787;

if (!TOKEN || !USER) {
  console.error('需要环境变量 GITHUB_TOKEN 和 GITHUB_USER');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(pathname, options = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'series-hunter-deploy',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${options.method || 'GET'} ${pathname} → ${res.status} ${data?.message || text.slice(0, 200)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ---------------- 1. 仓库 ---------------- */

async function ensureRepo() {
  try {
    const repo = await gh(`/repos/${USER}/${REPO}`);
    console.log(`✓ 仓库已存在：${repo.full_name}`);
    return repo;
  } catch (e) {
    if (e.status !== 404) throw e;
    const repo = await gh('/user/repos', {
      method: 'POST',
      body: {
        name: REPO,
        private: true,
        description: '剧集猎人 · 多平台剧集聚合检索与批量下载',
        auto_init: true,
      },
    });
    console.log(`✓ 已创建仓库：${repo.full_name}`);
    return repo;
  }
}

/* ---------------- 2. 推送代码 ---------------- */

const SKIP_DIRS = new Set(['node_modules', '.git', 'downloads', 'data']);
const SKIP_FILES = new Set(['series-hunter.zip']);

function collect(dir, base = '') {
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) entries.push(...collect(abs, rel));
    else if (!SKIP_FILES.has(path.basename(rel))) entries.push({ path: rel, abs });
  }
  return entries;
}

async function pushCode(repo) {
  const files = collect(ROOT);
  const tree = files.map((f) => ({
    path: f.path,
    mode: '100644',
    type: 'blob',
    content: fs.readFileSync(f.abs, 'utf8'),
  }));
  // 保证可执行脚本带上执行位
  for (const f of files) {
    if (/\.(sh|py)$/.test(f.path)) {
      const item = tree.find((t) => t.path === f.path);
      if (item) item.mode = '100755';
    }
  }

  const ref = await gh(`/repos/${repo.full_name}/git/ref/heads/${repo.default_branch || 'main'}`);
  const baseCommit = ref.object.sha;
  const baseTree = await gh(`/repos/${repo.full_name}/git/commits/${baseCommit}`);

  const newTree = await gh(`/repos/${repo.full_name}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseTree.tree.sha, tree },
  });
  const commit = await gh(`/repos/${repo.full_name}/git/commits`, {
    method: 'POST',
    body: {
      message: 'chore: 部署剧集猎人（应用 + Codespaces 配置）',
      tree: newTree.sha,
      parents: [baseCommit],
    },
  });
  await gh(`/repos/${repo.full_name}/git/refs/heads/${repo.default_branch || 'main'}`, {
    method: 'PATCH',
    body: { sha: commit.sha, force: false },
  });
  console.log(`✓ 已推送 ${tree.length} 个文件，commit ${commit.sha.slice(0, 8)}`);
}

/* ---------------- 3. Codespaces ---------------- */

async function findOrCreateCodespace(repo) {
  const list = await gh('/user/codespaces');
  const existing = (list.codespaces || []).find((c) => c.repository && c.repository.full_name === repo.full_name);
  if (existing) {
    console.log(`✓ 复用已有 Codespace：${existing.name}`);
    return existing;
  }
  const machines = (process.env.CS_MACHINE || 'basicLinux32gb,standardLinux32gb,basicLinux64gb').split(',');
  const locations = [process.env.CS_LOCATION, 'East Asia', 'West Us', 'North America', 'Europe'].filter(Boolean);
  let created = null;
  let lastErr = null;
  outer: for (const machine of machines) {
    for (const location of locations) {
      try {
        created = await gh('/user/codespaces', {
          method: 'POST',
          body: {
            repository: repo.full_name,
            devcontainer_path: '.devcontainer/devcontainer.json',
            machine,
            location,
          },
        });
        console.log(`✓ 已创建 Codespace：${created.name} (${machine} @ ${location})`);
        break outer;
      } catch (e) {
        lastErr = e;
        const msg = e.data?.message || e.message;
        console.log(`   尝试 ${machine} @ ${location} 失败：${msg}`);
        if (e.status === 404) break; // 仓库或路径问题，换机器也没用
      }
    }
    // 不带 location 再试一次（部分账号 location 为可选字段）
    try {
      created = await gh('/user/codespaces', {
        method: 'POST',
        body: {
          repository: repo.full_name,
          devcontainer_path: '.devcontainer/devcontainer.json',
          machine,
        },
      });
      console.log(`✓ 已创建 Codespace：${created.name} (${machine})`);
      break outer;
    } catch (e) {
      lastErr = e;
      console.log(`   尝试 ${machine}（默认区域）失败：${e.data?.message || e.message}`);
    }
  }
  if (!created) throw new Error('Codespace 创建失败：' + (lastErr?.data?.message || lastErr?.message));
  return created;
}

async function waitRunning(cs) {
  let last = '';
  for (let i = 0; i < 180; i += 1) {
    const cur = await gh(`/user/codespaces/${cs.name}`);
    if (cur.state !== last) {
      last = cur.state;
      console.log(`   状态：${cur.state}`);
    }
    if (cur.state === 'available') return cur;
    if (cur.state === 'shutdown') {
      await gh(`/user/codespaces/${cs.name}/start`, { method: 'POST' });
    }
    await sleep(5000);
  }
  throw new Error('等待 Codespace 就绪超时');
}

async function publishPort(cs) {
  let port = null;
  for (let i = 0; i < 60; i += 1) {
    const ports = await gh(`/user/codespaces/${cs.name}/ports`);
    const list = ports.ports || [];
    port = list.find((p) => p.number === PORT);
    if (port && port.visit_url) break;
    await sleep(5000);
  }
  if (!port) throw new Error(`端口 ${PORT} 没有被转发（应用是否已启动？）`);
  await gh(`/user/codespaces/${cs.name}/ports/${PORT}`, {
    method: 'PATCH',
    body: { visibility: 'public' },
  });
  const after = await gh(`/user/codespaces/${cs.name}/ports/${PORT}`);
  const url = after.visit_url || `https://${cs.name}-${PORT}.app.github.dev`;
  console.log(`✓ 端口 ${PORT} 已设为 Public`);
  return url.replace(/\/$/, '');
}

/* ---------------- 主流程 ---------------- */

(async () => {
  const pushOnly = process.argv.includes('--push-only');
  console.log('==============================================');
  console.log('  剧集猎人 → GitHub Codespaces 部署');
  console.log('==============================================');
  const repo = await ensureRepo();
  await pushCode(repo);
  if (pushOnly) {
    console.log('✓ 仅推送代码完成');
    return;
  }
  const cs = await findOrCreateCodespace(repo);
  await waitRunning(cs);
  console.log('   等待应用在容器内启动（装 yt-dlp / ffmpeg 需要 1-3 分钟）…');
  const url = await publishPort(cs);
  console.log('');
  console.log('==============================================');
  console.log('  部署完成 🎬');
  console.log(`  公网地址： ${url}`);
  console.log(`  仓库：     https://github.com/${repo.full_name}`);
  console.log(`  Codespace: ${cs.name}`);
  console.log('');
  console.log('  注意：Codespaces 空闲会自动停止（可改 .devcontainer/devcontainer.json');
  console.log('        里的 stopInterval，最长 12 小时）。停掉后重新启动即可恢复访问。');
  console.log('==============================================');
})().catch((e) => {
  console.error('部署失败：', e.message);
  if (e.data) console.error(JSON.stringify(e.data).slice(0, 500));
  process.exit(1);
});
