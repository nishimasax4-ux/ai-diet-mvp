// 開発者向け: v41.1で追加した「有酸素の時間のワンタップ候補」の回帰テストです。
//   npx playwright test tests/cardio-minutes.spec.js
const { test, expect } = require('@playwright/test');
const path = require('path');
const APP = () => 'file://' + path.resolve(__dirname, '../index.html');

async function boot(page) {
  await page.goto(APP());
  for (let i = 0; i < 8; i++) {
    const f = page.locator('[data-ob-action="finish"]');
    if (await f.count()) { await f.click(); break; }
    const n = page.locator('[data-ob-action="next"]');
    if (await n.count()) { await n.click(); await page.waitForTimeout(30); } else break;
  }
  await page.waitForTimeout(120);
}
async function openCardio(page) {
  await page.locator('[data-tab="training"]').click();
  await page.waitForTimeout(150);
  await page.locator('[data-action="select-training-type"][data-val="cardio"]').click();
  await page.waitForTimeout(150);
}

test.describe('training-log v41.1 — 有酸素の時間のワンタップ入力', () => {
  test('15/30/45/60分の候補が表示される', async ({ page }) => {
    await boot(page);
    await openCardio(page);
    const labels = await page.locator('#minutes-quick-buttons .chip').allTextContents();
    expect(labels).toEqual(['15分', '30分', '45分', '60分']);
  });

  test('タップすると時間の入力欄に入り、選択状態になる', async ({ page }) => {
    await boot(page);
    await openCardio(page);
    await page.locator('[data-action="select-minutes"][data-val="30"]').click();
    await page.waitForTimeout(150);
    expect(await page.locator('#minutes-input').inputValue()).toBe('30');
    const cls = await page.locator('[data-action="select-minutes"][data-val="30"]').getAttribute('class');
    expect(cls).toContain('active');
  });

  test('タップした時間でそのまま記録できる', async ({ page }) => {
    await boot(page);
    await openCardio(page);
    await page.locator('[data-action="select-minutes"][data-val="45"]').click();
    await page.waitForTimeout(120);
    await page.locator('[data-action="add-training"]').click();
    await page.waitForTimeout(200);
    const rec = await page.evaluate(() => entries.find(e => e.type === 'cardio'));
    expect(rec).toBeTruthy();
    expect(rec.minutes).toBe(45);
  });

  test('候補にない時間は、これまでどおり直接入力できる', async ({ page }) => {
    await boot(page);
    await openCardio(page);
    await page.locator('#minutes-input').fill('22');
    await page.waitForTimeout(150);
    // 一致する候補がないので、どれも選択状態にならない
    const classes = await page.locator('#minutes-quick-buttons .chip').evaluateAll(
      els => els.map(e => e.className));
    expect(classes.some(c => c.includes('active'))).toBe(false);
    await page.locator('[data-action="add-training"]').click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => entries.find(e => e.type === 'cardio').minutes)).toBe(22);
  });

  test('自分で選んだ時間は、種目を切り替えても勝手に上書きされない', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      // 「バイク」には前回20分の記録がある、という状態を作る
      lastCardioMinutes = { 'バイク': 20 };
      saveState();
    });
    await openCardio(page);
    await page.locator('[data-action="select-minutes"][data-val="60"]').click();
    await page.waitForTimeout(120);
    await page.locator('[data-action="select-cardio"][data-val="バイク"]').click();
    await page.waitForTimeout(150);
    // 自分で60分を選んでいるので、前回値20分で上書きされない
    expect(await page.locator('#minutes-input').inputValue()).toBe('60');
  });

  test('未入力のときは、その種目の前回の時間が提案される', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => { lastCardioMinutes = { 'バイク': 20 }; saveState(); });
    await openCardio(page);
    await page.locator('[data-action="select-cardio"][data-val="バイク"]').click();
    await page.waitForTimeout(150);
    expect(await page.locator('#minutes-input').inputValue()).toBe('20');
  });
});
