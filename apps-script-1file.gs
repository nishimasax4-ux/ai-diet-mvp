/**
 * Training Log + AI  Apps Script (v44.2) 貼り付け用・1ファイル版
 *
 * コメントを取り除いただけで、動作は apps-script.gs と完全に同じです。
 *
 * 【貼り付け手順】
 *  1. Apps Scriptエディタで、今あるコードを「全選択 → 削除」して空にする
 *     ※以前5つのファイルに分けていた場合は、余分な4つも削除してください
 *  2. このファイルの中身を全部貼り付けて保存する
 *  3. 一番下までスクロールし、最終行が「}」であることを確認する
 *     → ここが「}」でなければ、貼り付けが途中で切れています(分割版をお使いください)
 *  4. デプロイ → デプロイを管理 → 鉛筆マーク → 新バージョン → デプロイ
 *  5. アプリの設定タブに「接続先のApps Script: v44.2 ✅」と出れば完了
 *
 * 【スクリプトプロパティ】
 *   APP_TOKEN       … アプリの設定タブに入れる合言葉(必須)
 *   GROQ_API_KEY    … console.groq.com で無料発行(推奨。写真の判定にも使われます)
 *   GEMINI_API_KEY  … Google AI Studio で発行(任意)
 *
 * 【デプロイ設定】ウェブアプリ / 実行するユーザー: 自分 / アクセスできるユーザー: 全員
 */

var GEMINI_MODEL = 'gemini-3.7-flash';

var GEMINI_FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-2.5-flash'];

var GEMINI_LITE_MODELS = ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'];

var NUTRITION_MODELS = GEMINI_LITE_MODELS.concat([GEMINI_MODEL]).concat(GEMINI_FALLBACK_MODELS);

var ADVICE_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', GEMINI_MODEL];

var GROQ_MODEL = 'llama-3.3-70b-versatile';

var GROQ_VISION_MODELS = ['qwen/qwen3.6-27b', 'qwen/qwen3.8-27b'];

var BACKEND_VERSION = 'v44.2';

function doGet(e) {
  // Muse用: 読み取り系だけGETでも呼べる(?action=museHelp&token=合言葉)
  try {
    var p = (e && e.parameter) || {};
    var expected = prop_('APP_TOKEN');
    if (expected && p.token && safeEqual_(String(p.token), expected)
        && (p.action === 'museHelp' || p.action === 'museTodaySummary' || p.action === 'museWeightTrend')) {
      return json_(museRoute_(p.action, p));
    }
  } catch (err) {}
  return json_({ status: 'error', message: 'POST only' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    var expected = prop_('APP_TOKEN');
    if (!expected) return json_({ status: 'error', message: 'サーバ側にAPP_TOKENが設定されていません' });
    var suppliedToken = body.token || (e.parameter && e.parameter.token) || '';
    if (!suppliedToken || !safeEqual_(String(suppliedToken), expected)) {
      return json_({ status: 'error', message: '認証に失敗しました(トークンが一致しません)' });
    }

    var action = body.action || 'save';
    if (action === 'ping')              return json_(handlePing_());
    if (action === 'save')              return json_(handleSave_(body.payload, body.knownWriteAt, body.force));
    if (action === 'load')              return json_(handleLoad_());
    if (action === 'estimateNutrition') return json_(handleNutrition_(body.foodName));
    if (action === 'advice')            return json_(handleAdvice_(body.context));
    if (action === 'mealPlan')          return json_(handleMealPlan_(body.context));
    if (action === 'analyzePhoto')      return json_(handleAnalyzePhoto_(body.imageBase64, body.mimeType));

    if (action === 'aiText')            return json_(handleAiText_(body));
    if (action === 'aiVision')          return json_(handleAiVision_(body));
    var museRes = museRoute_(action, body.payload);
    if (museRes) return json_(museRes);
    return json_({ status: 'error', message: '不明なaction: ' + action });

  } catch (err) {
    return json_({ status: 'error', message: String(err && err.message ? err.message : err) });
  }
}

function handleSave_(payload, knownWriteAt, force) {
  if (!payload || typeof payload !== 'object') return { status: 'error', message: 'payloadがありません' };
  var ss = spreadsheet_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { status: 'error', message: '他の同期処理と競合しました。少し待って再試行してください。' };
  try {
    var lastWriteAt = prop_('LAST_WRITE_AT') || null;
    if (!force && knownWriteAt && lastWriteAt && knownWriteAt !== lastWriteAt) {
      return {
        status: 'conflict',
        lastWriteAt: lastWriteAt,
        message: '他の端末で、この端末が把握している内容より新しいデータが書き込まれています。',
      };
    }
    var written = 0;
    Object.keys(payload).forEach(function (name) {
      var t = payload[name] || {};
      var header = t.header || [];
      var rows = t.rows || [];
      var sh = ss.getSheetByName(name) || ss.insertSheet(name);
      sh.clear();
      if (header.length) {
        sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
        sh.setFrozenRows(1);
      }
      if (rows.length) {
        var width = header.length || rows[0].length;
        var norm = rows.map(function (r) {
          var out = r.slice(0, width);
          while (out.length < width) out.push('');
          return out;
        });
        sh.getRange(2, 1, norm.length, width).setValues(norm);
        written += norm.length;
      }
      sh.autoResizeColumns(1, Math.max(1, header.length));
    });
    var now = new Date().toISOString();
    PropertiesService.getScriptProperties().setProperty('LAST_WRITE_AT', now);
    return { status: 'ok', written: written, at: now, lastWriteAt: now };
  } finally {
    lock.releaseLock();
  }
}

function handleLoad_() {
  var ss = spreadsheet_();
  var payload = {};
  ['筋トレ', '有酸素', '体重', '食事'].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { payload[name] = { header: [], rows: [] }; return; }
    var values = sh.getDataRange().getValues();
    if (values.length < 1) { payload[name] = { header: [], rows: [] }; return; }
    var header = values[0];
    var rows = values.slice(1)
      .filter(function (r) { return String(r[0] || '').trim() !== ''; })
      .map(function (r) { return r.map(normalizeCell_); });
    payload[name] = { header: header, rows: rows };
  });

  return { status: 'ok', payload: payload, lastWriteAt: prop_('LAST_WRITE_AT') || null };
}

function normalizeCell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v;
}

function handleNutrition_(foodName) {
  if (!foodName) return { status: 'error', message: '食品名が空です' };

  var prompt =
    '次の食品の栄養価を、日本で一般的な1食あたりの目安量で概算してください。\n' +
    '食品名: ' + foodName + '\n\n' +
    'JSONのみを返してください。前置き・後書き・コードフェンスは不要です。\n' +
    '形式: {"kcal": 数値, "protein": 数値, "fat": 数値, "carb": 数値}\n' +
    'protein/fat/carb の単位はグラム、小数第1位まで。';

  var text = callAi_(prompt, 512, NUTRITION_MODELS);
  var n = parseJson_(text);
  if (!n || typeof n.kcal === 'undefined') {
    return { status: 'error', message: 'AIの応答を解釈できませんでした(応答: ' + String(text).slice(0, 200) + ')' };
  }
  return {
    status: 'ok',
    nutrition: {
      kcal: Math.round(Number(n.kcal) || 0),
      protein: round1_(n.protein),
      fat: round1_(n.fat),
      carb: round1_(n.carb),
    },
  };
}

function handleAdvice_(ctx) {
  if (!ctx) return { status: 'error', message: 'contextがありません' };

  var prompt =
    'あなたは親しみやすいパーソナルトレーナー兼栄養サポート役です。\n' +
    '以下は利用者の直近2週間の記録(JSON)です。これをもとに、日本語で3〜4文の短いコメントを書いてください。\n\n' +
    '### 守ること\n' +
    '- 具体的な数字や種目名に触れ、記録をちゃんと見ていると伝わる内容にする\n' +
    '- 良かった点を1つ、次にやると良いことを1つ、必ず入れる\n' +
    '- 断定的な医学的助言・診断はしない。極端な食事制限は勧めない\n' +
    '- 記録が少ない日を責めない。前向きで落ち着いた口調で\n' +
    '- 見出しや箇条書きは使わず、地の文だけで書く\n\n' +
    '### 記録\n' +
    JSON.stringify(ctx);

  var text = callAi_(prompt, 768, ADVICE_MODELS);
  if (!text) return { status: 'error', message: 'AIから応答がありませんでした' };
  return { status: 'ok', text: String(text).trim() };
}

function handleMealPlan_(ctx) {
  if (!ctx) return { status: 'error', message: 'contextがありません' };

  var prompt =
    'あなたは日本の家庭料理に詳しい管理栄養士です。\n' +
    '以下は利用者の「今日の状況」です(JSON)。今日の朝食と夕食の候補を提案してください。\n\n' +
    '### 出力形式(JSONのみ。前置き・後書き・コードフェンスは不要)\n' +
    '{"meals":[{"mealType":"朝食","comment":"一言","items":[' +
    '{"name":"料理名","kcal":数値,"protein":数値,"fat":数値,"carb":数値}]}]}\n' +
    '- mealTypeは "朝食" と "夕食" の2つ。それぞれ items を2件ずつ\n' +
    '- name は「納豆ご飯と味噌汁」のように、1食ぶんの内容が分かる具体的な料理名\n' +
    '- kcal は「区分ごとの目安kcal」に収める。protein/fat/carb はグラム、小数第1位まで\n' +
    '- comment は40文字程度で、なぜその内容かを一言\n\n' +
    '### 守ること\n' +
    '- 「よく食べている朝食」「よく食べている夕食」に挙がっているものを1件は活かし、もう1件は違う料理を提案して変化をつける\n' +
    '- 「今日まだ不足しているPFCg」で不足している栄養素(特にたんぱく質)を補える内容にする\n' +
    '- 日本のスーパーやコンビニで手に入る、平日でも用意できる現実的なものにする\n' +
    '- 断定的な医学的助言・診断はしない。極端な食事制限は勧めない。責める言い方をしない\n\n' +
    '### 今日の状況\n' +
    JSON.stringify(ctx);

  var text = callAi_(prompt, 700, ADVICE_MODELS);
  if (!text) return { status: 'error', message: 'AIから応答がありませんでした' };

  var parsed = parseJson_(text);
  var plan = (parsed && parsed.meals && parsed.meals.length) ? parsed.meals : null;
  return { status: 'ok', text: String(text).trim(), plan: plan };
}

function shouldRetrySameModel_(code) {
  return code === 503 || (code >= 500 && code < 600);
}

function isFatalGeminiError_(code, body) {
  return code === 400 && /API key not valid|API_KEY_INVALID/i.test(String(body || ''));
}

function shouldTryNextModel_(code, body) {
  if (isFatalGeminiError_(code, body)) return false;
  if (code === 400) return true;
  return code === 429 || code === 404 || shouldRetrySameModel_(code);
}

function thinkingConfigFor_(model) {

  return /^gemini-2\.5/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: 'low' };
}

function roomyMaxTokens_(maxTokens) {
  return Math.max(1536, (maxTokens || 512) * 2);
}

function callGeminiRaw_(url, prompt, maxTokens, thinkingConfig, deadlineMs, image) {
  var generationConfig = { temperature: 0.4, maxOutputTokens: maxTokens || 512 };
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  if (AI_WANT_JSON) generationConfig.responseMimeType = 'application/json';
  var options = {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({

      contents: [{ parts: image
        ? [{ inline_data: { mime_type: image.mimeType || 'image/jpeg', data: image.data } }, { text: prompt }]
        : [{ text: prompt }] }],
      generationConfig: generationConfig,
    }),
  };

  var RETRY_DELAYS_MS = [800, 2000];
  var code = 0, body = '';
  for (var attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    var res = UrlFetchApp.fetch(url, options);
    code = res.getResponseCode();
    body = res.getContentText();
    if (code === 200) break;
    if (!shouldRetrySameModel_(code) || attempt === RETRY_DELAYS_MS.length) break;

    if (new Date().getTime() + RETRY_DELAYS_MS[attempt] > deadlineMs) break;
    Utilities.sleep(RETRY_DELAYS_MS[attempt]);
  }
  return { code: code, body: body };
}

function callGeminiModel_(apiKey, model, prompt, maxTokens, deadlineMs) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
            model + ':generateContent?key=' + encodeURIComponent(apiKey);
  var thinking = thinkingConfigFor_(model);

  var tokens = thinking ? (maxTokens || 512) : roomyMaxTokens_(maxTokens);
  var r = callGeminiRaw_(url, prompt, tokens, thinking, deadlineMs);

  if (thinking && r.code === 400 && !isFatalGeminiError_(r.code, r.body)) {
    var retry = callGeminiRaw_(url, prompt, roomyMaxTokens_(maxTokens), null, deadlineMs);

    if (retry.code === 200) return retry;
  }
  return r;
}

function callGemini_(apiKey, prompt, maxTokens, models, budgetMs) {
  models = models || [GEMINI_MODEL].concat(GEMINI_FALLBACK_MODELS || []);

  var deadlineMs = new Date().getTime() + (budgetMs || 20000);
  var lastCode = 0, lastBody = '';
  for (var i = 0; i < models.length; i++) {

    if (i > 0 && new Date().getTime() > deadlineMs) break;
    var r = callGeminiModel_(apiKey, models[i], prompt, maxTokens, deadlineMs);
    if (r.code === 200) {
      var data = JSON.parse(r.body);
      var cand = data.candidates && data.candidates[0];
      if (!cand || !cand.content || !cand.content.parts) {

        var reason = cand && cand.finishReason ? cand.finishReason : '不明';
        throw new Error('Geminiから本文が返りませんでした(finishReason: ' + reason + ' / モデル: ' + models[i] + ')');
      }
      return cand.content.parts.map(function (p) { return p.text || ''; }).join('');
    }
    lastCode = r.code;
    lastBody = r.body;
    if (!shouldTryNextModel_(r.code, r.body)) break;
    if (new Date().getTime() > deadlineMs) break;
  }
  throw new Error('Gemini APIエラー (HTTP ' + lastCode + '): ' + lastBody.slice(0, 300));
}

function callGroq_(apiKey, prompt, maxTokens, model, image) {
  var url = 'https://api.groq.com/openai/v1/chat/completions';

  var content = image
    ? [{ type: 'text', text: prompt },
       { type: 'image_url', image_url: { url: 'data:' + (image.mimeType || 'image/jpeg') + ';base64,' + image.data } }]
    : prompt;
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model: model || GROQ_MODEL,
      messages: [{ role: 'user', content: content }],
      temperature: 0.4,
      max_tokens: maxTokens || 512,
      response_format: AI_WANT_JSON ? { type: 'json_object' } : undefined,
    }),
  };

  var res = UrlFetchApp.fetch(url, options);
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code >= 500 && code < 600) {
    Utilities.sleep(800);
    res = UrlFetchApp.fetch(url, options);
    code = res.getResponseCode();
    body = res.getContentText();
  }
  if (code !== 200) {
    throw new Error('Groq APIエラー (HTTP ' + code + '): ' + body.slice(0, 300));
  }
  var data = JSON.parse(body);
  var choice = data.choices && data.choices[0];
  var text = choice && choice.message && choice.message.content;
  if (!text) throw new Error('Groqから本文が返りませんでした(応答: ' + body.slice(0, 200) + ')');
  return text;
}

function callAi_(prompt, maxTokens, geminiModels) {
  var geminiKey = prop_('GEMINI_API_KEY');
  var groqKey = prop_('GROQ_API_KEY');
  if (!geminiKey && !groqKey) {
    throw new Error('GEMINI_API_KEYもGROQ_API_KEYも設定されていません(どちらか一方の設定で動作します)');
  }
  var groqError = null, geminiError = null;
  if (groqKey) {
    try {
      return callGroq_(groqKey, prompt, maxTokens);
    } catch (e) {
      groqError = e;
    }
  }
  if (geminiKey) {
    try {

      return callGemini_(geminiKey, prompt, maxTokens, geminiModels, groqKey ? 10000 : 22000);
    } catch (e) {
      geminiError = e;
    }
  }

  if (geminiError && !groqKey) {
    throw new Error(String(geminiError.message || geminiError) +
      ' ／ 現在GROQ_API_KEYが未設定のため、Geminiが不調だとAI機能が使えません。' +
      'console.groq.com で無料のキーを発行し(クレジットカード登録不要)、Apps Scriptの' +
      '「プロジェクトの設定」→「スクリプト プロパティ」に GROQ_API_KEY として登録すると、' +
      'Groq側が優先して使われるためこの種のエラーを回避できます。');
  }
  throw geminiError || groqError;
}

function callAiVision_(prompt, maxTokens, image) {
  var geminiKey = prop_('GEMINI_API_KEY');
  var groqKey = prop_('GROQ_API_KEY');
  if (!geminiKey && !groqKey) {
    throw new Error('GEMINI_API_KEYもGROQ_API_KEYも設定されていません(どちらか一方の設定で動作します)');
  }
  var groqError = null, geminiError = null;
  if (groqKey) {
    for (var i = 0; i < GROQ_VISION_MODELS.length; i++) {
      try {
        return callGroq_(groqKey, prompt, maxTokens, GROQ_VISION_MODELS[i], image);
      } catch (e) {
        groqError = e;
      }
    }
  }
  if (geminiKey) {
    try {

      var deadlineMs = new Date().getTime() + (groqKey ? 12000 : 25000);
      var models = ['gemini-2.5-flash', GEMINI_MODEL];
      var lastCode = 0, lastBody = '';
      for (var j = 0; j < models.length; j++) {
        if (j > 0 && new Date().getTime() > deadlineMs) break;
        var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                  models[j] + ':generateContent?key=' + encodeURIComponent(geminiKey);
        var r = callGeminiRaw_(url, prompt, maxTokens, thinkingConfigFor_(models[j]), deadlineMs, image);
        if (r.code === 200) {
          var data = JSON.parse(r.body);
          var cand = data.candidates && data.candidates[0];
          if (cand && cand.content && cand.content.parts) {
            return cand.content.parts.map(function (p) { return p.text || ''; }).join('');
          }
        }
        lastCode = r.code; lastBody = r.body;
        if (!shouldTryNextModel_(r.code, r.body)) break;
      }
      throw new Error('Gemini APIエラー (HTTP ' + lastCode + '): ' + lastBody.slice(0, 300));
    } catch (e2) {
      geminiError = e2;
    }
  }
  throw geminiError || groqError;
}

function handleAnalyzePhoto_(imageBase64, mimeType) {
  if (!imageBase64) return { status: 'error', message: '画像がありません' };

  var prompt =
    'この写真に写っている食事を判定してください。\n\n' +
    'JSONのみを返してください。前置き・後書き・コードフェンスは不要です。\n' +
    '形式: {"foods":[{"name":"料理名","kcal":数値,"protein":数値,"fat":数値,"carb":数値}]}\n' +
    '- 確からしい順に最大3件\n' +
    '- name は日本語の一般的な料理名。写真から読み取れる分量も含める(例:「鶏の唐揚げ(5個)」)\n' +
    '- 栄養値は、その分量あたりの概算。protein/fat/carb はグラム、小数第1位まで\n' +
    '- 複数の料理が写っている場合は、それぞれを1件ずつ挙げる\n' +
    '- 食事が写っていないと判断した場合は {"foods":[]} だけを返す';

  var text = callAiVision_(prompt, 700, { data: String(imageBase64), mimeType: mimeType || 'image/jpeg' });
  var parsed = parseJson_(text);
  if (!parsed || !parsed.foods) {
    return { status: 'error', message: 'AIの応答を解釈できませんでした' };
  }
  var foods = [];
  (parsed.foods || []).slice(0, 3).forEach(function (f) {
    if (!f || !f.name) return;
    foods.push({
      name: String(f.name).slice(0, 60),
      kcal: Math.round(Number(f.kcal) || 0),
      protein: round1_(f.protein),
      fat: round1_(f.fat),
      carb: round1_(f.carb),
    });
  });
  return { status: 'ok', foods: foods };
}

var AI_PRESETS = {
  nutrition: { models: NUTRITION_MODELS, maxTokens: 512 },
  advice:    { models: ADVICE_MODELS,    maxTokens: 768 },
  mealplan:  { models: ADVICE_MODELS,    maxTokens: 700 },
};
var AI_PROMPT_MAX = 20000;

var AI_WANT_JSON = false;
var AI_MAXTOKENS_MAX = 1500;

function aiRelayPrompt_(body) {
  var prompt = body && body.prompt ? String(body.prompt) : '';
  if (!prompt.trim()) return { error: 'promptがありません' };
  if (prompt.length > AI_PROMPT_MAX) return { error: 'promptが長すぎます(' + prompt.length + '文字)' };
  return { prompt: prompt };
}

function clampMaxTokens_(v, fallback) {
  var n = Math.round(Number(v));
  if (!isFinite(n) || n <= 0) return fallback;
  return Math.min(n, AI_MAXTOKENS_MAX);
}

function handleAiText_(body) {
  var p = aiRelayPrompt_(body);
  if (p.error) return { status: 'error', message: p.error };
  var preset = AI_PRESETS[String((body && body.preset) || 'advice')] || AI_PRESETS.advice;
  var text;
  AI_WANT_JSON = !!(body && body.json);
  try {
    text = callAi_(p.prompt, clampMaxTokens_(body && body.maxTokens, preset.maxTokens), preset.models);
  } finally {
    AI_WANT_JSON = false;
  }
  if (!text) return { status: 'error', message: 'AIから応答がありませんでした' };
  return { status: 'ok', text: String(text).trim() };
}

function handleAiVision_(body) {
  var p = aiRelayPrompt_(body);
  if (p.error) return { status: 'error', message: p.error };
  if (!body.imageBase64) return { status: 'error', message: '画像がありません' };
  var text;
  AI_WANT_JSON = !!body.json;
  try {
    text = callAiVision_(p.prompt, clampMaxTokens_(body.maxTokens, 700),
      { data: String(body.imageBase64), mimeType: body.mimeType || 'image/jpeg' });
  } finally {
    AI_WANT_JSON = false;
  }
  if (!text) return { status: 'error', message: 'AIから応答がありませんでした' };
  return { status: 'ok', text: String(text).trim() };
}

function testAi() {
  var geminiKey = prop_('GEMINI_API_KEY');
  var groqKey = prop_('GROQ_API_KEY');
  var lines = [];
  lines.push('GEMINI_API_KEY: ' + (geminiKey ? '設定あり' : '未設定'));
  lines.push('GROQ_API_KEY  : ' + (groqKey ? '設定あり' : '未設定'));
  lines.push('----- モデルごとの結果 -----');

  var prompt = '「1」とだけ返してください。';
  if (geminiKey) {
    var models = GEMINI_LITE_MODELS.concat([GEMINI_MODEL]).concat(GEMINI_FALLBACK_MODELS);
    for (var i = 0; i < models.length; i++) {
      try {
        var text = callGemini_(geminiKey, prompt, 64, [models[i]]);
        lines.push('OK   ' + models[i] + ' → ' + String(text).trim().slice(0, 40));
      } catch (e) {
        lines.push('NG   ' + models[i] + ' → ' + String(e.message).slice(0, 200));
      }
    }
  } else {
    lines.push('(Geminiはキー未設定のため未確認)');
  }
  if (groqKey) {
    try {
      var gt = callGroq_(groqKey, prompt, 64);
      lines.push('OK   Groq(' + GROQ_MODEL + ') → ' + String(gt).trim().slice(0, 40));
    } catch (e2) {
      lines.push('NG   Groq(' + GROQ_MODEL + ') → ' + String(e2.message).slice(0, 200));
    }
  } else {
    lines.push('(Groqはキー未設定のため未確認)');
  }

  var out = lines.join('\n');
  console.log(out);
  return out;
}

function handlePing_() {
  return {
    status: 'ok',
    backendVersion: BACKEND_VERSION,
    ai: { gemini: !!prop_('GEMINI_API_KEY'), groq: !!prop_('GROQ_API_KEY') },
  };
}

function prop_(name) {
  return PropertiesService.getScriptProperties().getProperty(name);
}

function spreadsheet_() {
  var id = prop_('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('SHEET_ID を設定するか、スプレッドシートにバインドしてください');
  return ss;
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseJson_(text) {
  if (!text) return null;
  var cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  var start = cleaned.indexOf('{');
  var end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (e) { return null; }
}

function round1_(v) {
  var n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============ Muse連携(v44.2) ============
// Meta Museなど外部のAIエージェントから、記録の追加・確認をするための入口。
// アプリ本体の同期とは別に、スプレッドシートの末尾へ1行ずつ追記するだけで、既存の記録は消しません。
// 追記のたびに「最終書き込み時刻」を更新するので、アプリを開いて同期したときに競合として検知され、
// Museの記録が黙って消えることはありません(競合が出たら、設定タブの「シートから復元」で取り込む)。
// 認証: 他のactionと同じ合言葉(APP_TOKEN)を、JSON本文の token か、URLの ?token= で渡します。

var MUSE_STRENGTH_KCAL_PER_SET = 10;
var MUSE_CARDIO_MET = { 'ランニング': 8, 'ジョギング': 7, 'バイク': 7, 'ウォーキング': 3.5, 'クロストレーナー': 5, 'リカベントバイク': 4.5, '買い物': 3, 'その他': 5 };
var MUSE_PARTS = ['胸', '背中', '脚', '肩', '腕', '腹筋'];
var MUSE_PART_HINTS = [
  ['胸', /ベンチ|チェスト|ペック|フライ|クロスオーバー|プッシュアップ|腕立て|ディップ/],
  ['背中', /ラット|プルダウン|ロウ|ローイング|懸垂|チンニング|デッドリフト|ストレートアーム|シュラッグ/],
  ['脚', /スクワット|レッグ|ランジ|カーフ|ヒップ|キックバック|ブルガリアン/],
  ['肩', /ショルダー|サイドレイズ|フェイスプル|リアレイズ|アーノルド|オーバーヘッドプレス/],
  ['腕', /カール|トライセップ|プレスダウン|エクステンション|ハンマー/],
  ['腹筋', /クランチ|腹筋|プランク|レッグレイズ|シットアップ|アブ/]
];
var MUSE_HEADERS = {
  '体重': ['日付', '体重kg', '体脂肪率%', '腹囲cm'],
  '食事': ['日付', '区分', 'メニュー', 'kcal', 'たんぱく質g', '脂質g', '炭水化物g'],
  '筋トレ': ['日付', '部位', '種目', '重量kg', '回数', '消費カロリーkcal'],
  '有酸素': ['日付', '種目', '時間分', '消費カロリーkcal']
};

function museDate_(offsetDays) {
  return Utilities.formatDate(new Date(Date.now() + (offsetDays || 0) * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
}
// 日付は省略可(=今日)。「今日」「昨日」「2026/11/3」「11/3」も可。解釈できなければ null。
function museResolveDate_(d) {
  if (d === undefined || d === null || d === '') return museDate_(0);
  var t = String(d).trim();
  if (/^(today|今日|きょう)$/i.test(t)) return museDate_(0);
  if (/^(yesterday|昨日|きのう)$/i.test(t)) return museDate_(-1);
  var m = t.match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})日?$/);
  if (!m) {
    var mm = t.match(/^(\d{1,2})[\/月](\d{1,2})日?$/);
    if (mm) m = [null, museDate_(0).slice(0, 4), mm[1], mm[2]];
  }
  if (!m) return null;
  var y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
  var dt = new Date(Date.UTC(y, mo - 1, da));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== da) return null;
  return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + da).slice(-2);
}
// 「65.2kg」「10回」「約30分」のような単位つきも数値として読む。読めなければ NaN。
function museLoose_(v) {
  if (typeof v === 'number') return v;
  var s = String(v === undefined || v === null ? '' : v)
    .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/．/g, '.');
  var m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}
function museOpt_(v) { var n = museLoose_(v); return isFinite(n) ? n : ''; }
function museSafe_(v) {
  var s = String(v === undefined || v === null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;   // 数式として解釈されないようにする
}
function museGuessPart_(ex) {
  for (var i = 0; i < MUSE_PART_HINTS.length; i++) if (MUSE_PART_HINTS[i][1].test(String(ex || ''))) return MUSE_PART_HINTS[i][0];
  return null;
}
function museGuessMealType_() {
  var h = Number(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'H'));
  return h >= 4 && h < 10 ? '朝食' : h >= 10 && h < 15 ? '昼食' : h >= 15 && h < 18 ? '間食' : '夕食';
}

function museHelp_() {
  return {
    status: 'ok',
    usage: 'POST このURL に JSON {"action": ..., "token": "合言葉", "payload": {...}} を送る(tokenはURLの ?token=合言葉 でも可)。',
    tip: '記録は museLog が一番かんたん。1回の呼び出しで体重・食事・筋トレ・有酸素をまとめて記録できる。dateは省略すると日本時間の今日。',
    actions: {
      museLog: {
        payload: {
          items: [
            { type: 'weight', weight: '72.4', bodyFat: '24.1(任意)', waist: '(任意)' },
            { type: 'meal', text: '鶏むね肉のサラダ', mealType: '省略可(時刻から自動)', calories: '450', protein: '', fat: '', carb: '' },
            { type: 'strength', exercise: 'チェストプレス', part: '省略可(種目名から推定)', weight: '30(省略=自重)', reps: '10', sets: '3' },
            { type: 'cardio', exercise: 'ウォーキング', minutes: '30' }
          ],
          date: '省略可(今日/昨日/2026-11-03)。items内に個別指定も可'
        },
        note: 'items最大10件。結果は1件ずつ返る'
      },
      museTodaySummary: { payload: { date: '省略可' }, note: '指定日の摂取カロリーと運動の集計' },
      museWeightTrend: { payload: { days: '省略可(14)' } }
    },
    single: 'museLogWeight / museLogMeal / museLogStrength / museLogCardio でも1件ずつ記録できる(museLogと同じ項目)'
  };
}

function museSheetRows_(name) {
  var sh = spreadsheet_().getSheetByName(name);
  if (!sh) return [];
  var v = sh.getDataRange().getValues();
  return v.slice(1).filter(function (r) { return String(r[0] || '').trim() !== ''; })
          .map(function (r) { return r.map(normalizeCell_); });
}
function museLatestWeightKg_() {
  var rows = museSheetRows_('体重').filter(function (r) { return Number(r[1]) > 0; });
  if (!rows.length) return null;
  rows.sort(function (a, b) { return String(a[0]) < String(b[0]) ? -1 : 1; });
  return Number(rows[rows.length - 1][1]);
}
// 行を末尾に追加する(シートが無ければ見出し付きで作る)。排他制御つき。
function museAppend_(name, rows) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('他の処理と競合しました。少し待って再試行してください。');
  try {
    var ss = spreadsheet_();
    var sh = ss.getSheetByName(name);
    var header = MUSE_HEADERS[name];
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    var start = Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(start, 1, rows.length, header.length).setValues(rows);
    var now = new Date().toISOString();
    PropertiesService.getScriptProperties().setProperty('LAST_WRITE_AT', now);
    return now;
  } finally {
    lock.releaseLock();
  }
}

function museOne_(type, p) {
  p = p || {};
  var date = museResolveDate_(p.date);
  if (!date) return { status: 'error', message: 'dateは省略(=今日)か、今日/昨日/2026-11-03のような形で指定してください' };
  if (type === 'weight') {
    var w = museLoose_(p.weight);
    if (!isFinite(w) || w <= 0) return { status: 'error', message: 'weight(kg、数値)が必要です' };
    museAppend_('体重', [[date, w, museOpt_(p.bodyFat), museOpt_(p.waist)]]);
    return { status: 'ok', recorded: { date: date, weight: w } };
  }
  if (type === 'meal') {
    if (!p.text) return { status: 'error', message: 'text(メニュー名)が必要です' };
    var mealType = p.mealType || museGuessMealType_();
    var cal = museOpt_(p.calories); if (cal === '') cal = 0;
    museAppend_('食事', [[date, museSafe_(mealType), museSafe_(p.text), cal, museOpt_(p.protein), museOpt_(p.fat), museOpt_(p.carb)]]);
    return { status: 'ok', recorded: { date: date, mealType: mealType, text: p.text, calories: cal } };
  }
  if (type === 'strength') {
    var part = p.part || museGuessPart_(p.exercise);
    if (MUSE_PARTS.indexOf(part) < 0) return { status: 'error', message: '部位を判断できません。part を ' + MUSE_PARTS.join('/') + ' のいずれかで指定してください' };
    var reps = museLoose_(p.reps);
    if (!isFinite(reps) || reps <= 0) return { status: 'error', message: 'reps(回数、数値)が必要です' };
    var kg = (p.weight === undefined || p.weight === null || p.weight === '') ? 0 : museLoose_(p.weight);
    if (!isFinite(kg) || kg < 0) return { status: 'error', message: 'weight(kg、数値)が正しくありません' };
    var sets = (p.sets === undefined || p.sets === null || p.sets === '') ? 1 : Math.round(museLoose_(p.sets));
    if (!isFinite(sets) || sets < 1 || sets > 20) return { status: 'error', message: 'sets(セット数)は1〜20にしてください' };
    var rows = [];
    for (var i = 0; i < sets; i++) rows.push([date, part, museSafe_(p.exercise || ''), kg, reps, MUSE_STRENGTH_KCAL_PER_SET]);
    museAppend_('筋トレ', rows);   // アプリと同じく、1セット=1行
    return { status: 'ok', recorded: { date: date, part: part, exercise: p.exercise || null, weight: kg, reps: reps, sets: sets } };
  }
  if (type === 'cardio') {
    if (!p.exercise) return { status: 'error', message: 'exercise(種目名、例: ウォーキング)が必要です' };
    var min = museLoose_(p.minutes);
    if (!isFinite(min) || min <= 0) return { status: 'error', message: 'minutes(分、数値)が必要です' };
    var wkg = museLatestWeightKg_();
    var met = MUSE_CARDIO_MET[p.exercise] || MUSE_CARDIO_MET['その他'];
    var kcal = wkg != null ? Math.round((met * 3.5 * wkg / 200) * min) : '';
    museAppend_('有酸素', [[date, museSafe_(p.exercise), min, kcal]]);
    return { status: 'ok', recorded: { date: date, exercise: p.exercise, minutes: min, kcal: kcal === '' ? null : kcal } };
  }
  return { status: 'error', message: 'typeは weight/meal/strength/cardio のいずれかです' };
}
function handleMuseLog_(p) {
  var items = p && Object.prototype.toString.call(p.items) === '[object Array]' ? p.items : null;
  if (!items || !items.length) return { status: 'error', message: 'items(配列)が必要です。museHelpで例を確認できます' };
  if (items.length > 10) return { status: 'error', message: 'itemsは10件までです' };
  var results = [], allOk = true;
  items.forEach(function (it) {
    var r;
    try {
      var rest = {}; Object.keys(it || {}).forEach(function (k) { if (k !== 'type') rest[k] = it[k]; });
      if ((rest.date === undefined || rest.date === null) && p.date !== undefined) rest.date = p.date;
      r = museOne_(it && it.type, rest);
    } catch (e) { r = { status: 'error', message: String(e && e.message ? e.message : e) }; }
    r.type = it && it.type;
    if (r.status !== 'ok') allOk = false;
    results.push(r);
  });
  return { status: allOk ? 'ok' : 'partial', results: results };
}
function handleMuseTodaySummary_(p) {
  var date = museResolveDate_(p && p.date) || museDate_(0);
  var meals = museSheetRows_('食事').filter(function (r) { return r[0] === date; });
  var strength = museSheetRows_('筋トレ').filter(function (r) { return r[0] === date; });
  var cardio = museSheetRows_('有酸素').filter(function (r) { return r[0] === date; });
  var sum = function (rows, i) { return rows.reduce(function (s, r) { return s + (Number(r[i]) || 0); }, 0); };
  return {
    status: 'ok', date: date,
    intakeKcal: Math.round(sum(meals, 3)), proteinG: Math.round(sum(meals, 4)),
    meals: meals.map(function (r) { return { mealType: r[1], text: r[2], kcal: r[3] }; }),
    strengthSets: strength.length, cardioMinutes: sum(cardio, 2), cardioKcal: Math.round(sum(cardio, 3)),
    note: '目標カロリーや基礎代謝はアプリ側にしかないため、ここでは記録の合計だけを返します。'
  };
}
function handleMuseWeightTrend_(p) {
  var days = Math.min(Math.max(Math.round(museLoose_(p && p.days) || 14), 1), 365);
  var cutoff = museDate_(-days);
  var rows = museSheetRows_('体重').filter(function (r) { return String(r[0]) >= cutoff; })
    .sort(function (a, b) { return String(a[0]) < String(b[0]) ? -1 : 1; });
  return { status: 'ok', days: days, entries: rows.map(function (r) { return { date: r[0], weightKg: r[1], bodyFatPct: r[2] === '' ? null : r[2], waistCm: r[3] === '' ? null : r[3] }; }) };
}
// doPost / doGet から呼ぶ。Museのaction以外は null を返す。
function museRoute_(action, payload) {
  if (action === 'museHelp') return museHelp_();
  if (action === 'museLog') return handleMuseLog_(payload);
  if (action === 'museLogWeight') return handleMuseLog_({ items: [Object.assign({ type: 'weight' }, payload || {})] });
  if (action === 'museLogMeal') return handleMuseLog_({ items: [Object.assign({ type: 'meal' }, payload || {})] });
  if (action === 'museLogStrength') return handleMuseLog_({ items: [Object.assign({ type: 'strength' }, payload || {})] });
  if (action === 'museLogCardio') return handleMuseLog_({ items: [Object.assign({ type: 'cardio' }, payload || {})] });
  if (action === 'museTodaySummary') return handleMuseTodaySummary_(payload);
  if (action === 'museWeightTrend') return handleMuseWeightTrend_(payload);
  return null;
}
