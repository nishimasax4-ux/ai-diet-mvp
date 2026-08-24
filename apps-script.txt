/**
 * Training Log + AI — Apps Script バックエンド (v8)
 *
 * 【スクリプトプロパティに設定するもの】
 *   APP_TOKEN       … アプリの「設定」タブに入れる合言葉。適当な長い文字列でOK。
 *                     (例: openssl rand -hex 24 の出力)
 *   GEMINI_API_KEY  … Google AI Studio で発行したAPIキー。AI機能を使う場合のみ。
 *   GROQ_API_KEY    … (任意・v23〜) console.groq.com で発行した無料APIキー。
 *                     クレジットカード登録不要で、1日あたりの無料枠もGeminiより
 *                     大幅に広い。Geminiのモデルをすべて試してもダメだったとき
 *                     (無料枠切れ・混雑など)の最終手段として使われる。
 *                     GEMINI_API_KEYを設定せずこちらだけ設定してもAI機能は動く。
 *   SHEET_ID        … 書き込み先スプレッドシートのID。省略時はこのスクリプトの
 *                     コンテナ(バインドされたシート)を使う。
 *
 * 【デプロイ】
 *   「ウェブアプリ」/ 実行するユーザー: 自分 / アクセスできるユーザー: 全員
 *   ※「全員」でないと動きませんが、APP_TOKEN が無いリクエストは弾くので、
 *     URLを知られただけでは書き込まれません。
 *
 * 【自動で使うスクリプトプロパティ(手動設定は不要)】
 *   LAST_WRITE_AT   … (v32〜) 複数端末での上書き事故に気づけるよう、書き込みの
 *                     たびに自動更新される最終書き込み時刻。ユーザーが手で設定
 *                     する必要はない。詳細はhandleSave_のコメントを参照。
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
// 「軽量(lite)」モデル。無料枠の1日あたりの上限が本家Flashより数倍広く取られている
// (調査時点でFlash系は1日あたり数百件程度まで絞られていたのに対し、lite系は1,000件程度)。
// 精度は本家Flashにやや劣るが、食品名→カロリー概算のような単純な構造化抽出や、
// 短いコメント生成には十分実用的。無料枠をすぐ使い切ってしまう対策として、
// 呼び出し頻度の高い「栄養価の概算」はこちらを優先し、本家Flash系の枠を温存する。
var GEMINI_LITE_MODELS = ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'];
// 栄養価の概算(食事を記録するたびに呼ばれうる、頻度の高い機能)用のモデル順。
// 軽量モデルを先に試し、枠が尽きていたら本家Flash系にも回す。
var NUTRITION_MODELS = GEMINI_LITE_MODELS.concat([GEMINI_MODEL]).concat(GEMINI_FALLBACK_MODELS);
// 「AIのひとこと」(1日に数回程度しか呼ばれない機能)用のモデル順。
// 文章の質を優先して本家Flash系から試し、すべて枠切れのときだけ軽量モデルにも回す。
var ADVICE_MODELS = [GEMINI_MODEL].concat(GEMINI_FALLBACK_MODELS).concat(GEMINI_LITE_MODELS);
// Groq(https://console.groq.com)の無料枠で使えるモデル。クレジットカード登録不要で、
// 1日あたりの上限もGeminiよりかなり広い(執筆時点でモデルにより1日1,000〜数千件)。
// 日本語の指示追従・簡単なJSON整形にも十分実用的なため、Geminiが全滅したときの
// 最終手段としてちょうどよい。
var GROQ_MODEL = 'llama-3.3-70b-versatile';

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
    if (action === 'save')              return json_(handleSave_(body.payload, body.knownWriteAt, body.force));
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
 *
 * 【上書き事故防止(v32)】この同期は毎回全件を丸ごと上書きする設計になっており
 * (差分マージはしていない)、複数端末で使うと「あとから同期した端末が勝つ」——
 * つまり、他の端末が書き込んだ内容が黙って消えるリスクがある。真の解決(レコード
 * 単位のマージ)はシート列構成の変更を伴う大掛かりな話になるため、まずは
 * 「事故が起きる前に気づける」軽量な安全策として、書き込みのたびに
 * スクリプトプロパティ LAST_WRITE_AT を更新し、次の書き込み時にこの端末が
 * 最後に把握していた時刻(knownWriteAt)と食い違っていないか確認する。
 * 食い違っていれば「他の端末が新しく書き込んでいる」ということなので、
 * force(強制上書き)が指定されていない限り書き込みを止め、conflictを返す。
 * knownWriteAtが未送信(index.htmlがこの機能に対応する前のバージョンなど)の
 * 場合はチェックをスキップし、これまで通り動く(後方互換)。
 */
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
  // 上書き事故防止(v32): このタイミングでのサーバー側の最終書き込み時刻を返す。
  // 復元(シートから読み込み)した端末は、この時刻を「自分が把握している最新」として
  // 覚えておき、次に自分がシートへ書き込むときの食い違いチェックに使う。
  return { status: 'ok', payload: payload, lastWriteAt: prop_('LAST_WRITE_AT') || null };
}

/** Sheetsが日付型で返してきたセルを YYYY-MM-DD の文字列に揃える。 */
function normalizeCell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v;
}

/* ====================== Gemini ====================== */

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

/**
 * 直近のトレーニング・食事・体重データを渡して、コメントを生成させる。
 * アプリ側の「AIのひとこと」は既定ではルールベースなので、ここが唯一
 * 本物のAIが文章を書く場所になる。
 */
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

// 混雑(503)やサーバーエラー(5xx)は、数秒待てば直ることがあるので同じモデルに再試行する。
// 429(レート超過・無料枠の上限)は【あえて再試行しない】。枠を使い切っている状態で叩き直しても
// 成功しないうえ、リクエスト数をさらに消費してレート制限を悪化させるだけのため。
function shouldRetrySameModel_(code) {
  return code === 503 || (code >= 500 && code < 600);
}
// APIキー自体が無効な場合だけは、どのモデルに変えても・どう再試行しても直らないので即中断する。
// 「モデルを変えても無駄な400」はこれだけ、という判定に絞るのが要点(下の shouldTryNextModel_ 参照)。
function isFatalGeminiError_(code, body) {
  return code === 400 && /API key not valid|API_KEY_INVALID/i.test(String(body || ''));
}
// 別のモデルなら通る可能性があるケース。無料枠はモデルごとに別枠なので、429でも
// モデルを変えれば通ることがある。404(モデル廃止)も同様に次のモデルを試す価値がある。
//
// 400も「次のモデルを試す」対象に含める。以前は400を一律で即中断扱いにしていたが、
// 実際には gemini-3.x系だけがリクエスト形式の違い(thinkingConfig)で400を返す、という
// 【モデル固有の400】が起きた。即中断していたため、残りのモデルにもGroqにも回らないまま
// 全滅していた。キー不正(isFatalGeminiError_)だけを即中断とし、それ以外の400は
// 「そのモデル固有の問題かもしれない」と考えて次に回す。
function shouldTryNextModel_(code, body) {
  if (isFatalGeminiError_(code, body)) return false;
  if (code === 400) return true;
  return code === 429 || code === 404 || shouldRetrySameModel_(code);
}

// 「思考」を最小化/無効化して、短い構造化出力(JSON概算・短文コメント)でも
// maxOutputTokensを思考側だけで使い切って本文が空になる事故を防ぐ
// (「AIの応答を解釈できませんでした」エラーの原因だった)。
// ただし制御フィールドはモデル世代で違う: gemini-2.5系は数値の thinkingBudget、
// gemini-3.x系は新しい thinkingLevel(minimal/low/medium/high)を使う。
// 世代違いのフィールドを送るとHTTP 400 (INVALID_ARGUMENT)で拒否されることがある。
function thinkingConfigFor_(model) {
  return /^gemini-3/.test(model) ? { thinkingLevel: 'minimal' } : { thinkingBudget: 0 };
}

// 1つのモデルに対する実際のHTTPリクエスト(同一モデルへの再試行を含む)。
// thinkingConfig に null を渡すと、その項目自体を送らない。
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

function callGeminiModel_(apiKey, model, prompt, maxTokens, deadlineMs) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
            model + ':generateContent?key=' + encodeURIComponent(apiKey);
  var r = callGeminiRaw_(url, prompt, maxTokens, thinkingConfigFor_(model), deadlineMs);
  // 【保険】400が返り、かつキー不正ではない場合、thinkingConfig の指定方法がこのモデルに
  // 受け入れられなかった可能性がある。Googleは世代ごとにこの指定方法を変えてきた実績があり
  // (2.5系=thinkingBudget → 3.x系=thinkingLevel)、今後また変わっても自力で復帰できるよう、
  // thinkingConfig を丸ごと外して1回だけ試し直す。思考ぶんのトークンを食われて本文が空に
  // なるのを避けるため、この再試行だけ出力上限を広げる。
  if (r.code === 400 && !isFatalGeminiError_(r.code, r.body) && new Date().getTime() < deadlineMs) {
    var retry = callGeminiRaw_(url, prompt, (maxTokens || 512) * 2, null, deadlineMs);
    // 再試行も失敗した場合は、元のエラーのほうが原因究明に役立つのでそちらを返す。
    if (retry.code === 200) return retry;
  }
  return r;
}

// モデルを順番に試す。人気モデルは混雑(503)しやすく、無料枠(429)もモデルごとに
// 別枠なので、同じモデルを叩き続けるのではなく、リストの順に切り替えたほうが成功しやすい。
// models を省略した場合は本家Flash系のみ(後方互換用)。
function callGemini_(apiKey, prompt, maxTokens, models) {
  models = models || [GEMINI_MODEL].concat(GEMINI_FALLBACK_MODELS || []);
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
    if (!shouldTryNextModel_(r.code, r.body)) break;
    if (new Date().getTime() > deadlineMs) break;
  }
  throw new Error('Gemini APIエラー (HTTP ' + lastCode + '): ' + lastBody.slice(0, 300));
}

// Groq(OpenAI互換のchat completions形式)を1回だけ呼ぶ。クレジットカード不要の
// 無料枠を持つプロバイダで、Geminiが全滅したときの最終手段として使う。
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
  if (code !== 200) {
    throw new Error('Groq APIエラー (HTTP ' + code + '): ' + body.slice(0, 300));
  }
  var data = JSON.parse(body);
  var choice = data.choices && data.choices[0];
  var text = choice && choice.message && choice.message.content;
  if (!text) throw new Error('Groqから本文が返りませんでした(応答: ' + body.slice(0, 200) + ')');
  return text;
}

// AI呼び出しの入口。GEMINI_API_KEY・GROQ_API_KEYのうち設定されているものだけを使う
// (どちらか一方だけでも動く)。両方設定されていれば、まずGemini(models で指定した
// 優先順)を試し、すべてダメだった場合だけGroqを最終手段として試す。
// 両方失敗した場合は、原因の分かりやすいGemini側のエラーを優先して返す
// (Gemini未設定でGroqのみ失敗した場合はGroq側のエラーを返す)。
function callAi_(prompt, maxTokens, geminiModels) {
  var geminiKey = prop_('GEMINI_API_KEY');
  var groqKey = prop_('GROQ_API_KEY');
  if (!geminiKey && !groqKey) {
    throw new Error('GEMINI_API_KEYもGROQ_API_KEYも設定されていません(どちらか一方の設定で動作します)');
  }
  var geminiError = null;
  if (geminiKey) {
    try {
      return callGemini_(geminiKey, prompt, maxTokens, geminiModels);
    } catch (e) {
      geminiError = e;
    }
  }
  if (groqKey) {
    try {
      return callGroq_(groqKey, prompt, maxTokens);
    } catch (groqError) {
      throw geminiError || groqError;
    }
  }
  throw geminiError;
}

/**
 * 【診断用】AIまわりの設定と、各モデルが実際に使えるかどうかを1件ずつ確認する。
 *
 * 使い方: Apps Scriptエディタ上部の関数の一覧から「testAi」を選んで「実行」。
 *         下に出る「実行ログ」に、モデルごとの結果(OK / HTTPエラーコード)が並びます。
 *
 * アプリを操作しなくても、どのモデルが通ってどれがダメなのかが一目で分かります。
 * 失敗したときのエラー本文もそのまま出るので、原因の切り分けに使えます。
 * ※1回の実行で各モデルに1リクエストずつ送るので、無料枠を少し消費します。
 */
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
