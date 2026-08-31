/**
 * Training Log + AI  Apps Script (v42) 貼り付け用・1ファイル版
 *
 * コメントを取り除いただけで、動作は配布物の apps-script.gs と完全に同じです
 * (同じ自動テスト20件に通しています)。
 *
 * 【貼り付け手順】
 *  1. Apps Scriptエディタで、今あるコードを「全選択 → 削除」して空にする
 *     ※前回5つのファイルに分けた場合は、コード.gs 以外の4つも削除してください
 *  2. このファイルの中身を全部貼り付けて保存する
 *  3. 一番下までスクロールし、最終行が「}」であることを確認する
 *     → ここが「}」でなければ、貼り付けが途中で切れています
 *  4. デプロイ → デプロイを管理 → 鉛筆マーク → 新バージョン → デプロイ
 *  5. アプリの設定タブに「接続先のApps Script: v42 ✅」と出れば完了
 *
 * 【スクリプトプロパティ】
 *   APP_TOKEN       … アプリの設定タブに入れる合言葉(必須)
 *   GROQ_API_KEY    … console.groq.com で無料発行(推奨。AIの応答が速くなります)
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

var BACKEND_VERSION = 'v42';

function doGet() {
  return json_({ status: 'error', message: 'POST only' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    var expected = prop_('APP_TOKEN');
    if (!expected) return json_({ status: 'error', message: 'サーバ側にAPP_TOKENが設定されていません' });
    if (!body.token || !safeEqual_(String(body.token), expected)) {
      return json_({ status: 'error', message: '認証に失敗しました(トークンが一致しません)' });
    }

    var action = body.action || 'save';
    if (action === 'ping')              return json_(handlePing_());
    if (action === 'save')              return json_(handleSave_(body.payload, body.knownWriteAt, body.force));
    if (action === 'load')              return json_(handleLoad_());
    if (action === 'estimateNutrition') return json_(handleNutrition_(body.foodName));
    if (action === 'advice')            return json_(handleAdvice_(body.context));
    if (action === 'mealPlan')          return json_(handleMealPlan_(body.context));
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

function callGeminiRaw_(url, prompt, maxTokens, thinkingConfig, deadlineMs) {
  var generationConfig = { temperature: 0.4, maxOutputTokens: maxTokens || 512 };
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  var options = {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
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

function callGroq_(apiKey, prompt, maxTokens) {
  var url = 'https://api.groq.com/openai/v1/chat/completions';
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: maxTokens || 512,
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
