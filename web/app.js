/* 剧集猎人 · 前端逻辑 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const state = {
    platforms: [],
    activePlatforms: [],
    results: [],
    series: null,
    selected: new Set(),
    bundleSel: new Set(),
    pollTimer: null,
    lastTask: null,
    searching: false,
    autoFill: localStorage.getItem('sh_autofill') !== '0',
    retryTimer: null,
    autofilling: false,
  };

  /* ---------------- 通用工具 ---------------- */

  function toast(msg, ms = 2600) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  function detectOS() {
    const ua = navigator.userAgent || '';
    const plat = (navigator.userAgentData && navigator.userAgentData.platform) || '';
    const touchMac = /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
    if (/iPad|iPhone|iPod/.test(ua) || touchMac) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    if (/Windows/i.test(ua) || /Win32/i.test(plat)) return 'windows';
    if (/Mac/i.test(plat) || /Macintosh/.test(ua)) return 'mac';
    return 'linux';
  }

  const OS_LABEL = {
    ios: 'iOS / iPadOS',
    android: 'Android',
    windows: 'Windows',
    mac: 'macOS',
    linux: 'Linux',
  };

  function fileNameSafe(name) {
    return String(name || 'video.mp4').replace(/[\\/:*?"<>|]/g, '_');
  }

  /* ---------------- 后端连接配置 ---------------- */

  const KNOWN_KEY = 'sh_known_backends';

  function knownBackends() {
    try {
      const list = JSON.parse(localStorage.getItem(KNOWN_KEY) || '[]');
      return Array.isArray(list) ? list.filter(Boolean) : [];
    } catch (e) {
      return [];
    }
  }

  function rememberBackend(base) {
    if (!base) return;
    const list = knownBackends().filter((x) => x !== base);
    list.unshift(base);
    localStorage.setItem(KNOWN_KEY, JSON.stringify(list.slice(0, 5)));
  }

  function apiBase() {
    const saved = localStorage.getItem('sh_api_base');
    const cfg = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || '';
    return String(saved || cfg || '').replace(/\/+$/, '');
  }

  function apiUrl(path) {
    return `${apiBase()}${path}`;
  }

  function isCrossOrigin() {
    const base = apiBase();
    if (!base) return false;
    try {
      return new URL(base).origin !== window.location.origin;
    } catch (e) {
      return true;
    }
  }

  function askConnect() {
    if (window.APP_CONFIG && window.APP_CONFIG.showConnectPrompt === false) return;
    const modal = $('#connectModal');
    if (!modal) return;
    $('#connectInput').value = apiBase();
    $('#connectStatus').textContent = '';
    const tk = $('#ghTokenInput');
    if (tk) tk.value = ghToken();
    const ws = $('#wakeStatus');
    if (ws) ws.textContent = '';
    modal.classList.remove('hidden');
    setTimeout(() => $('#connectInput').focus(), 60);
  }

  async function doConnect() {
    const value = $('#connectInput').value.trim().replace(/\/+$/, '');
    const status = $('#connectStatus');
    if (value) localStorage.setItem('sh_api_base', value);
    else localStorage.removeItem('sh_api_base');
    status.textContent = '正在连接…';
    try {
      const health = await api('/api/health');
      rememberBackend(apiBase());
      status.textContent = `连接成功：${health.ytdlp || '后端已就绪'}`;
      setTimeout(() => {
        $('#connectModal').classList.add('hidden');
        window.location.reload();
      }, 700);
    } catch (e) {
      status.textContent = `连接失败：${e.message}`;
    }
  }

  async function api(path, options) {
    const res = await fetch(apiUrl(path), options);
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      throw new Error(`接口返回异常: ${text.slice(0, 120)}`);
    }
    if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  /* ---------------- 初始化 ---------------- */

  async function init() {
    try {
      const [plat, health] = await Promise.all([api('/api/platforms'), api('/api/health')]);
      state.platforms = plat.platforms;
      state.activePlatforms = plat.platforms.map((p) => p.id);
      renderChips();
      const badge = $('#engineBadge');
      if (health.ytdlpReady) {
        badge.textContent = `✓ ${health.ytdlp}`;
        badge.className = 'badge badge-ok';
      } else {
        badge.textContent = '⚠ 未检测到 yt-dlp';
        badge.className = 'badge badge-warn';
        badge.title = '请先运行 bash tools/install.sh 安装 yt-dlp';
      }
    } catch (e) {
      // 自动回退：尝试之前连通过的其它后端
      const alt = await failover();
      if (alt) return;
      $('#engineBadge').textContent = '服务未就绪';
      $('#engineBadge').className = 'badge badge-warn';
      toast(e.message);
      askConnect();
      autoRetry();
    }
  }

  /** 后端不可用时自动轮询等待云主机上线 */
  function autoRetry() {
    if (state.retryTimer) return;
    state.retryTimer = setInterval(async () => {
      try {
        const h = await fetch(apiUrl('/api/health'), { cache: 'no-store' });
        if (h.ok) window.location.reload();
      } catch (e) {
        /* 继续等 */
      }
    }, 8000);
  }

  /* ---------------- 云主机唤醒（GitHub Codespaces） ---------------- */

  function ghToken() {
    return localStorage.getItem('sh_gh_token') || '';
  }

  function codespaceInfo() {
    const cfg = window.APP_CONFIG || {};
    return { name: cfg.codespace || '', port: cfg.codespacePort || 8787 };
  }

  /** 唤醒 Codespaces：调用 start 接口刷新空闲计时器 / 拉起已停机的实例 */
  async function wakeCodespace() {
    const { name } = codespaceInfo();
    const token = ghToken();
    const status = $('#wakeStatus');
    if (!name) {
      if (status) status.textContent = '未配置 Codespaces';
      return;
    }
    if (!token) {
      if (status) status.textContent = '请先填入 GitHub 令牌';
      return;
    }
    if (status) status.textContent = '正在唤醒…';
    try {
      // 云主机可能正在停机中（GitHub 会回 "already running"），需要重试
      let lastErr = null;
      let sent = false;
      for (let i = 0; i < 10 && !sent; i += 1) {
        try {
          const res = await fetch(`https://api.github.com/user/codespaces/${encodeURIComponent(name)}/start`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          });
          if (res.ok) {
            sent = true;
            break;
          }
          const err = await res.json().catch(() => ({}));
          lastErr = new Error(err.message || `HTTP ${res.status}`);
        } catch (e) {
          lastErr = e;
        }
        if (status) status.textContent = `等待停机完成并重试…（${i + 1}）`;
        await new Promise((r) => setTimeout(r, 8000));
      }
      if (!sent) throw lastErr || new Error('唤醒失败');
      if (status) status.textContent = '唤醒指令已发送，正在等待上线…';
      // 等待后端就绪
      for (let i = 0; i < 40; i += 1) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const h = await fetch(apiUrl('/api/health'), { cache: 'no-store' });
          if (h.ok) {
            if (status) status.textContent = '云主机已上线 ✓';
            window.location.reload();
            return;
          }
        } catch (e) {
          /* 继续等 */
        }
        if (status && i % 4 === 3) status.textContent = `等待云主机上线…（${(i + 1) * 5}s）`;
      }
      if (status) status.textContent = '仍在等待，请稍后再试';
    } catch (e) {
      if (status) status.textContent = `唤醒失败：${e.message}`;
    }
  }

  /** 依次尝试历史后端，成功则切换并刷新 */
  async function failover() {
    const candidates = knownBackends().filter((b) => b !== apiBase());
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}/api/health`, { cache: 'no-store' });
        if (!res.ok) continue;
        localStorage.setItem('sh_api_base', base);
        window.location.reload();
        return true;
      } catch (e) {
        /* 试下一个 */
      }
    }
    return false;
  }

  function renderChips() {
    const box = $('#platformChips');
    box.innerHTML = '';
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'chip active';
    all.textContent = '全部平台';
    all.onclick = () => {
      state.activePlatforms = state.platforms.map((p) => p.id);
      renderChips();
    };
    box.appendChild(all);

    state.platforms.forEach((p) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip active';
      chip.style.setProperty('--chip-color', p.color);
      chip.textContent = p.name;
      chip.onclick = () => {
        const idx = state.activePlatforms.indexOf(p.id);
        if (idx >= 0) state.activePlatforms.splice(idx, 1);
        else state.activePlatforms.push(p.id);
        renderChips();
      };
      box.appendChild(chip);
    });
  }

  /* ---------------- 搜索 ---------------- */

  async function doSearch(ev) {
    if (ev) ev.preventDefault();
    const q = $('#searchInput').value.trim();
    if (!q) {
      toast('请输入要搜索的剧名');
      return;
    }
    if (!state.activePlatforms.length) {
      toast('请至少选择一个平台');
      return;
    }
    const btn = $('#btnSearch');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 搜索中';
    $('#emptySection').classList.add('hidden');
    try {
      const data = await api(
        `/api/search?q=${encodeURIComponent(q)}&platforms=${state.activePlatforms.join(',')}`,
      );
      state.results = data.results || [];
      renderResults();
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '搜索';
    }
  }

  function renderResults() {
    const list = $('#resultList');
    const section = $('#resultSection');
    list.innerHTML = '';
    if (!state.results.length) {
      section.classList.add('hidden');
      $('#emptySection').classList.remove('hidden');
      $('#emptySection').querySelector('p').textContent = '没有找到结果，换个关键词或勾选更多平台试试。';
      $('#resultMeta').textContent = '';
      return;
    }
    $('#emptySection').classList.add('hidden');
    section.classList.remove('hidden');
    $('#resultMeta').textContent = `${state.results.length} 条结果`;

    state.results.forEach((r) => {
      const card = document.createElement('article');
      card.className = 'card';

      const head = document.createElement('div');
      head.className = 'card-head';
      const title = document.createElement('h3');
      title.className = 'card-title';
      title.textContent = r.title || '未命名';
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.style.background = r.platformColor || '';
      pill.textContent = r.platformName || r.platform;
      head.append(title, pill);

      const note = document.createElement('p');
      note.className = 'card-note';
      note.textContent = r.note || r.url;

      const actions = document.createElement('div');
      actions.className = 'card-actions';
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.type = 'button';
      btn.textContent = '查看全部剧集';
      btn.onclick = () => openSeries(r.platform, r.url, r.title);
      actions.appendChild(btn);

      card.append(head, note, actions);
      list.appendChild(card);
    });
  }

  /* ---------------- 剧集详情 ---------------- */

  async function openSeries(platform, url, fallbackTitle) {
    state.series = null;
    state.selected = new Set();
    state.bundleSel = new Set();
    updateCounts();
    $('#drawer').classList.remove('hidden');
    $('#drawerTitle').textContent = fallbackTitle || '解析中…';
    $('#drawerPlatform').textContent = '解析中';
    $('#episodeList').innerHTML = '';
    $('#summaryBox').innerHTML = '<div class="summary-loading"><span class="spinner"></span> 正在解析剧集列表与可用性…</div>';

    try {
      const series = await runJob({ type: 'series', platform, url });
      state.series = series;
      renderSeries();
      if (state.autoFill && (series.missing || []).length) {
        autoFill(false);
      }
    } catch (e) {
      $('#summaryBox').innerHTML = `<div class="summary-card"><span class="sum-title">解析失败</span><div>${escapeHtml(e.message)}</div></div>`;
      $('#episodeList').innerHTML = '';
    }
  }

  /** 跨平台找替补：同一部剧在别的平台常有免费集 */
  async function crossFill() {
    if (!state.series || state.searching) return;
    state.searching = true;
    const box = $('#summaryBox');
    const original = box.innerHTML;
    box.innerHTML = '<div class="summary-loading"><span class="spinner"></span> 正在其它平台查找同一集号的免费来源…</div>';
    try {
      const s = state.series;
      const series = await runJob({ type: 'cross', platform: s.platform, url: s.url });
      state.series = series;
      renderSeries();
      const n = Object.keys(state.series.alternatives || {}).length;
      const nb = Object.keys(state.series.bundles || {}).length;
      const parts = [];
      if (n) parts.push(`${n} 集同集替补`);
      if (nb) parts.push(`${nb} 个整段合集`);
      toast(
        parts.length
          ? `已在 ${(state.series.altPlatforms || []).join('、')} 找到：${parts.join(' + ')}`
          : '其它平台暂未找到可用的同集免费来源',
        4000,
      );
    } catch (e) {
      box.innerHTML = original;
      toast(e.message);
    } finally {
      state.searching = false;
    }
  }

  /** 自动补齐：去其它平台找同集免费来源并下载保存 */
  async function autoFill(manual) {
    if (!state.series || state.autofilling) return;
    state.autofilling = true;
    const s = state.series;
    try {
      const job = await api('/api/autofill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: s.platform, url: s.url, download: true, mode: 'files' }),
      });
      const result = await pollAutofill(job.jobId);
      if (result && result.series) {
        state.series = result.series;
        renderSeries();
      }
      const n = (state.series.filled || []).length;
      toast(
        n
          ? `已从其它平台补齐 ${n} 集，正在下载保存…`
          : (result && result.note) || '其它平台暂未找到可用的同集免费来源',
        4000,
      );
      if (result && result.taskId) {
        $('#progressModal').classList.remove('hidden');
        $('#progressBody').innerHTML = '<div class="muted"><span class="spinner"></span> 自动补齐下载任务已创建…</div>';
        pollTask(result.taskId);
      }
    } catch (e) {
      toast('自动补齐失败：' + e.message);
    } finally {
      state.autofilling = false;
    }
  }

  function pollAutofill(jobId) {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const timer = setInterval(async () => {
        tries += 1;
        try {
          const data = await api(`/api/job?jobId=${encodeURIComponent(jobId)}`);
          if (data.state === 'done') {
            clearInterval(timer);
            resolve(data.series);
          } else if (data.state === 'error') {
            clearInterval(timer);
            reject(new Error(data.error || '自动补齐失败'));
          } else if (tries > 400) {
            clearInterval(timer);
            reject(new Error('自动补齐超时'));
          }
        } catch (e) {
          clearInterval(timer);
          reject(e);
        }
      }, 1500);
    });
  }

  /** 提交长耗时任务并轮询结果（短请求轮询，避免长连接被代理按超时切断） */
  async function runJob(payload) {
    const job = await api('/api/job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let tries = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      tries += 1;
      const data = await api(`/api/job?jobId=${encodeURIComponent(job.jobId)}`);
      if (data.state === 'done') return data.series;
      if (data.state === 'error') throw new Error(data.error || '任务失败');
      if (tries > 240) throw new Error('任务超时');
    }
  }

  function renderSeries() {
    const s = state.series;
    $('#drawerTitle').textContent = s.title || '剧集';
    const pill = $('#drawerPlatform');
    pill.textContent = s.platformName;
    pill.style.background = s.platformColor || '';

    // 集数完整性报告
    const found = s.found || [];
    const missing = s.missing || [];
    const altMap = s.alternatives || {};
    const altCount = Object.keys(altMap).length;
    const bundles = s.bundles || {};
    const bundleKeys = Object.keys(bundles);
    const box = $('#summaryBox');
    box.innerHTML = `
      <div class="summary-card">
        <span class="sum-title">集数完整性报告</span>
        <div>本部视频共 <b>${s.total}</b> 集</div>
        <div>已找到的有：${found.length ? found.map((n) => `<span class="num sum-found">${n}</span>`).join('') : '<span class="sum-none">无</span>'}</div>
        <div>未找到的有：${missing.length ? missing.map((n) => `<span class="num sum-missing">${n}</span>`).join('') : '<span class="sum-none">无</span>'}</div>
        ${altCount ? `<div>可由其它平台补齐：${Object.keys(altMap).map((n) => `<span class="num sum-alt">${n}</span>`).join('')}</div>` : ''}
        ${missing.length && !altCount && !bundleKeys.length ? `<button id="btnCrossFill" class="btn btn-mini" type="button" style="margin-top:10px">🔍 去其它平台找替补（免费来源）</button>` : ''}
        ${altCount || bundleKeys.length ? `<button id="btnCrossFill" class="btn btn-mini" type="button" style="margin-top:10px">🔄 重新查找替补</button>` : ''}
        ${
          bundleKeys.length
            ? `<div class="bundle-block">
                 <div class="bundle-title">整段合集来源（一次覆盖多集）</div>
                 ${bundleKeys
                   .map((k) => {
                     const b = bundles[k];
                     return `<div class="bundle-row" data-bundle="${k}">
                        <span class="ep-alt-badge" style="background:${b.platformColor || '#666'}">${escapeHtml(b.platformName)}</span>
                        <span class="bundle-name">${escapeHtml(b.title || '')}</span>
                        <span class="bundle-range">覆盖第 ${b.from}-${b.to} 集</span>
                        <button class="btn btn-mini bundle-add" type="button">加入下载</button>
                      </div>`;
                   })
                   .join('')}
               </div>`
            : ''
        }
      </div>`;
    const crossBtn = $('#btnCrossFill');
    if (crossBtn) crossBtn.onclick = crossFill;
    $$('#summaryBox .bundle-row').forEach((row) => {
      row.querySelector('.bundle-add').onclick = (e) => {
        e.stopPropagation();
        const key = row.dataset.bundle;
        if (state.bundleSel.has(key)) state.bundleSel.delete(key);
        else state.bundleSel.add(key);
        renderEpSelection();
      };
    });

    const list = $('#episodeList');
    list.innerHTML = '';
    if (!(s.episodes || []).length) {
      list.innerHTML = `<div class="summary-loading" style="grid-column:1/-1">${
        s.note ? escapeHtml(s.note) : '该平台未直出分集列表，可尝试配置会员 Cookie 或第三方解析服务后重新解析。'
      }</div>`;
    }
    (s.episodes || []).forEach((ep, index) => {
      const item = document.createElement('div');
      const alt = (altMap[ep.no] || [])[0] || ep.alternative || null;
      item.className = 'ep' + (ep.available ? '' : ' missing');
      item.dataset.no = ep.no;

      const top = document.createElement('div');
      top.className = 'ep-top';
      const no = document.createElement('span');
      no.className = 'ep-no';
      no.textContent = `第${ep.no}集`;
      const badge = document.createElement('span');
      const filled = ep.filledBy;
      badge.className = 'ep-badge ' + (filled ? 'ep-filled' : ep.available ? 'ep-ok' : alt ? 'ep-alt' : 'ep-no2');
      badge.textContent = filled ? '已补齐' : ep.available ? '可下载' : alt ? '可补齐' : '未找到';
      if (filled) badge.title = `${filled.platformName}：${filled.title}`;
      if (ep.vip) {
        const vip = document.createElement('span');
        vip.className = 'ep-badge ep-vip';
        vip.textContent = 'VIP';
        top.append(no, vip);
      }
      top.append(badge);

      const name = document.createElement('div');
      name.className = 'ep-name';
      name.textContent = ep.title || '';
      name.title = `${ep.title || ''}${ep.reason ? ' · ' + ep.reason : ''}`;

      item.append(top, name);

      if (alt) {
        const tag = document.createElement('div');
        tag.className = 'ep-alt';
        tag.innerHTML = `<span class="ep-alt-badge" style="background:${alt.platformColor || '#666'}">${escapeHtml(alt.platformName)}</span>有免费来源`;
        tag.onclick = (e) => {
          e.stopPropagation();
          const key = `alt:${index}`;
          if (state.selected.has(key)) state.selected.delete(key);
          else state.selected.add(key);
          renderEpSelection();
        };
        item.appendChild(tag);
      }

      item.onclick = () => {
        const altKey = `alt:${index}`;
        if (!ep.available) {
          if (alt) {
            if (state.selected.has(altKey)) state.selected.delete(altKey);
            else state.selected.add(altKey);
            renderEpSelection();
            return;
          }
          toast(`第${ep.no}集未找到：${ep.reason || '需要会员或已下架'}`);
          return;
        }
        const key = `ep:${index}`;
        if (state.selected.has(key)) state.selected.delete(key);
        else state.selected.add(key);
        renderEpSelection();
      };
      list.appendChild(item);
    });

    // 默认全选可下载的剧集
    (s.episodes || []).forEach((ep, index) => {
      if (ep.available) state.selected.add(`ep:${index}`);
    });
    renderEpSelection();
  }

  /** 当前勾选的可下载条目（含跨平台替补来源与整段合集） */
  function selectedEpisodes() {
    if (!state.series) return [];
    const items = [];
    (state.series.episodes || []).forEach((ep, index) => {
      const alt = ((state.series.alternatives || {})[ep.no] || [])[0] || ep.alternative || null;
      if (state.selected.has(`alt:${index}`) && alt) {
        items.push({
          no: ep.no,
          title: `${ep.title}（${alt.platformName}）`,
          url: alt.url,
          directUrl: '',
          tvId: alt.tvId || '',
          vid: alt.vid || '',
          platform: alt.platform,
          index,
        });
        return;
      }
      if (state.selected.has(`ep:${index}`) && ep.available) {
        const f = ep.filledBy;
        items.push({
          no: ep.no,
          title: f ? `${ep.title}（${f.platformName}补齐）` : ep.title,
          url: f ? f.url : ep.url,
          directUrl: ep.directUrl || '',
          tvId: f ? '' : ep.tvId || '',
          vid: f ? '' : ep.vid || '',
          platform: f ? f.platform : state.series.platform,
          index,
        });
      }
    });
    // 整段合集（如 B 站 1-5 集合集）
    const bundles = (state.series.bundles || {});
    state.bundleSel.forEach((key) => {
      const b = bundles[key];
      if (!b) return;
      items.push({
        no: `${b.from}-${b.to}`,
        title: `${b.title || `第${b.from}-${b.to}集合集`}（${b.platformName}）`,
        url: b.url,
        directUrl: '',
        tvId: '',
        vid: '',
        platform: b.platform,
        index: -1,
      });
    });
    return items;
  }

  function updateCounts() {
    const n = selectedEpisodes().length;
    const text = `已选 ${n} 集`;
    $('#selCount').textContent = text;
    $('#footCount').textContent = text;
    $('#barCount').textContent = text;
    $('#actionBar').classList.toggle('hidden', n === 0);
    const hint = n ? '可下载单集，或打包为一个 ZIP 文件' : '选择剧集后可下载单集或打包为 ZIP';
    $('#footHint').textContent = hint;
    $('#barHint').textContent = hint;
  }

  /* ---------------- 下载 ---------------- */

  async function startDownload(mode) {
    const eps = selectedEpisodes();
    if (!eps.length) {
      toast('请先选择要下载的剧集');
      return;
    }
    const s = state.series;
    let res;
    try {
      res = await api('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: s.title,
          platform: s.platform,
          mode,
          items: eps.map((ep) => ({
            no: ep.no,
            title: ep.title,
            url: ep.url,
            directUrl: ep.directUrl || '',
            tvId: ep.tvId || '',
            vid: ep.vid || '',
            platform: ep.platform || s.platform,
          })),
        }),
      });
    } catch (e) {
      toast(e.message);
      return;
    }
    $('#progressModal').classList.remove('hidden');
    $('#progressBody').innerHTML = '<div class="muted"><span class="spinner"></span> 任务已创建，正在准备…</div>';
    $('#btnSaveZip').classList.add('hidden');
    pollTask(res.taskId);
  }

  function pollTask(taskId) {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      try {
        const data = await api(`/api/task?id=${encodeURIComponent(taskId)}`);
        state.lastTask = data.task;
        renderProgress(data.task);
        if (data.task.state === 'done' || data.task.state === 'partial' || data.task.state === 'error') {
          clearInterval(state.pollTimer);
          onTaskFinished(data.task);
        }
      } catch (e) {
        clearInterval(state.pollTimer);
        toast(e.message);
      }
    }, 900);
  }

  function renderProgress(task) {
    const body = $('#progressBody');
    body.innerHTML = '';
    task.items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'prog-item';
      const top = document.createElement('div');
      top.className = 'prog-top';
      const name = document.createElement('span');
      name.textContent = `第${it.no}集 ${it.title || ''}`;
      const state = document.createElement('span');
      state.className = 'muted';
      if (it.state === 'done') state.textContent = '已完成';
      else if (it.state === 'running') state.textContent = `${it.percent || 0}%`;
      else if (it.state === 'error') state.textContent = '失败';
      else state.textContent = '等待中';
      top.append(name, state);

      const bar = document.createElement('div');
      bar.className = 'prog-bar';
      const fill = document.createElement('div');
      fill.className = 'prog-fill';
      fill.style.width = `${it.state === 'done' ? 100 : it.percent || 0}%`;
      bar.appendChild(fill);

      row.append(top, bar);
      if (it.error) {
        const err = document.createElement('div');
        err.className = 'prog-err';
        err.textContent = it.error;
        row.appendChild(err);
      }
      if (it.state === 'done' && it.file) {
        const actions = document.createElement('div');
        actions.className = 'prog-actions';
        const btn = document.createElement('button');
        btn.className = 'btn btn-mini';
        btn.type = 'button';
        btn.textContent = '💾 保存到本地';
        btn.onclick = () => saveFromServer(it.file, task.title + ` - 第${String(it.no).padStart(2, '0')}集`);
        actions.appendChild(btn);
        row.appendChild(actions);
      }
      body.appendChild(row);
    });

    const done = task.items.filter((i) => i.state === 'done').length;
    const failed = task.items.filter((i) => i.state === 'error').length;
    $('#progressSummary').textContent = `共 ${task.items.length} 集，已完成 ${done} 集，失败 ${failed} 集`;
  }

  function onTaskFinished(task) {
    if (task.mode === 'zip' && task.zipFile) {
      $('#btnSaveZip').classList.remove('hidden');
      $('#btnSaveZip').onclick = () => saveFromServer(task.zipFile.path, task.zipFile.name, true);
      toast('打包完成，可保存 ZIP 文件');
    } else {
      toast('下载完成，可在列表中逐个保存到本地');
    }
  }

  /* ---------------- 保存到本地（按系统区分） ---------------- */

  async function saveFromServer(serverPath, filename, isZip) {
    const url = apiUrl(`/api/file?path=${encodeURIComponent(serverPath)}&name=${encodeURIComponent(filename)}`);
    const os = detectOS();

    if (os === 'ios') {
      openIosSheet(url, filename);
      return;
    }

    // 桌面端 / Android：优先使用系统「另存为」对话框
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileNameSafe(filename),
          types: isZip ? [{ description: 'ZIP 压缩包', accept: { 'application/zip': ['.zip'] } }] : undefined,
        });
        const res = await fetch(url);
        if (!res.ok) throw new Error('文件读取失败');
        const writable = await handle.createWritable();
        await res.body.pipeTo(writable);
        toast(os === 'android' ? '已保存到所选位置' : '已保存到你选择的位置');
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        // 落回普通下载
      }
    }

    // 跨域时 <a download> 会被浏览器忽略，改用 blob 中转
    if (isCrossOrigin()) {
      try {
        toast('正在准备文件…');
        const res = await fetch(url);
        if (!res.ok) throw new Error('文件读取失败');
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = fileNameSafe(filename);
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
        toast('已开始保存');
        return;
      } catch (e) {
        toast('保存失败：' + e.message);
        return;
      }
    }

    const a = document.createElement('a');
    a.href = url;
    a.download = fileNameSafe(filename);
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(
      os === 'android'
        ? '已保存到「下载」目录'
        : `已触发下载（${OS_LABEL[os] || os}），如未弹出保存框请查看浏览器下载目录`
    );
  }

  function openIosSheet(url, filename) {
    const modal = $('#iosSheet');
    const video = $('#iosVideo');
    modal.classList.remove('hidden');
    video.src = url;
    video.load();
    $('#btnIosShare').onclick = async () => {
      try {
        const res = await fetch(url);
        const blob = await res.blob();
        const file = new File([blob], fileNameSafe(filename), { type: blob.type || 'video/mp4' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: filename });
        } else {
          const a = document.createElement('a');
          a.href = url;
          a.download = fileNameSafe(filename);
          a.click();
          toast('已下载，可用「文件」App 打开后存储到照片');
        }
      } catch (e) {
        toast('分享失败：' + e.message);
      }
    };
  }

  /* ---------------- 设置 ---------------- */

  async function openSettings() {
    try {
      const data = await api('/api/config');
      const c = data.config;
      $('#ckBilibili').value = '';
      $('#ckIqiyi').value = '';
      $('#ckMgtv').value = '';
      $('#ckQq').value = '';
      $('#ckYouku').value = '';
      $('#ckBilibili').placeholder = c.cookies.bilibili.set ? '已配置（留空保持不变）' : 'SESSDATA=...; bili_jct=...';
      $('#ckIqiyi').placeholder = c.cookies.iqiyi.set ? '已配置（留空保持不变）' : 'QC005=...';
      $('#ckMgtv').placeholder = c.cookies.mgtv.set ? '已配置（留空保持不变）' : '__dfduid=...';
      $('#ckQq').placeholder = c.cookies.qq.set ? '已配置（留空保持不变）' : 'vqq_...';
      $('#ckYouku').placeholder = c.cookies.youku.set ? '已配置（留空保持不变）' : '...';
      $('#selQuality').value = c.quality || 'best';
      $('#ckMerge').checked = c.mergeVideo !== false;
      $('#selEngine').value = c.fallbackSearchEngine || 'auto';
      renderParsers(c.parsers || []);
      $('#settingsModal').classList.remove('hidden');
    } catch (e) {
      toast(e.message);
    }
  }

  function renderParsers(parsers) {
    const box = $('#parserList');
    box.innerHTML = '';
    (parsers || []).forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'parser-row';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = Boolean(p.enabled);
      cb.style.width = '16px';
      cb.style.height = '16px';
      cb.style.accentColor = '#7c5cff';
      cb.onchange = () => {
        p.enabled = cb.checked;
      };

      const name = document.createElement('input');
      name.type = 'text';
      name.placeholder = '服务名称';
      name.value = p.name || '';
      name.oninput = () => {
        p.name = name.value;
      };

      const url = document.createElement('input');
      url.type = 'text';
      url.placeholder = 'https://解析域名/api?url={url}';
      url.value = p.url || '';
      url.oninput = () => {
        p.url = url.value;
      };

      const del = document.createElement('button');
      del.className = 'btn btn-mini btn-ghost';
      del.type = 'button';
      del.textContent = '✕';
      del.onclick = () => {
        parsers.splice(i, 1);
        renderParsers(parsers);
      };

      row.append(cb, name, url, del);
      box.appendChild(row);
    });
  }

  async function saveSettings() {
    const msg = $('#settingsMsg');
    msg.textContent = '保存中…';
    try {
      const body = {
        cookies: {
          bilibili: $('#ckBilibili').value.trim(),
          iqiyi: $('#ckIqiyi').value.trim(),
          mgtv: $('#ckMgtv').value.trim(),
          qq: $('#ckQq').value.trim(),
          youku: $('#ckYouku').value.trim(),
        },
        parsers: collectParsers(),
        quality: $('#selQuality').value,
        mergeVideo: $('#ckMerge').checked,
        fallbackSearchEngine: $('#selEngine').value,
      };
      // 空字符串表示“保持原值”
      const existing = (await api('/api/config')).config.cookies;
      Object.keys(body.cookies).forEach((k) => {
        if (!body.cookies[k]) body.cookies[k] = undefined;
      });
      await api('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      msg.textContent = '已保存';
      setTimeout(() => {
        $('#settingsModal').classList.add('hidden');
      }, 500);
    } catch (e) {
      msg.textContent = '保存失败：' + e.message;
    }
  }

  function collectParsers() {
    return $$('#parserList .parser-row').map((row) => {
      const [cb, name, url] = row.children;
      return { name: name.value.trim(), url: url.value.trim(), enabled: cb.checked };
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* ---------------- 事件绑定 ---------------- */

  $('#searchForm').addEventListener('submit', doSearch);
  $('#btnDownloadFiles').onclick = () => startDownload('files');
  $('#btnDownloadZip').onclick = () => startDownload('zip');
  $('#barDownloadFiles').onclick = () => startDownload('files');
  $('#barDownloadZip').onclick = () => startDownload('zip');
  $('#btnSettings').onclick = openSettings;
  $('#btnSaveSettings').onclick = saveSettings;
  $('#btnCloseSettings').onclick = () => $('#settingsModal').classList.add('hidden');
  $('#btnCloseProgress').onclick = () => $('#progressModal').classList.add('hidden');
  $('#btnCloseIos').onclick = () => {
    $('#iosSheet').classList.add('hidden');
    $('#iosVideo').pause();
    $('#iosVideo').removeAttribute('src');
  };
  $('#btnAddParser').onclick = () => {
    const parsers = collectParsers();
    parsers.push({ name: '新解析服务', url: '', enabled: false });
    renderParsers(parsers);
  };
  $('#btnBackend').onclick = askConnect;
  $('#ckAutoFill').checked = state.autoFill;
  $('#ckAutoFill').onchange = (e) => {
    state.autoFill = e.target.checked;
    localStorage.setItem('sh_autofill', e.target.checked ? '1' : '0');
    if (e.target.checked && state.series && (state.series.missing || []).length) autoFill(false);
  };
  $('#btnAutoFillNow').onclick = () => autoFill(true);
  $('#btnConnectGo').onclick = doConnect;
  $('#btnWake').onclick = () => {
    const v = $('#ghTokenInput').value.trim();
    if (v) localStorage.setItem('sh_gh_token', v);
    wakeCodespace();
  };
  $('#btnWakeOpen').onclick = () => {
    const { name } = codespaceInfo();
    if (!name) return toast('未配置 Codespaces');
    window.open(`https://github.com/codespaces/${name}`, '_blank', 'noopener');
  };
  $('#btnCloseConnect').onclick = () => $('#connectModal').classList.add('hidden');
  $('#connectInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doConnect();
  });

  $('#selectAll').onchange = (e) => {
    if (!state.series) return;
    (state.series.episodes || []).forEach((ep, index) => {
      const key = `ep:${index}`;
      const altKey = `alt:${index}`;
      const alt = ((state.series.alternatives || {})[ep.no] || [])[0] || ep.alternative || null;
      if (e.target.checked) {
        if (ep.available) state.selected.add(key);
        else if (alt) state.selected.add(altKey);
      } else {
        state.selected.delete(key);
        state.selected.delete(altKey);
      }
    });
    renderEpSelection();
  };

  $('#invertSel').onchange = () => {
    if (!state.series) return;
    (state.series.episodes || []).forEach((ep, index) => {
      const alt = ((state.series.alternatives || {})[ep.no] || [])[0] || ep.alternative || null;
      const key = ep.available ? `ep:${index}` : alt ? `alt:${index}` : null;
      if (!key) return;
      if (state.selected.has(key)) state.selected.delete(key);
      else state.selected.add(key);
    });
    renderEpSelection();
  };

  $('#btnOnlyMissing').onclick = () => {
    if (!state.series) return;
    (state.series.episodes || []).forEach((ep, index) => {
      const alt = ((state.series.alternatives || {})[ep.no] || [])[0] || ep.alternative || null;
      const key = ep.available ? `ep:${index}` : alt ? `alt:${index}` : null;
      if (!key) {
        state.selected.delete(`ep:${index}`);
        state.selected.delete(`alt:${index}`);
        return;
      }
      state.selected.add(key);
      state.selected.delete(ep.available ? `alt:${index}` : `ep:${index}`);
    });
    renderEpSelection();
  };

  function renderEpSelection() {
    const eps = (state.series && state.series.episodes) || [];
    $$('#summaryBox .bundle-row').forEach((row) => {
      const on = state.bundleSel.has(row.dataset.bundle);
      const btn = row.querySelector('.bundle-add');
      if (btn) btn.textContent = on ? '✓ 已加入' : '加入下载';
      row.classList.toggle('on', on);
    });
    $$('#episodeList .ep').forEach((node, idx) => {
      const ep = eps[idx];
      if (!ep) return;
      const alt = ((state.series.alternatives || {})[ep.no] || [])[0] || ep.alternative || null;
      const on = state.selected.has(`ep:${idx}`) || state.selected.has(`alt:${idx}`);
      node.classList.toggle('selected', on);
      const tag = node.querySelector('.ep-alt');
      if (tag && alt) {
        tag.classList.toggle('on', state.selected.has(`alt:${idx}`));
      }
    });
    updateCounts();
  }

  document.addEventListener('click', (e) => {
    if (e.target.dataset && e.target.dataset.close) $('#drawer').classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#drawer').classList.add('hidden');
      $('#progressModal').classList.add('hidden');
      $('#settingsModal').classList.add('hidden');
      $('#iosSheet').classList.add('hidden');
    }
  });

  init();
})();
