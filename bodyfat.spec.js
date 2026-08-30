// 開発者向け: v41で追加した体脂肪率まわりの回帰テストです。
//   npx playwright test tests/bodyfat.spec.js
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
// 実際のご本人の条件: 168cm / 78kg / 48歳 / 男性 / 体脂肪率29%
async function seed(page, entries) {
  await page.evaluate((entries) => {
    profile = { age: 48, gender: '男性', height: 168, activity: '週1-2回', lifestyle: 'デスクワーク中心', timeAvail: '10-15分' };
    goals = { weight: 70, weeklyFreq: 3, paceKgPerWeek: 0.25 };
    weightEntries.length = 0;
    entries.forEach(e => weightEntries.push(e));
    saveState();
  }, entries);
  await page.reload();
  await page.waitForTimeout(220);
}
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test.describe('training-log v41 — 体脂肪率', () => {
  test('体脂肪率が無ければ従来どおりMifflin-St Jeorで計算する', async ({ page }) => {
    await boot(page);
    await seed(page, [{ date: today(), weight: 78 }]);
    const t = await page.evaluate(() => getTargets());
    expect(t.bmrMethod).toBe('mifflin');
    expect(t.bmr).toBe(1595);          // 10*78 + 6.25*168 - 5*48 + 5
    expect(t.bodyFat).toBeNull();
    expect(t.targetProtein).toBe(Math.round(70 * 1.6));
  });

  test('体脂肪率を記録するとKatch-McArdleに切り替わる', async ({ page }) => {
    await boot(page);
    await seed(page, [{ date: today(), weight: 78, bodyFat: 29 }]);
    const t = await page.evaluate(() => getTargets());
    expect(t.bmrMethod).toBe('katch');
    expect(t.bodyFat).toBe(29);
    expect(t.leanMass).toBeCloseTo(55.4, 1);
    expect(t.fatMass).toBeCloseTo(22.6, 1);
    expect(t.bmr).toBe(Math.round(370 + 21.6 * 78 * 0.71));   // 1566
    expect(t.bmrMifflin).toBe(1595);
    // たんぱく質は除脂肪体重基準になる
    expect(t.targetProtein).toBe(Math.round(78 * 0.71 * 2.0));
  });

  test('1回の測定のブレをそのまま反映せず、直近3件の平均を使う', async ({ page }) => {
    await boot(page);
    // 直近が28.0 / 29.0 / 30.0 → 平均29.0。最新の28.0だけを使っていないこと。
    await seed(page, [
      { date: daysAgo(10), weight: 78, bodyFat: 30 },
      { date: daysAgo(5),  weight: 78, bodyFat: 29 },
      { date: today(),     weight: 78, bodyFat: 28 },
    ]);
    const t = await page.evaluate(() => getTargets());
    expect(t.bodyFat).toBe(29);
  });

  test('古すぎる記録は計算に使わない', async ({ page }) => {
    await boot(page);
    await seed(page, [
      { date: daysAgo(200), weight: 78, bodyFat: 40 },   // 60日より前 → 無視
      { date: today(),      weight: 78, bodyFat: 29 },
    ]);
    const t = await page.evaluate(() => getTargets());
    expect(t.bodyFat).toBe(29);
  });

  test('入力ミスのような値は無視して、目標カロリーを壊さない', async ({ page }) => {
    await boot(page);
    // 29 を 2.9 と打ち間違えた場合。採用すると基礎代謝が跳ね上がってしまう。
    await seed(page, [{ date: today(), weight: 78, bodyFat: 2.9 }]);
    const t = await page.evaluate(() => getTargets());
    expect(t.bmrMethod).toBe('mifflin');
    expect(t.bodyFat).toBeNull();
  });

  test('フォームから体脂肪率を記録でき、範囲外はそのまま無視される', async ({ page }) => {
    await boot(page);
    await seed(page, [{ date: today(), weight: 78 }]);
    await page.locator('[data-tab="weight"]').click();
    await page.waitForTimeout(150);
    await page.locator('#weight-value-input').fill('77.5');
    await page.locator('#weight-bodyfat-input').fill('28.6');
    await page.locator('[data-action="add-weight"]').click();
    await page.waitForTimeout(200);
    let rec = await page.evaluate(() => weightEntries.find(w => w.date === localDateStr()));
    expect(rec.weight).toBe(77.5);
    expect(rec.bodyFat).toBe(28.6);

    // 範囲外(999%)は保存しない
    await page.locator('#weight-value-input').fill('77.5');
    await page.locator('#weight-bodyfat-input').fill('999');
    await page.locator('[data-action="add-weight"]').click();
    await page.waitForTimeout(200);
    rec = await page.evaluate(() => weightEntries.find(w => w.date === localDateStr()));
    expect(rec.bodyFat).toBeUndefined();
  });

  test('体組成カードに、減った分の脂肪の割合が出る', async ({ page }) => {
    await boot(page);
    await seed(page, [
      { date: daysAgo(40), weight: 80, bodyFat: 31 },   // 脂肪24.8 / 除脂肪55.2
      { date: today(),     weight: 78, bodyFat: 29 },   // 脂肪22.6 / 除脂肪55.4
    ]);
    await page.locator('[data-tab="weight"]').click();
    await page.waitForTimeout(200);
    const html = await page.locator('#tab-content').innerHTML();
    expect(html).toContain('体組成');
    expect(html).toContain('除脂肪体重');
    expect(html).toContain('が体脂肪');   // 減った分のうち脂肪が占める割合
  });

  test('同期の体重シートに体脂肪率の列が入り、復元でも戻る', async ({ page }) => {
    await boot(page);
    await seed(page, [{ date: today(), weight: 78, bodyFat: 29 }]);
    const payload = await page.evaluate(() => buildPayload());
    expect(payload['体重'].header).toContain('体脂肪率%');
    expect(payload['体重'].rows[0]).toEqual([today(), 78, 29]);

    // 体脂肪率の列が無い古いシートから復元しても壊れない(未記録扱いになる)
    const restored = await page.evaluate(() => {
      applyPayload({ '体重': { header: ['日付','体重kg'], rows: [[localDateStr(), 78]] } });
      return weightEntries[0];
    });
    expect(restored.weight).toBe(78);
    expect(restored.bodyFat).toBeUndefined();
  });

  test('設定タブの内訳に、どちらの式を使ったかが明記される', async ({ page }) => {
    await boot(page);
    await seed(page, [{ date: today(), weight: 78, bodyFat: 29 }]);
    await page.locator('[data-tab="settings"]').click();
    await page.waitForTimeout(250);
    const html = await page.locator('#tab-content').innerHTML();
    expect(html).toContain('Katch-McArdle');
    expect(html).toContain('除脂肪体重');
    expect(html).toContain('1595');   // 体脂肪率を使わない場合の値も併記
  });
});
