/* 剧集猎人 · 前端运行时配置
 * 部署到 CDN/静态托管时，把这里改成你的后端地址即可：
 *   window.APP_CONFIG = { apiBase: 'https://e7a1c62478c90f91-207-46-224-87.serveousercontent.com' };
 * 留空表示与页面同源（前后端同一个服务）。
 */
window.APP_CONFIG = {
  apiBase: 'https://e7a1c62478c90f91-207-46-224-87.serveousercontent.com',
  // 连接不上后端时，是否弹出「连接服务器」引导框
  showConnectPrompt: true,
  // 「地址簿」：前端运行时从这里读取最新后端地址（隧道换了也不用重新发布前端）
  //   公开 gist：https://gist.githubusercontent.com/<user>/<id>/raw/tunnel.json
  //   公开仓库：https://raw.githubusercontent.com/<user>/<repo>/main/web/tunnel.json
  resolverUrl: 'https://raw.githubusercontent.com/linxunk/series-hunter/main/web/tunnel.json',
  // GitHub Codespaces 云主机（访问不到后端时可一键唤醒）
  codespace: 'upgraded-space-lamp-q7gr4694xg6pf4x5v',
  codespacePort: 8787,
};
