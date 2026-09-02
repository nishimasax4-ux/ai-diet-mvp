// 開発者向け: Playwrightの設定です。アプリの利用には不要です(無視して構いません)。
// この環境では Chromium が /opt/pw-browsers に用意済みのため、そこを直接指しています。
const fs = require('fs');
const candidates = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
];
const executablePath = candidates.find(p => fs.existsSync(p));
module.exports = {
  testDir: './tests',
  timeout: 30000,
  testIgnore: ['**/ai.test.js'],
  use: executablePath ? { launchOptions: { executablePath } } : {},
};
