/* 剧集猎人 · 前端运行时配置
 * 部署到 CDN/静态托管时，把这里改成你的后端地址即可：
 *   window.APP_CONFIG = { apiBase: 'https://ca09d844a835062d-47-100-94-83.serveousercontent.com' };
 * 留空表示与页面同源（前后端同一个服务）。
 */
window.APP_CONFIG = {
  apiBase: 'https://ca09d844a835062d-47-100-94-83.serveousercontent.com',
  // 连接不上后端时，是否弹出「连接服务器」引导框
  showConnectPrompt: true,
  // GitHub Codespaces 云主机（访问不到后端时可一键唤醒）
  codespace: 'upgraded-space-lamp-q7gr4694xg6pf4x5v',
  codespacePort: 8787,
};
