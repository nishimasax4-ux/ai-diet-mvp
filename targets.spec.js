// 開発者向け: v40で作り直した「1日の目安カロリー・PFC」の回帰テストです。
// GitHub Pagesへの公開やアプリの利用には不要なファイルです(無視して構いません)。
//
//   npx playwright test tests/targets.spec.js
const { test, expect } = require('@playwright/test');
const path = require('path');

const APP = () => 'file://' + path.resolve(__dirname, '../index.html');

async function finishOnboarding(page) {
  for (let i = 0; i < 8; i++) {
    const f = page.locator('[data-ob-action="finish"]');
    if (await f.count()) { await f.click(); break; }
    const n = page.locator('[data-ob-action="next"]');
    if (await n.count()) { await n.click(); await page.waitForTimeout(30); } else break;
  }
  await page.waitForTimeout(150);
}

// 診断で使った代表例と同じ条件を作る: 40歳男性170cm、80kg→目標70kg、デスクワーク。
async function seed(page, { weight = 80, goal = 70, pace = 0.5, lifestyle = 'デスクワーク中心', gender = '男性', age = 40, height = 170 } = {}) {
  await page.evaluate(({ weight, goal, pace, lifestyle, gender, age, height }) => {
    profile = { age, gender, height, activity: '週1-2回', lifestyle, timeAvail: '10-15分' };
    goals = { weight: goal, weeklyFreq: 3, paceKgPerWeek: pace };
    weightEntries.length = 0;
    weightEntries.push({ date: localDateStr(), weight });
    saveState();
  }, { weight, goal, pace, lifestyle, gender, age, height });
  await page.reload();
  await page.waitForTimeout(250);
}

test.describe('training-log v40 — 目安カロリーとPFC', () => {
  test('赤字が下限に黙って打ち消されない(v39までの不具合)', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await seed(page, { pace: 0.5 });
    const t = await page.evaluate(() => getTargets());

    // 0.5kg/週 = 7200*0.5/7 ≒ 514kcal/日 が「必要な赤字」
    expect(t.needDeficit).toBe(Math.round(0.5 * 7200 / 7));
    // 目安カロリーは基礎代謝を下回らない(安全のための下限)
    expect(t.targetCalories).toBeGreaterThanOrEqual(t.bmr);
    // 下限に当たったことを隠さず、足りない分を運動で補う量として返す
    expect(t.floored).toBe(true);
    expect(t.actualDeficit).toBe(t.tdee - t.targetCalories);
    expect(t.gapByExercise).toBe(t.needDeficit - t.actualDeficit);
    // v39までは実際の赤字が251kcalしかなかった。改善していること。
    expect(t.actualDeficit).toBeGreaterThan(300);
  });

  test('ゆっくりペースなら食事だけで目標ペースに届く', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await seed(page, { pace: 0.25 });
    const t = await page.evaluate(() => getTargets());
    expect(t.floored).toBe(false);
    expect(t.gapByExercise).toBe(0);
    expect(t.actualDeficit).toBeGreaterThanOrEqual(t.needDeficit - 5); // 10kcal丸めの範囲
  });

  test('活動量が多ければ、標準ペースでも食事だけで届く', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await seed(page, { pace: 0.5, lifestyle: 'よく歩く・立ち仕事' });
    const t = await page.evaluate(() => getTargets());
    expect(t.floored).toBe(false);
    expect(t.gapByExercise).toBe(0);
  });

  test('目標体重に到達していれば維持(赤字ゼロ)になる', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await seed(page, { weight: 70, goal: 70 });
    const t = await page.evaluate(() => getTargets());
    expect(t.direction).toBe('keep');
    expect(t.needDeficit).toBe(0);
    expect(t.targetCalories).toBe(Math.round(t.tdee / 10) * 10);
  });

  test('目標より軽ければ増量方向になる', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await seed(page, { weight: 65, goal: 70 });
    const t = await page.evaluate(() => getTargets());
    expect(t.direction).toBe('gain');
    expect(t.needDeficit).toBeLessThan(0);
    expect(t.targetCalories).toBeGreaterThan(t.tdee);
  });

  test('たんぱく質は目標体重×1.6g、脂質には下限がある', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await seed(page, { weight: 80, goal: 70 });
    const t = await page.evaluate(() => getTargets());
    expect(t.targetProtein).toBe(Math.round(70 * 1.6));   // 現体重80ではなく目標体重70が基準
    expect(t.targetFat).toBeGreaterThanOrEqual(Math.round(70 * 0.8));
    expect(t.targetCarb).toBeGreaterThan(0);
    // PFCの合計が目安カロリーとおおよそ一致する(丸め誤差の範囲)
    const sum = t.targetProtein * 4 + t.targetFat * 9 + t.targetCarb * 4;
    expect(Math.abs(sum - t.targetCalories)).toBeLessThanOrEqual(12);
  });

  test('%エネルギーを計算でき、脂質・炭水化物は基準の範囲から大きく外れない', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await seed(page, { weight: 80, goal: 70 });
    const mp = await page.evaluate(() => macroPercents(getTargets()));
    expect(mp.fat).toBeGreaterThanOrEqual(20);
    expect(mp.fat).toBeLessThanOrEqual(32);
    expect(mp.protein).toBeGreaterThan(20);   // 筋肉維持優先なので基準上限は超える(意図どおり)
    expect(Math.round(mp.protein + mp.fat + mp.carb)).toBeGreaterThanOrEqual(98);
  });

  test('炭水化物が0になる極端な組み合わせでも破綻しない', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    // 目標体重が非常に重く、目安カロリーが低くなる極端な条件
    await seed(page, { weight: 120, goal: 115, pace: 0.5, gender: '女性', age: 60, height: 150 });
    const t = await page.evaluate(() => getTargets());
    expect(t.targetCarb).toBeGreaterThan(0);
    expect(t.targetProtein).toBeGreaterThan(0);
    expect(t.targetFat).toBeGreaterThan(0);
    expect(t.targetProtein * 4 + t.targetFat * 9).toBeLessThan(t.targetCalories);
  });

  test('設定タブにペース選択と内訳が表示され、切り替えると数値が変わる', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await seed(page, { pace: 0.5 });
    await page.locator('[data-tab="settings"]').click();
    await page.waitForTimeout(200);

    let html = await page.locator('#tab-content').innerHTML();
    expect(html).toContain('減量ペース');
    expect(html).toContain('目安カロリーの内訳');
    expect(html).toContain('基礎代謝');
    expect(html).toContain('運動で補う');      // 標準ペースでは下限に当たるので案内が出る

    const before = await page.evaluate(() => getTargets().targetCalories);
    await page.locator('[data-action="set-pace"][data-val="0.25"]').click();
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => getTargets().targetCalories);
    expect(after).toBeGreaterThan(before);     // ゆっくりにすると目安カロリーは増える

    html = await page.locator('#tab-content').innerHTML();
    expect(html).not.toContain('運動で補う');  // 食事だけで届くので警告は消える
    expect(html).toContain('食事摂取基準');
  });
});

test.describe('training-log v40.1 — 入力欄のレイアウト', () => {
  // 体重タブで、日付欄が体重欄に重なる不具合(flexの子が min-width:auto で縮まないのが原因)
  for (const width of [320, 360, 375, 390, 430]) {
    test(`体重フォームの日付欄と体重欄が重ならない(幅${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('file://' + require('path').resolve(__dirname, '../index.html'));
      for (let i = 0; i < 8; i++) {
        const f = page.locator('[data-ob-action="finish"]');
        if (await f.count()) { await f.click(); break; }
        const n = page.locator('[data-ob-action="next"]');
        if (await n.count()) { await n.click(); await page.waitForTimeout(30); } else break;
      }
      await page.locator('[data-tab="weight"]').click();
      await page.waitForTimeout(200);

      const m = await page.evaluate(() => {
        const d = document.getElementById('weight-date-input').getBoundingClientRect();
        const v = document.getElementById('weight-value-input').getBoundingClientRect();
        const row = document.getElementById('weight-date-input').closest('.field-row').getBoundingClientRect();
        const sameRow = Math.abs(d.top - v.top) < 4;
        return {
          overlap: sameRow && d.right > v.left + 0.5,           // 同じ行にいるのに重なっている
          overflow: Math.max(d.right, v.right) > row.right + 0.5, // 親からはみ出している
          sameRow, dateW: d.width, valW: v.width,
        };
      });
      expect(m.overlap).toBe(false);
      expect(m.overflow).toBe(false);
      // 横並びのままなら、どちらの欄も操作できる幅を保っていること
      if (m.sameRow) {
        expect(m.dateW).toBeGreaterThanOrEqual(110);
        expect(m.valW).toBeGreaterThanOrEqual(100);
      }
    });
  }
});
