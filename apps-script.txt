/**
 * Training Log + AI — Apps Script バックエンド (v8)
 *
 * 【スクリプトプロパティに設定するもの】
 *   APP_TOKEN       … アプリの「設定」タブに入れる合言葉。適当な長い文字列でOK。
 *                     (例: openssl rand -hex 24 の出力)
 *   GEMINI_API_KEY  … Google AI Studio で発行したAPIキー。AI機能を使う場合のみ。
 *   SHEET_ID        … 書き込み先スプレッドシートのID。省略時はこのスクリプトの
 *                     コンテナ(バインドされたシート)を使う。
 *
 * 【デプロイ】
 *   「ウェブアプリ」/ 実行するユーザー: 自分 / アクセスできるユーザー: 全員
 *   ※「全員」でないと動きませんが、APP_TOKEN が無いリクエストは弾くので、
 *     URLを知られただけでは書き込まれません。
 */

// 2026年8月時点でGoogleがgemini-2.0-flashを廃止したため更新(HTTP 404で通知されました)。
// gemini-3.7-flashは執筆時点でのFlash系最新モデルで、無料枠の対象にも含まれています。
// 将来また廃止される可能性はあるので、同様のHTTP 404エラーが出た場合はここを最新のモデルIDに
// 書き換えてください(https://ai.google.dev/gemini-api/docs/models で確認できます)。
var GEMINI_MODEL = 'gemini-3.7-flash';
// 本命モデルが混雑(503)・レート超過(429)・廃止(404)で使えないときに、順番に試す代替モデル。
// 人気モデルほど混みやすいため、1つ前の世代を控えに置いておくと成功率が上がる。
// いずれも無料枠の対象です(https://ai.google.dev/gemini-api/docs/pricing)。
var GEMINI_FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-2.5-flash'];

function doGet() {
  return json_({ status: 'error', message: 'POST only' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    // ---- 認証 ----------------------------------------------------------
    var expected = prop_('APP_TOKEN');
    if (!expected) return json_({ status: 'error', message: 'サーバ側にAPP_TOKENが設定されていません' });
    if (!body.token || !safeEqual_(String(body.token), expected)) {
      return json_({ status: 'error', message: '認証に失敗しました(トークンが一致しません)' });
    }

    var action = body.action || 'save';
    if (action === 'save')              return json_(handleSave_(body.payload));
    if (action === 'load')              return json_(handleLoad_());
    if (action === 'estimateNutrition') return json_(handleNutrition_(body.foodName));
    if (action === 'advice')            return json_(handleAdvice_(body.context));
    return json_({ status: 'error', message: '不明なaction: ' + action });

  } catch (err) {
    return json_({ status: 'error', message: String(err && err.message ? err.message : err) });
  }
}

/* ====================== 保存 / 読み込み ====================== */

/**
 * payload は { シート名: {header:[...], rows:[[...],...]}, ... } の形。
 * 以前は全カテゴリを同じ6列に詰め込んでいたため、行によって列の意味が変わって
 * 集計に使えなかった。カテゴリごとにシートを分け、数値は数値のまま書き込む。
 */
function handleSave_(payload) {
  if (!payload || typeof payload !== 'object') return { status: 'error', message: 'payloadがありません' };
  var ss = spreadsheet_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { status: 'error', message: '他の同期処理と競合しました。少し待って再試行してください。' };
  try {
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
    return { status: 'ok', written: written, at: new Date().toISOString() };
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
  return { status: 'ok', payload: payload };
}

/** Sheetsが日付型で返してきたセルを YYYY-MM-DD の文字列に揃える。 */
function normalizeCell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v;
}

/* ====================== Gemini ====================== */

function handleNutrition_(foodName) {
  if (!foodName) return { status: 'error', message: '食品名が空です' };
  var key = prop_('GEMINI_API_KEY');
  if (!key) return { status: 'error', message: 'GEMINI_API_KEYが未設定です' };

  var prompt =
    '次の食品の栄養価を、日本で一般的な1食あたりの目安量で概算してください。\n' +
    '食品名: ' + foodName + '\n\n' +
    'JSONのみを返してください。前置き・後書き・コードフェンスは不要です。\n' +
    '形式: {"kcal": 数値, "protein": 数値, "fat": 数値, "carb": 数値}\n' +
    'protein/fat/carb の単位はグラム、小数第1位まで。';

  var text = callGemini_(key, prompt, 512);
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

/**
 * 直近のトレーニング・食事・体重データを渡して、コメントを生成させる。
 * アプリ側の「AIのひとこと」は既定ではルールベースなので、ここが唯一
 * 本物のAIが文章を書く場所になる。
 */
function handleAdvice_(ctx) {
  var key = prop_('GEMINI_API_KEY');
  if (!key) return { status: 'error', message: 'GEMINI_API_KEYが未設定です' };
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

  var text = callGemini_(key, prompt, 768);
  if (!text) return { status: 'error', message: 'AIから応答がありませんでした' };
  return { status: 'ok', text: String(text).trim() };
}

// 混雑(503)やサーバーエラー(5xx)は、数秒待てば直ることがあるので同じモデルに再試行する。
// 429(レート超過・無料枠の上限)は【あえて再試行しない】。枠を使い切っている状態で叩き直しても
// 成功しないうえ、リクエスト数をさらに消費してレート制限を悪化させるだけのため。
function shouldRetrySameModel_(code) {
  return code === 503 || (code >= 500 && code < 600);
}
// 別のモデルなら通る可能性があるケース。無料枠はモデルごとに別枠なので、429でも
// モデルを変えれば通ることがある。404(モデル廃止)も同様に次のモデルを試す価値がある。
// 逆に400(リクエスト不正・APIキー不正)や403(権限なし)は、モデルを変えても直らないので即中断。
function shouldTryNextModel_(code) {
  return code === 429 || code === 404 || shouldRetrySameModel_(code);
}

function callGeminiModel_(apiKey, model, prompt, maxTokens, deadlineMs) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
            model + ':generateContent?key=' + encodeURIComponent(apiKey);
  var options = {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      // thinkingBudget:0 で「思考」を無効化する。gemini-3.x系のFlashモデルは既定で
      // 思考トークンを使うため、有効なままだと短い構造化出力(JSON概算・短文コメント)でも
      // maxOutputTokensを思考側だけで使い切ってしまい、本文が空になることがあった
      // (「AIの応答を解釈できませんでした」エラーの原因)。この用途では思考は不要なので無効化する。
      generationConfig: { temperature: 0.4, maxOutputTokens: maxTokens || 512, thinkingConfig: { thinkingBudget: 0 } },
    }),
  };
  // 同じモデルへの再試行。Apps Scriptのウェブアプリには実行時間の上限があるため控えめに。
  var RETRY_DELAYS_MS = [800, 2000];
  var code = 0, body = '';
  for (var attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    var res = UrlFetchApp.fetch(url, options);
    code = res.getResponseCode();
    body = res.getContentText();
    if (code === 200) break;
    if (!shouldRetrySameModel_(code) || attempt === RETRY_DELAYS_MS.length) break;
    // 待ち時間ぶんの余裕がもう無ければ、このモデルは諦めて次のモデルへ回す。
    if (new Date().getTime() + RETRY_DELAYS_MS[attempt] > deadlineMs) break;
    Utilities.sleep(RETRY_DELAYS_MS[attempt]);
  }
  return { code: code, body: body };
}

// 本命モデル → 代替モデルの順に試す。人気モデルは混雑(503)しやすいので、
// 同じモデルを叩き続けるのではなく、控えのモデルに切り替えたほうが成功しやすい。
function callGemini_(apiKey, prompt, maxTokens) {
  var models = [GEMINI_MODEL].concat(GEMINI_FALLBACK_MODELS || []);
  // Apps Scriptの実行時間上限に引っかかって「応答なし」になるのを避けるための全体の締め切り。
  var deadlineMs = new Date().getTime() + 25000;
  var lastCode = 0, lastBody = '';
  for (var i = 0; i < models.length; i++) {
    var r = callGeminiModel_(apiKey, models[i], prompt, maxTokens, deadlineMs);
    if (r.code === 200) {
      var data = JSON.parse(r.body);
      var cand = data.candidates && data.candidates[0];
      if (!cand || !cand.content || !cand.content.parts) {
        // 空応答の原因調査用にfinishReason(MAX_TOKENS/SAFETYなど)を添えて返す。
        var reason = cand && cand.finishReason ? cand.finishReason : '不明';
        throw new Error('Geminiから本文が返りませんでした(finishReason: ' + reason + ' / モデル: ' + models[i] + ')');
      }
      return cand.content.parts.map(function (p) { return p.text || ''; }).join('');
    }
    lastCode = r.code;
    lastBody = r.body;
    if (!shouldTryNextModel_(r.code)) break;
    if (new Date().getTime() > deadlineMs) break;
  }
  throw new Error('Gemini APIエラー (HTTP ' + lastCode + '): ' + lastBody.slice(0, 300));
}

/* ====================== ユーティリティ ====================== */

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

/** 文字列比較の所要時間から中身を推測されないようにする(タイミング攻撃対策)。 */
function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** ```json ... ``` で囲まれて返ってくることがあるので剥がしてからパースする。 */
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
