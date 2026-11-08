/* 剧集猎人 · 前端运行时配置
 * 部署到 CDN/静态托管时，把这里改成你的后端地址即可：
 *   window.APP_CONFIG = { apiBase: 'https://3f938f948952c498-139-224-211-171.serveousercontent.com' };
 * 留空表示与页面同源（前后端同一个服务）。
 */
window.APP_CONFIG = {
  apiBase: 'https://3f938f948952c498-139-224-211-171.serveousercontent.com',
  // 连接不上后端时，是否弹出「连接服务器」引导框
  showConnectPrompt: true,
  // GitHub Codespaces 云主机（访问不到后端时可一键唤醒）
  codespace: 'psychic-garbanzo-7v4q5wr5x4j93r5wg',
  codespacePort: 8787,
};
