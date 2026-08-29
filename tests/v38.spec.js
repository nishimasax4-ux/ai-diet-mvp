// 開発者向け: v38で追加・変更した挙動の回帰テストです。
// GitHub Pagesへの公開やアプリの利用には不要なファイルです(無視して構いません)。
//
// 実行方法(パソコン+Node.js環境が必要):
//   npm install -D @playwright/test
//   npx playwright test tests/v38.spec.js
//
// 実際のApps Scriptへは接続せず、page.route()で save/load/advice などを
// インメモリのモックに差し替えて検証します。
const { test, expect } = require('@playwright/test');
const path = require('path');

const APP = () => 'file://' + path.resolve(__dirname, '../index.html');

// v37系(このアプリと対になる)Apps Scriptのふるまいを模したモック。
function routeCorrectBackend(target) {
  return target.route('https://script.google.com/macros/**', (route, request) => {
    const body = JSON.parse(request.postData() || '{}');
    let out;
    if (body.action === 'ping') out = { status: 'ok', backendVersion: 'v38' };
    else if (body.action === 'save' || !body.action) out = { status: 'ok', written: 0, at: new Date().toISOString(), lastWriteAt: new Date().toISOString() };
    else if (body.action === 'load') out = { status: 'ok', payload: {}, lastWriteAt: null };
    else if (body.action === 'advice') out = { status: 'ok', text: 'よく続いています。' };
    else out = { status: 'error', message: '不明なaction: ' + body.action };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
}

async function finishOnboarding(page) {
  for (let i = 0; i < 8; i++) {
    const finish = page.locator('[data-ob-action="finish"]');
    if (await finish.count()) { await finish.click(); break; }
    const next = page.locator('[data-ob-action="next"]');
    if (await next.count()) { await next.click(); await page.waitForTimeout(30); } else break;
  }
  await page.waitForTimeout(150);
}

async function connect(page) {
  await page.locator('[data-tab="settings"]').click();
  await page.locator('#gas-url-input').fill('https://script.google.com/macros/s/fake/exec');
  await page.locator('#gas-token-input').fill('test-token');
  await page.locator('[data-action="save-gas-config"]').click();
  await page.waitForTimeout(500);
}

test.describe('training-log v38', () => {
  test('the app still loads and syncs against the matching v37-style backend', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message)));
    await routeCorrectBackend(page);
    await page.goto(APP());
    await finishOnboarding(page);
    await connect(page);
    expect(errors).toEqual([]);
    expect(await page.locator('#sync-status').innerText()).toContain('同期');
  });

  test('a mismatched (v2 differential-sync) backend is detected and explained', async ({ page }) => {
    // 差分同期版のapps-script.gsは save を知らないため「不明なaction: save」を返す。
    // 以前はこれが「同期エラー」としか出ず、原因が分からなかった。
    await page.route('https://script.google.com/macros/**', (route, request) => {
      const body = JSON.parse(request.postData() || '{}');
      const known = ['syncPush', 'syncPull', 'setSecret', 'getSecretStatus'];
      const out = known.includes(body.action)
        ? { status: 'ok' }
        : { status: 'error', message: '不明なaction: ' + body.action };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    });
    await page.goto(APP());
    await finishOnboarding(page);
    await connect(page);
    await page.waitForTimeout(600);

    expect(await page.evaluate(() => backendMismatch)).toBe(true);
    await page.locator('[data-tab="settings"]').click();
    await page.waitForTimeout(150);
    expect(await page.locator('#tab-content').innerHTML()).toContain('対になっていません');
  });

  test('a hanging backend times out with a readable message, not "Load failed"', async ({ page }) => {
    // 応答を返さないバックエンド = 以前「Load failed」になっていた状況。
    await page.route('https://script.google.com/macros/**', () => { /* never fulfil */ });
    await page.goto(APP());
    await finishOnboarding(page);
    const msg = await page.evaluate(async () => {
      gasConfig = { url: 'https://script.google.com/macros/s/fake/exec', token: 't', lastKnownWriteAt: null };
      try { await gasPost({ action: 'advice' }, 1500); return 'NO_ERROR'; }
      catch (e) { return e.message; }
    });
    expect(msg).toContain('応答がありませんでした');
    expect(msg).not.toContain('Load failed');
  });

  test('cardio defaults to the most-used exercise, not always ランニング', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    expect(await page.evaluate(() => selectedCardio)).toBe('ランニング');
    await page.evaluate(() => {
      const mk = (ex, d) => ({ id: uid(), type: 'cardio', date: d, exercise: ex, minutes: 20, createdAt: Date.now() });
      entries.push(mk('バイク', '2026-08-01'), mk('バイク', '2026-08-02'), mk('ランニング', '2026-08-03'));
      saveState();
    });
    await page.reload();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => selectedCardio)).toBe('バイク');
  });

  test('cumulative calories show in the app and in the X post text', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await page.evaluate(() => {
      const today = localDateStr();
      weightEntries.push({ date: today, weight: 75 });
      mealEntries.push({ id: uid(), date: today, mealType: '朝食', text: 'テスト', calories: 1800, protein: 0, fat: 0, carb: 0, createdAt: Date.now() });
      saveState();
    });
    await page.reload();
    await page.waitForTimeout(300);

    const totals = await page.evaluate(() => computeCalorieTotals());
    expect(totals).not.toBeNull();
    expect(totals.intake).toBe(1800);
    expect(totals.days).toBe(1);
    expect(totals.balance).toBe(totals.intake - totals.burn);

    await page.locator('[data-tab="today"]').click();
    await page.waitForTimeout(200);
    expect(await page.locator('#tab-content').innerHTML()).toContain('カロリーの累計');

    const text = await page.evaluate(() => buildXShareText());
    expect(text).toContain('今日: 摂取');
    expect(text).toContain('累計収支');
    expect(text.length).toBeLessThanOrEqual(280);
  });

  test('the X post falls back to the weight-only text when it would get too long', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    const short = await page.evaluate(() => {
      // 体重を1件だけにして、カロリーも未入力にすると従来どおりの短い文面になる。
      weightEntries.length = 0;
      weightEntries.push({ date: localDateStr(), weight: 75 });
      mealEntries.length = 0;
      return buildXShareText();
    });
    expect(short).toContain('体重: 75kg');
    expect(short).not.toContain('累計収支');
  });
});
