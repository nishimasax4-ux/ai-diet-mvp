// 開発者向け: v39で追加した「🍳 今日のおすすめ食事」の回帰テストです。
// GitHub Pagesへの公開やアプリの利用には不要なファイルです(無視して構いません)。
//
// 実行方法(パソコン+Node.js環境が必要):
//   npm install -D @playwright/test
//   npx playwright test tests/mealplan.spec.js
const { test, expect } = require('@playwright/test');
const path = require('path');
// モックが「十分に新しいApps Script」を名乗るための版数。実際の版数を書くと、
// バージョンを上げるたびにテストが壊れるため、常に上回る値を使う。
const LATEST_VER = 'v999';

const APP = () => 'file://' + path.resolve(__dirname, '../index.html');

async function finishOnboarding(page) {
  for (let i = 0; i < 8; i++) {
    const finish = page.locator('[data-ob-action="finish"]');
    if (await finish.count()) { await finish.click(); break; }
    const next = page.locator('[data-ob-action="next"]');
    if (await next.count()) { await next.click(); await page.waitForTimeout(30); } else break;
  }
  await page.waitForTimeout(150);
}

// 目安カロリーが出せる最低限の状態(プロフィール+体重)を作る。
async function seedProfile(page) {
  await page.evaluate(() => {
    profile = { age: 40, gender: '男性', height: 170, activity: '週1-2回', lifestyle: DEFAULT_LIFESTYLE, timeAvail: '10-15分' };
    goals = { weight: 70, weeklyFreq: 3 };
    weightEntries.length = 0;
    weightEntries.push({ date: localDateStr(), weight: 75 });
    saveState();
  });
  await page.reload();
  await page.waitForTimeout(250);
}

test.describe('training-log v39 — おすすめ食事', () => {
  test('プロフィール未入力なら、まず入力を促す案内を出す', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await page.evaluate(() => { weightEntries.length = 0; saveState(); });
    await page.reload();
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => buildMealSuggestions())).toBeNull();
    await page.locator('[data-tab="today"]').click();
    await page.waitForTimeout(150);
    const html = await page.locator('#tab-content').innerHTML();
    expect(html).toContain('今日のおすすめ食事');
    expect(html).toContain('体重を記録すると');
  });

  test('朝食と夕食に、目安カロリーと候補が出る', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await seedProfile(page);

    const s = await page.evaluate(() => buildMealSuggestions());
    expect(s).not.toBeNull();
    expect(s.meals.map(m => m.mealType)).toEqual(['朝食', '夕食']);
    for (const m of s.meals) {
      expect(m.budget).toBeGreaterThan(0);
      expect(m.items.length).toBeGreaterThan(0);
      // 目安を大きく超える候補は出さない(30%増しまでを許容)
      for (const it of m.items) expect(it.kcal).toBeLessThanOrEqual(m.budget * 1.3);
    }
    // 夕食のほうが配分が大きい
    const [asa, yu] = s.meals;
    expect(yu.budget).toBeGreaterThan(asa.budget);

    await page.locator('[data-tab="today"]').click();
    await page.waitForTimeout(150);
    const html = await page.locator('#tab-content').innerHTML();
    expect(html).toContain('今日のおすすめ食事');
    expect(html).toContain('目安');
  });

  test('その区分で実際に食べている食品が上位に来る', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await seedProfile(page);
    await page.evaluate(() => {
      // 「納豆」を朝食として繰り返し記録しておく。
      for (let i = 1; i <= 5; i++) {
        mealEntries.push({ id: uid(), date: '2026-08-0' + i, mealType: '朝食', text: '納豆(1パック)',
                           calories: 100, protein: 8.3, fat: 5, carb: 6, createdAt: Date.now() });
      }
      saveState();
    });
    await page.reload();
    await page.waitForTimeout(250);
    const names = await page.evaluate(() => buildMealSuggestions().meals[0].items.map(i => i.name));
    expect(names).toContain('納豆(1パック)');
  });

  test('すでに食べた区分は「記録済み」になり、残りが別の区分へ回る', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await seedProfile(page);
    const before = await page.evaluate(() => buildMealSuggestions().meals[1].budget);
    await page.evaluate(() => {
      mealEntries.push({ id: uid(), date: localDateStr(), mealType: '朝食', text: 'トースト',
                         calories: 300, protein: 8, fat: 5, carb: 50, createdAt: Date.now() });
      saveState();
    });
    await page.reload();
    await page.waitForTimeout(250);
    const s = await page.evaluate(() => buildMealSuggestions());
    expect(s.meals[0].alreadyEaten).toBe(true);
    expect(s.meals[0].eaten).toBe(300);
    // 朝食を済ませたぶん、夕食の目安は増える(残りを未記録の区分だけで按分するため)
    expect(s.meals[1].budget).toBeGreaterThan(before);
  });

  test('候補をタップすると食事タブの入力欄に反映される(記録はされない)', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await seedProfile(page);
    await page.locator('[data-tab="today"]').click();
    await page.waitForTimeout(150);

    const countBefore = await page.evaluate(() => mealEntries.length);
    const first = page.locator('[data-action="use-meal-suggestion"]').first();
    const expected = await first.getAttribute('data-name');
    await first.click();
    await page.waitForTimeout(250);

    expect(await page.locator('#meal-name-input').inputValue()).toBe(expected);
    expect(await page.locator('#meal-cal-input').inputValue()).not.toBe('');
    // 本人が「＋ 記録する」を押すまで、記録は増えない
    expect(await page.evaluate(() => mealEntries.length)).toBe(countBefore);
  });

  test('AI相談ボタンは接続設定があるときだけ出て、mealPlanアクションを呼ぶ', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await seedProfile(page);
    await page.locator('[data-tab="today"]').click();
    await page.waitForTimeout(150);
    // 未接続なら出さない
    expect(await page.locator('[data-action="fetch-ai-mealplan"]').count()).toBe(0);

    let sentAction = null;
    await page.route('https://script.google.com/macros/**', (route, request) => {
      const body = JSON.parse(request.postData() || '{}');
      sentAction = body.action;
      const out = body.action === 'mealPlan'
        ? { status: 'ok', text: '朝食は納豆ご飯と味噌汁がおすすめです。夕食は鶏むね肉のソテーを。' }
        : { status: 'ok', payload: {}, lastWriteAt: null, written: 0 };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    });
    await page.evaluate(() => {
      gasConfig = { url: 'https://script.google.com/macros/s/fake/exec', token: 't', lastKnownWriteAt: null };
      saveConfig(); renderApp();
    });
    await page.locator('[data-tab="today"]').click();
    await page.waitForTimeout(150);
    await page.locator('[data-action="fetch-ai-mealplan"]').click();
    await page.waitForTimeout(600);

    expect(sentAction).toBe('mealPlan');
    expect(await page.locator('#tab-content').innerHTML()).toContain('鶏むね肉のソテー');
  });

  test('AIへ送る要約に、生の食事明細やトークンが混ざらない', async ({ page }) => {
    await page.goto(APP());
    await finishOnboarding(page);
    await seedProfile(page);
    const ctx = await page.evaluate(() => {
      gasConfig = { url: 'https://script.google.com/macros/s/fake/exec', token: 'SECRET-TOKEN', lastKnownWriteAt: null };
      mealEntries.push({ id: uid(), date: '2026-08-01', mealType: '朝食', text: '納豆', calories: 100, protein: 8, fat: 5, carb: 6, createdAt: Date.now() });
      return buildMealPlanContext();
    });
    const json = JSON.stringify(ctx);
    expect(json).not.toContain('SECRET-TOKEN');
    expect(json).not.toContain('createdAt');
    expect(ctx['今日の目安カロリー']).toBeGreaterThan(0);
    expect(ctx['よく食べている朝食']).toContain('納豆');
  });
});

test.describe('training-log v39.1 — AI接続状態の可視化', () => {
  test('Groq未設定なら、設定タブで原因と対処を案内する', async ({ page }) => {
    await page.route('https://script.google.com/macros/**', (route, request) => {
      const body = JSON.parse(request.postData() || '{}');
      const out = body.action === 'ping'
        ? { status: 'ok', backendVersion: LATEST_VER, ai: { gemini: true, groq: false } }
        : { status: 'ok', payload: {}, lastWriteAt: null, written: 0 };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    });
    await page.goto('file://' + require('path').resolve(__dirname, '../index.html'));
    for (let i = 0; i < 8; i++) {
      const f = page.locator('[data-ob-action="finish"]');
      if (await f.count()) { await f.click(); break; }
      const n = page.locator('[data-ob-action="next"]');
      if (await n.count()) { await n.click(); await page.waitForTimeout(30); } else break;
    }
    await page.locator('[data-tab="settings"]').click();
    await page.locator('#gas-url-input').fill('https://script.google.com/macros/s/fake/exec');
    await page.locator('#gas-token-input').fill('t');
    await page.locator('[data-action="save-gas-config"]').click();
    await page.waitForTimeout(700);

    const html = await page.locator('#tab-content').innerHTML();
    expect(html).toContain('AI接続の状態');
    expect(html).toContain('GROQ_API_KEY');
    expect(html).toContain('45秒待っても応答がありませんでした');
  });

  test('Groq設定済みなら、警告ではなく状態表示だけになる', async ({ page }) => {
    await page.route('https://script.google.com/macros/**', (route, request) => {
      const body = JSON.parse(request.postData() || '{}');
      const out = body.action === 'ping'
        ? { status: 'ok', backendVersion: LATEST_VER, ai: { gemini: true, groq: true } }
        : { status: 'ok', payload: {}, lastWriteAt: null, written: 0 };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    });
    await page.goto('file://' + require('path').resolve(__dirname, '../index.html'));
    for (let i = 0; i < 8; i++) {
      const f = page.locator('[data-ob-action="finish"]');
      if (await f.count()) { await f.click(); break; }
      const n = page.locator('[data-ob-action="next"]');
      if (await n.count()) { await n.click(); await page.waitForTimeout(30); } else break;
    }
    await page.locator('[data-tab="settings"]').click();
    await page.locator('#gas-url-input').fill('https://script.google.com/macros/s/fake/exec');
    await page.locator('#gas-token-input').fill('t');
    await page.locator('[data-action="save-gas-config"]').click();
    await page.waitForTimeout(700);

    const html = await page.locator('#tab-content').innerHTML();
    expect(html).toContain('AI接続の状態');
    expect(html).toContain('設定済み');
    expect(html).not.toContain('45秒待っても応答がありませんでした');
  });
});

test.describe('training-log v42 — 候補の多様化とAI提案の統合', () => {
  async function ready(page) {
    await page.goto('file://' + require('path').resolve(__dirname, '../index.html'));
    await finishOnboarding(page);
    await seedProfile(page);
  }

  test('「いつもの」だけでなく「新しく試すなら」も提案される', async ({ page }) => {
    await ready(page);
    // 朝食に納豆ばかり食べている状態を作る
    await page.evaluate(() => {
      for (let i = 1; i <= 6; i++) {
        mealEntries.push({ id: uid(), date: '2026-08-0' + i, mealType: '朝食', text: '納豆(1パック)',
                           calories: 100, protein: 8.3, fat: 5, carb: 6, createdAt: Date.now() });
      }
      mealMaster.push({ id: uid(), name: '納豆(1パック)', calories: 100, protein: 8.3, fat: 5, carb: 6 });
      saveState();
    });
    await page.reload();
    await page.waitForTimeout(250);

    const asa = await page.evaluate(() => buildMealSuggestions().meals[0]);
    expect(asa.familiar.length).toBeGreaterThan(0);
    expect(asa.fresh.length).toBeGreaterThan(0);
    // 「新しく試すなら」には、登録済み・朝食での実績があるものは出さない
    const familiarNames = asa.familiar.map(f => f.name);
    for (const f of asa.fresh) {
      expect(familiarNames).not.toContain(f.name);
      expect(f.own).toBeFalsy();
    }
    await page.locator('[data-tab="today"]').click();
    await page.waitForTimeout(200);
    const html = await page.locator('#tab-content').innerHTML();
    expect(html).toContain('いつもの');
    expect(html).toContain('新しく試すなら');
  });

  test('登録が一件も無くても、内蔵の食品辞書から候補が出る', async ({ page }) => {
    await ready(page);
    const asa = await page.evaluate(() => buildMealSuggestions().meals[0]);
    expect(asa.items.length).toBeGreaterThan(0);
    expect(asa.fresh.length).toBeGreaterThan(0);
  });

  test('AIの提案がタップできる一覧として表示され、文章の重複表示はしない', async ({ page }) => {
    await page.route('https://script.google.com/macros/**', (route, request) => {
      const body = JSON.parse(request.postData() || '{}');
      const out = body.action === 'mealPlan'
        ? { status: 'ok', text: '{"meals":[...]}', plan: [
            { mealType: '朝食', comment: 'たんぱく質を確保できます',
              items: [{ name: '納豆ご飯と味噌汁', kcal: 380, protein: 16, fat: 7, carb: 62 }] },
            { mealType: '夕食', comment: '脂質控えめです',
              items: [{ name: '鶏むね肉のソテーと温野菜', kcal: 520, protein: 42, fat: 14, carb: 48 }] },
          ] }
        : { status: 'ok', payload: {}, lastWriteAt: null, written: 0 };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    });
    await ready(page);
    await page.evaluate(() => {
      gasConfig = { url: 'https://script.google.com/macros/s/fake/exec', token: 't', lastKnownWriteAt: null };
      saveConfig(); renderApp();
    });
    await page.locator('[data-tab="today"]').click();
    await page.waitForTimeout(150);
    await page.locator('[data-action="fetch-ai-mealplan"]').click();
    await page.waitForTimeout(600);

    const html = await page.locator('#tab-content').innerHTML();
    expect(html).toContain('AIの提案');
    expect(html).toContain('納豆ご飯と味噌汁');
    expect(html).toContain('鶏むね肉のソテーと温野菜');
    expect(html).not.toContain('{"meals"');   // 生のJSONを文章として出さない

    // AIの提案もタップして食事タブに反映できる
    await page.locator('[data-action="use-meal-suggestion"][data-name="納豆ご飯と味噌汁"]').click();
    await page.waitForTimeout(250);
    expect(await page.locator('#meal-name-input').inputValue()).toBe('納豆ご飯と味噌汁');
    expect(await page.locator('#meal-cal-input').inputValue()).toBe('380');
  });

  test('古いApps Script(文章だけ返す)でも、これまでどおり文章で表示される', async ({ page }) => {
    await page.route('https://script.google.com/macros/**', (route, request) => {
      const body = JSON.parse(request.postData() || '{}');
      const out = body.action === 'mealPlan'
        ? { status: 'ok', text: '朝食は納豆ご飯がおすすめです。' }   // planなし
        : { status: 'ok', payload: {}, lastWriteAt: null, written: 0 };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    });
    await ready(page);
    await page.evaluate(() => {
      gasConfig = { url: 'https://script.google.com/macros/s/fake/exec', token: 't', lastKnownWriteAt: null };
      saveConfig(); renderApp();
    });
    await page.locator('[data-tab="today"]').click();
    await page.waitForTimeout(150);
    await page.locator('[data-action="fetch-ai-mealplan"]').click();
    await page.waitForTimeout(600);
    expect(await page.locator('#tab-content').innerHTML()).toContain('朝食は納豆ご飯がおすすめです。');
  });
});
