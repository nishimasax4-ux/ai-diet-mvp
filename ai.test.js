// v38.1のAI呼び出しロジックを、実際のGemini/Groqへ接続せずに検証する。
// apps-script.gs の本物のソースを vm で読み込み、UrlFetchApp 等だけを差し替える。
const fs = require('fs');
const vm = require('vm');

const path = require('path');
// 実行方法(パソコン+Node.js環境が必要): node tests/ai.test.js
const SRC = fs.readFileSync(path.resolve(__dirname, '../apps-script.gs'), 'utf8');

function makeCtx({ props = {}, handler }) {
  const calls = [];
  const ctx = {
    console,
    JSON, Math, String, Number, Object, Array, Date, Error, RegExp, isNaN, parseInt, parseFloat,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; },
      }),
    },
    Utilities: { sleep: () => {}, formatDate: () => '' },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    UrlFetchApp: {
      fetch: (url, options) => {
        const payload = JSON.parse(options.payload);
        const call = { url, payload, options };
        calls.push(call);
        const r = handler(call, calls.length);
        return { getResponseCode: () => r.code, getContentText: () => r.body };
      },
    },
    ContentService: { createTextOutput: (t) => ({ setMimeType: () => t }), MimeType: { JSON: 'json' } },
    SpreadsheetApp: {}, LockService: {},
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, calls, props };
}

const ok = (text) => ({ code: 200, body: JSON.stringify({ choices: [{ message: { content: text } }], candidates: [{ content: { parts: [{ text }] } }] }) });
const thinkingLevelError = {
  code: 400,
  body: JSON.stringify({ error: { code: 400, message: 'Thinking level MINIMAL is not supported for this model.', status: 'INVALID_ARGUMENT' } }),
};

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log('OK: ' + name); pass++; }
  else { console.log('NG: ' + name + (extra ? '  → ' + extra : '')); fail++; }
}

// 1) gemini-3.x には thinkingLevel:'low' を送る。
//    'minimal' は一部モデルが非対応でHTTP 400になるため使わない。
//    また「思考」を抑えないと応答が数十秒かかり、ブラウザ側が45秒で時間切れになる。
{
  const { ctx, calls } = makeCtx({ props: { GEMINI_API_KEY: 'g' }, handler: () => ok('1') });
  const out = ctx.callAi_('test', 512, ['gemini-3.7-flash']);
  const tc = calls[0].payload.generationConfig.thinkingConfig;
  check("gemini-3.x には thinkingLevel:'low' を送る", tc && tc.thinkingLevel === 'low', JSON.stringify(tc));
  check("'minimal' は送らない(非対応モデルがあるため)", JSON.stringify(calls[0].payload).indexOf('minimal') === -1);
  check('受け付けられれば1回の呼び出しで済む(無駄な再試行をしない)', calls.length === 1 && out === '1', 'calls=' + calls.length);
}

// 1b) それでも400が返るモデルなら、指定を外して自力で復帰する(将来の仕様変更への保険)
{
  const { ctx, calls } = makeCtx({
    props: { GEMINI_API_KEY: 'g' },
    handler: (c) => (c.payload.generationConfig.thinkingConfig ? thinkingLevelError : ok('1')),
  });
  const out = ctx.callAi_('test', 512, ['gemini-3.7-flash']);
  check('thinking指定を拒否されても本文を取得できる', out === '1', String(out));
  check('その再試行では thinkingConfig を外している', calls[1] && calls[1].payload.generationConfig.thinkingConfig === undefined);
  check('その再試行では出力上限を広げている', calls[1] && calls[1].payload.generationConfig.maxOutputTokens >= 1536,
        calls[1] && String(calls[1].payload.generationConfig.maxOutputTokens));
}

// 1c) 文章生成で試すモデルは絞る(総当たりが45秒超えの主因だった)
{
  const { ctx } = makeCtx({ props: {}, handler: () => ok('x') });
  check('ADVICE_MODELS は3つまで', ctx.ADVICE_MODELS.length <= 3, 'len=' + ctx.ADVICE_MODELS.length);
}

// 1d) 予算を使い切ったら、残りのモデルを試し始めない
{
  let now = 0;
  const { ctx, calls } = makeCtx({
    props: { GEMINI_API_KEY: 'g' },
    handler: () => { now += 30000; return { code: 503, body: 'overloaded' }; }, // 1回で30秒かかる想定
  });
  // Date.now を進めるため、テスト用に時計を差し替える
  const RealDate = Date;
  global.Date = class extends RealDate { getTime() { return now; } static now() { return now; } };
  ctx.Date = function () { return { getTime: () => now }; };
  ctx.Date.now = () => now;
  let threw = false;
  try { ctx.callAi_('test', 512, ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-2.5-flash']); } catch (e) { threw = true; }
  global.Date = RealDate;
  check('締め切り超過後は次のモデルを試さない', threw && calls.length < 3, 'calls=' + calls.length);
}

// 2) gemini-2.5系には従来どおり thinkingBudget:0 を送る(実績のある指定は維持)
{
  const { ctx, calls } = makeCtx({ props: { GEMINI_API_KEY: 'g' }, handler: () => ok('1') });
  ctx.callAi_('test', 512, ['gemini-2.5-flash']);
  const tc = calls[0].payload.generationConfig.thinkingConfig;
  check('gemini-2.5系には thinkingBudget:0 を送る', tc && tc.thinkingBudget === 0, JSON.stringify(tc));
}

// 3) 2.5系がthinkingBudgetを拒んだ場合は、指定を外して同じモデルに1回だけ試し直す
{
  const { ctx, calls } = makeCtx({
    props: { GEMINI_API_KEY: 'g' },
    handler: (c) => (c.payload.generationConfig.thinkingConfig ? thinkingLevelError : ok('recovered')),
  });
  const out = ctx.callAi_('test', 512, ['gemini-2.5-flash']);
  check('400のとき thinkingConfig を外して自力で復帰する', out === 'recovered', String(out));
  check('その再試行は同じモデルに対して行われる', calls.length === 2 && calls[1].url === calls[0].url);
}

// 4) GROQ_API_KEYがあればGroqを最優先で呼び、Geminiには一切問い合わせない
{
  const { ctx, calls } = makeCtx({
    props: { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'gq' },
    handler: () => ok('groqの返事'),
  });
  const out = ctx.callAi_('test', 512, ['gemini-3.7-flash']);
  check('Groqが設定されていればGroqを最優先で使う', /groq\.com/.test(calls[0].url), calls[0].url);
  check('Groqが成功したらGeminiは呼ばない', calls.length === 1, 'calls=' + calls.length);
  check('Groqの応答が返る', out === 'groqの返事', String(out));
}

// 5) Groqが落ちていればGeminiへ回る(控えとして機能する)
{
  const { ctx, calls } = makeCtx({
    props: { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'gq' },
    handler: (c) => (/groq\.com/.test(c.url) ? { code: 401, body: 'bad key' } : ok('geminiの返事')),
  });
  const out = ctx.callAi_('test', 512, ['gemini-3.7-flash']);
  check('Groq失敗時はGeminiが控えとして使われる', out === 'geminiの返事', String(out));
  check('Geminiにも実際に問い合わせている', calls.some(c => /generativelanguage/.test(c.url)));
}

// 6) Geminiのみ設定 & 全滅のとき、Groq設定を促す案内がエラーに添えられる
{
  const { ctx } = makeCtx({
    props: { GEMINI_API_KEY: 'g' },
    handler: () => ({ code: 429, body: JSON.stringify({ error: { message: 'quota' } }) }),
  });
  let msg = '';
  try { ctx.callAi_('test', 512, ['gemini-3.7-flash']); } catch (e) { msg = e.message; }
  check('Groq未設定なら、設定を促す案内が添えられる', /GROQ_API_KEY/.test(msg) && /console\.groq\.com/.test(msg), msg.slice(0, 160));
}

// 7) キー未設定なら、そもそも外部へ問い合わせない
{
  const { ctx, calls } = makeCtx({ props: {}, handler: () => ok('x') });
  let msg = '';
  try { ctx.callAi_('test', 512); } catch (e) { msg = e.message; }
  check('キー未設定なら通信せずエラーにする', calls.length === 0 && /設定されていません/.test(msg), msg);
}

// 8) 「AIのひとこと」が、実際の呼び出し口(handleAdvice_)まで通して成功する
{
  const { ctx } = makeCtx({ props: { GROQ_API_KEY: 'gq' }, handler: () => ok('順調に続けられています。') });
  const res = ctx.handleAdvice_({ days: [] });
  check('handleAdvice_ がコメントを返す', res.status === 'ok' && res.text === '順調に続けられています。', JSON.stringify(res).slice(0, 120));
}

// 9) 「AIで栄養を調べる」も、gemini-3.x のみの構成で通る(今回のエラーの再発防止)
{
  const { ctx } = makeCtx({
    props: { GEMINI_API_KEY: 'g' },
    handler: (c) => (c.payload.generationConfig.thinkingConfig
      ? thinkingLevelError
      : ok('{"kcal": 250, "protein": 20.5, "fat": 8.1, "carb": 22.3}')),
  });
  const res = ctx.handleNutrition_('鶏むね肉');
  check('handleNutrition_ が gemini-3.x でも概算を返す',
        res.status === 'ok' && res.nutrition.kcal === 250 && res.nutrition.protein === 20.5,
        JSON.stringify(res).slice(0, 140));
}

console.log('\n' + (fail === 0 ? `ALL ${pass} AI TESTS PASSED` : `${fail} FAILED / ${pass} passed`));
process.exit(fail === 0 ? 0 : 1);
