# 剧集猎人 · SeriesHunter

一个**多平台剧集聚合检索与批量下载**的网页应用：输入想看的剧名，自动在 **爱奇艺 / 芒果TV / 哔哩哔哩 / 腾讯视频 / 优酷** 上检索，解析出该剧的**完整分集列表**，并给出「已找到 / 未找到」的集数报告；可单集下载，也可一键**打包成 ZIP**；下载时按 **iOS / Android / Windows / macOS** 自动采用对应的保存方式。

> 请仅下载你有权观看的内容，并遵守各平台的服务条款与当地法律法规。本项目默认不内置任何盗版资源，VIP 内容只支持「你自己的账号 Cookie」或「你自己配置的第三方解析服务」。

---

## 功能一览

| 需求 | 实现 |
| --- | --- |
| 输入想看的片 | 首页搜索框 + 平台筛选（可多选） |
| 自动到爱奇艺/芒果/B站等平台找 | 每个平台独立适配器，官方接口优先，搜索引擎兜底 |
| 尽量找到所有集 | 解析平台分集列表，逐集探测可播放性 |
| 找不到的集要说明 | 输出「本部视频共 X 集，已找到的有 … 集，未找到的有 … 集」 |
| 全部要会员时用第三方方案下载 | 会员 Cookie 直取 + 可配置的第三方解析服务，解析成功后直连下载 |
| 没有会员也想拿全集 | 新增**跨平台补集**：自动去其它平台找同一集号的免费来源，并识别「整段合集」（如 B 站 1-5、6-10 分段） |
| 底部可下载 / 下载 zip | 页面底部常驻操作条 + 抽屉底部操作区，支持单集下载与 ZIP 打包 |
| 点击下载识别系统 | Windows/macOS 弹出「另存为」选路径；Android 保存到下载目录；iOS 弹出「存储到照片」引导 |

---

## 快速开始

```bash
# 1. 安装依赖（yt-dlp + ffmpeg）
bash tools/install.sh

# 2. 启动
npm start          # 或 node server/index.js

# 3. 打开浏览器
#    http://localhost:8787
```

环境自检：

```bash
node tools/doctor.js
```

> 项目**零 npm 依赖**，只用 Node.js 内置模块 + yt-dlp，因此 `npm install` 可选。

---

## 目录结构

```
series-hunter/
├── server/
│   ├── index.js              # HTTP 服务与 API 路由
│   ├── config.js             # 配置读写（Cookie / 解析服务 / 清晰度）
│   ├── core/
│   │   ├── ytdlp.js          # yt-dlp 封装：探测 / 列剧集 / 下载
│   │   ├── resolver.js       # 剧集解析 + 集数完整性报告
│   │   ├── parser.js         # 第三方解析服务调用
│   │   ├── tasks.js          # 下载任务管理（进度、断点、错误）
│   │   └── zip.js            # 纯 Node ZIP 打包（store + ZIP64）
│   ├── platforms/            # 各平台适配器
│   │   ├── bilibili.js  iqiyi.js  mgtv.js  tencent.js  youku.js
│   │   └── searchlib.js      # Bing + 百度双引擎站点搜索
│   └── util/                 # http 工具 / WBI 签名 / JS 解析
├── web/                      # 前端（原生 HTML/CSS/JS，无构建步骤）
│   ├── index.html  app.js  styles.css
├── config/settings.json      # Cookie、第三方解析服务、下载目录
├── downloads/                # 下载缓存与 ZIP 产物
└── tools/install.sh  doctor.js
```

---

## 使用流程

1. **搜索**：输入剧名 → 选择平台 → 「搜索」。结果卡片显示平台、剧名与来源。
2. **查看全部剧集**：点击卡片 → 右侧抽屉解析分集。
   - 顶部是**集数完整性报告**，例如：
     `本部视频共39集 已找到的有1 2集 未找到的有3 4 5 … 39集`
   - 每集显示「可下载 / 未找到」与 VIP 标记，鼠标悬停可见原因。
3. **选择**：全选 / 反选 / 仅选未找到，或逐集点选。
4. **下载**：
   - 底部操作条 →「⬇ 下载所选」逐集下载，「📦 打包下载 ZIP」先下载全部再压成一个 ZIP。
   - 弹窗内实时显示每集进度、速度与失败原因。

---

## 没有会员，怎么把整部剧拿齐

工具不内置任何盗版源，但「全集」有四条正当路径，已全部实现：

| 路径 | 做法 | 效果 |
| --- | --- | --- |
| ① 平台免费/限免集 | 默认；爱奇艺走官方 `tmts` 接口换 m3u8 直链 | 免费集、限免集直接下 |
| ② 自己的账号 Cookie | 设置页粘贴**免费账号**的 Cookie | 账号能看（含限免、首播免费）的集全部可下 |
| ③ **跨平台补集** | 抽屉里点「🔍 去其它平台找替补」 | 自动到其它平台按**集号**对齐，找到同集的免费来源；还能识别「整段合集」（B 站常见 1-5、6-10 分段），一次覆盖多集 |
| ④ 你自己的第三方解析服务 | 设置页添加解析接口（`https://xxx/api?url={url}`） | 整部都要会员时自动走它 |

实测例子：爱奇艺《庆余年》46 集全部为 VIP（已找到 0 集），
跨平台补集在 B 站找到 10 个整段合集（1-5、6-10 … 41-54），**覆盖全部 46 集**，全部免费可下。

> 说明：跨平台补集只在「该集在别的平台确实免费可看」时才会出现，绝不会把付费内容当作免费来源。

## 会员（VIP）内容的三条路径

| 方案 | 做法 | 适用 |
| --- | --- | --- |
| ① 免费内容直连 | 默认 | 免费剧集；爱奇艺走官方 `tmts` 接口换取 m3u8 直链后下载 |
| ② 自己的会员账号 | 设置页粘贴**你自己账号**的 Cookie | 站内已购会员剧集 |
| ③ 第三方解析服务 | 设置页添加解析接口（模板 `https://xxx/api?url={url}`） | 整部都要会员且没有 Cookie 时自动启用 |

设置页可分别填写：

| 平台 | Cookie 示例 |
| --- | --- |
| 哔哩哔哩 | `SESSDATA=xxx; bili_jct=xxx` |
| 爱奇艺 | `QC005=xxx; __dfduid=xxx` |
| 芒果TV | `__dfduid=xxx; tvToken=xxx` |
| 腾讯视频 | `vqq_...` |
| 优酷 | 浏览器 Cookie |

第三方解析服务需要返回 JSON（`{"url":"https://…m3u8"}`）或包含 `.m3u8` / `.mp4` 直链的文本，程序会自动识别并交给 yt-dlp 下载。

---

## 跨系统保存行为

| 系统 | 行为 |
| --- | --- |
| Windows / macOS（Chrome / Edge） | 使用 File System Access API 弹出**系统「另存为」对话框**，自行选择保存路径 |
| Windows / macOS（Safari / Firefox） | 回退为浏览器默认下载（下载目录），并提示 |
| Android | 优先弹出「另存为」（可存到下载目录）；否则走默认下载并提示位置 |
| iOS / iPadOS | 弹出播放器窗口，**长按视频 → 存储到照片**；同时提供分享按钮（可存到「文件」或微信等） |

保存逻辑位于 `web/app.js` 的 `detectOS()` / `saveFromServer()`。

---

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 运行环境自检（Node / yt-dlp 版本） |
| GET | `/api/platforms` | 支持的平台列表 |
| GET | `/api/search?q=&platforms=` | 多平台聚合搜索 |
| GET | `/api/series?platform=&url=` | 解析分集 + 集数完整性报告（直连调试用） |
| POST | `/api/job` | 提交长耗时任务（`type: series \| cross`），返回 jobId |
| GET | `/api/job?jobId=` | 轮询任务状态，完成时带回完整结果 |
| POST | `/api/download` | 创建下载任务（`mode: files \| zip`） |
| GET | `/api/task?id=` | 查询任务进度 |
| GET | `/api/file?path=&name=` | 下载服务器上的成品文件 |
| GET/POST | `/api/config` | 读取 / 保存 Cookie、解析服务、清晰度 |

---

## 配置说明（`config/settings.json`）

```jsonc
{
  "cookies": { "bilibili": "", "iqiyi": "", "mgtv": "", "qq": "", "youku": "" },
  "parsers": [
    { "name": "我的解析服务", "url": "https://your-parser.example/api?url={url}", "enabled": true }
  ],
  "downloadDir": "./downloads",
  "quality": "best",          // best | 1080 | 720 | 480
  "mergeVideo": true,         // 需要 ffmpeg
  "concurrency": 2,
  "fallbackSearchEngine": "auto" // auto | baidu | bing
}
```

环境变量：`PORT`（默认 8787）、`HOST`（默认 0.0.0.0）、`YT_DLP_PATH`、`LOG_LEVEL`。

---

## 部署到服务器

项目是**全栈**的（后端要跑 yt-dlp / ffmpeg），必须部署在能直连各视频平台的 Linux 服务器上。提供三种方式，任选其一。

### 方式 A：一键脚本（推荐，无需 Docker）

```bash
# 上传项目到服务器后
sudo bash deploy/deploy.sh /opt/series-hunter 8787
```

脚本会自动完成：安装 Node.js 20 / yt-dlp / ffmpeg → 拷贝应用 → 注册 systemd 开机自启 → 放行防火墙端口 → 健康检查。

带域名 + HTTPS：

```bash
sudo DOMAIN=hunter.example.com ENABLE_HTTPS=yes EMAIL=you@example.com \
  bash deploy/deploy.sh /opt/series-hunter 8787
```

常用运维命令：

```bash
systemctl status series-hunter        # 状态
systemctl restart series-hunter       # 重启
tail -f /var/log/series-hunter.log    # 日志
ls -lh /opt/series-hunter/downloads   # 已下载文件
```

### 方式 B：Docker

```bash
docker compose up -d --build
docker compose logs -f
```

镜像基于 `node:20-bookworm-slim`，内置 yt-dlp 与 ffmpeg，视频落盘在 `./data/downloads`（compose 已挂载到容器 `/data/downloads`）。
`docker-compose.yml` 里 `CORS_ORIGIN` 可选，填前端域名即可支持前后端分离。

### 方式 C：前端放 CDN，后端放服务器（前后端分离）

后端按方式 A/B 部署后，把 `web/` 目录单独传到任意静态托管（CDN / 对象存储 / Nginx 静态目录），并修改 `web/config.js`：

```js
window.APP_CONFIG = { apiBase: 'https://hunter.example.com', showConnectPrompt: true };
```

后端需要允许该前端域名跨域：

```bash
CORS_ORIGIN=https://cdn.example.com   # 启动时设置；用 * 表示不限制
```

前端也支持运行期手动切换后端：连不上时会弹出「连接服务器」框，填入后端地址后保存在浏览器本地（`localStorage`）。
**后端部署好后不必重新发布前端**——点页面右上角「🔌 后端」填一次地址即可（对所有访问者生效则改 `web/config.js` 的 `apiBase` 后重新发布）。

### 保活脚本（本地跑 + 公网隧道时用）

```bash
bash deploy/keep-alive.sh --provider serveo --port 8787
```

它会持续保证后端进程与 SSH 隧道在线，隧道换地址后**自动把新地址写回 `web/config.js`**。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 8787 | 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `DOWNLOAD_DIR` | `./downloads` | 视频与 ZIP 落盘目录 |
| `CORS_ORIGIN` | 空 | 跨域白名单（前后端分离时必填） |
| `YT_DLP_PATH` | `yt-dlp` | yt-dlp 可执行文件路径 |
| `LOG_LEVEL` | info | debug / info / warn / error |

---

## 已知限制

- **区域限制 / 反爬**：B 站番剧页与视频页、腾讯视频剧集页、优酷剧集页对境外 IP 有区域校验或风控拦截（会返回 HTTP 412 / 出错啦 / 跳转验证页）。**国内网络成功率最高**；本项目的抓取逻辑已按境内网络调通，境外失败属于平台侧限制而非代码缺陷。
- **B 站番剧接口**：`pgc/view/web/season` 在境内可用，能拿到完整分集与大会员标记；境外返回区域提示页。
- **爱奇艺**：部分专辑页只直出预告片（正片列表由前端异步加载），此时总集数仍会给出，但分集会全部标记为「未找到」，可通过会员 Cookie 或第三方解析补全。
- **芒果TV**：剧集列表取自页面内嵌状态与「选集」接口，部分合集会混入花絮视频，已按标题过滤。
- **VIP 内容**：未配置会员 Cookie、也没有可用第三方解析服务时，相关剧集会如实标记为「未找到」，此时可用「跨平台补集」去找别的平台的免费来源。
- **优酷**：搜索走 `search.youku.com`（能拿到「共 N 集」），但剧集页有风控，境外 IP 常被拦；境内一般可解析。
- **长耗时操作走异步任务**：剧集解析与跨平台补集都通过 `POST /api/job` + 短轮询完成，避免反向代理/隧道按空闲超时切断长连接（实测走隧道时同步长请求会失败，改异步后 4~13 秒出结果）。
- ZIP 使用 store 方式打包（视频本已压缩），因此体积与源文件接近，速度很快。

---

## 常见问题

**下载一直失败？**
先看 `/api/health` 是否显示 yt-dlp 版本；再跑 `node tools/doctor.js`。若提示「未找到视频」，多半是平台区域限制或需要会员权限。

**想下载的剧在某个平台找不到？**
搜索走的是「官方接口 + 搜索引擎」双通道；若平台改了接口，可直接在 `server/platforms/<平台>.js` 里补一条解析规则，各平台适配器互相独立、互不影响。

**ZIP 太大怎么办？**
ZIP 任务会把整部剧先落到 `downloads/`，再打包；磁盘不足时可只选部分剧集，或清理 `downloads/` 后重下。
