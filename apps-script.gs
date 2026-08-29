/**
 * Training Log + AI — Apps Script バックエンド (v38)
 *
 * ★重要★ このファイルは、これまでどおりの「全件上書き同期」版のアプリ
 * (index.html の APP_VERSION が v38 など)と対になっています。
 * 別系統の「差分同期版(v2系)」のapps-script.gsを貼ると、save/loadが
 * 『不明なaction』で弾かれて同期できなくなるのでご注意ください。
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
// 文章生成は1回あたりの所要時間が長いので、総当たりせず先頭3つまでに絞る。
// 5モデルすべてを順に試すと、混雑時に合計で45秒(ブラウザ側の制限時間)を超えてしまう。
var ADVICE_MODELS = [GEMINI_MODEL].concat(GEMINI_FALLBACK_MODELS).concat(GEMINI_LITE_MODELS).slice(0, 3);
// Groq(https://console.groq.com)の無料枠で使えるモデル。クレジットカード登録不要で、
// 1日あたりの上限もGeminiよりかなり広い(執筆時点でモデルにより1日1,000〜数千件)。
// 日本語の指示追従・簡単なJSON整形にも十分実用的なため、Geminiが全滅したときの
// 最終手段としてちょうどよい。
var GROQ_MODEL = 'llama-3.3-70b-versatile';

// このファイルの版数(v38〜)。アプリ側は、対になっていないapps-script.gs
// (差分同期版など)が貼られている状態を『不明なaction』の応答から検知して案内する。
var BACKEND_VERSION = 'v39.1';

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

/**
 * 今日の残りカロリー・不足している栄養素・運動量・よく食べているものを渡して、
 * 具体的な朝食・夕食の献立を提案させる(v39)。
 * アプリ側はルールベースの提案を常に表示しており、これはその上乗せなので、
 * 取得に失敗しても機能そのものが使えなくなることはない。
 */
function handleMealPlan_(ctx) {
  if (!ctx) return { status: 'error', message: 'contextがありません' };

  var prompt =
    'あなたは日本の家庭料理に詳しい、親しみやすい管理栄養士です。\n' +
    '以下は利用者の「今日の状況」です(JSON)。これをもとに、今日の朝食と夕食の献立を日本語で提案してください。\n\n' +
    '### 守ること\n' +
    '- 朝食と夕食について、それぞれ具体的な献立を1案ずつ挙げる(主食・主菜・副菜がわかる程度に)\n' +
    '- それぞれ、おおよそのカロリーを添える。「区分ごとの目安kcal」に収まるようにする\n' +
    '- 「よく食べている朝食」「よく食べている夕食」「登録済みのよく食べるもの」に挙がっている食品を、可能な範囲で活かす\n' +
    '- 「今日まだ不足しているPFCg」で不足している栄養素(特にたんぱく質)を補える内容にする\n' +
    '- 日本のスーパーやコンビニで手に入る、平日でも用意できる現実的なものにする\n' +
    '- 全体で250文字程度。見出しや箇条書きは使わず、「朝食は〜。夕食は〜。」という地の文で書く\n' +
    '- 断定的な医学的助言・診断はしない。極端な食事制限や、特定の食品を絶対に食べるなという言い方はしない\n' +
    '- カロリーや栄養素はあくまで目安である、という前提を崩さない\n' +
    '- 記録が少ないことや、食べ過ぎたことを責めない。前向きで落ち着いた口調で\n\n' +
    '### 今日の状況\n' +
    JSON.stringify(ctx);

  var text = callAi_(prompt, 900, ADVICE_MODELS);
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
// 【v38.1で方針変更】以前は gemini-3.x系に thinkingLevel:'minimal' を送っていたが、
// 同じ3.x系でもモデルによってこの値を受け付けず、
//   「Thinking level MINIMAL is not supported for this model.」(HTTP 400)
// で失敗することが分かった(gemini-3.5-flash-lite など。googleapis/js-genai の
// issue #1581 でも、3系のflash-liteがminimalを拒否する事例が報告されている)。
//
// どの世代のどのモデルがどの値を受け付けるかは、Googleの都合で今後も変わり続ける。
// そこを当て続けるのは現実的でないので、「送らない」という常に有効な選択に倒す:
//   ・gemini-2.5系 … thinkingBudget:0 は実績があるのでそのまま使う
//   ・それ以外(3.x系・将来の世代) … thinkingConfig自体を送らない(nullを返す)
// 「思考」を止められないぶん、出力上限を広めに取ることで
// 「思考だけで上限を使い切って本文が空になる」事故を防ぐ(callGeminiModel_参照)。
function thinkingConfigFor_(model) {
  // gemini-2.5系 … 数値の thinkingBudget:0(実績あり)
  // gemini-3.x系 … thinkingLevel。'minimal' は一部モデル(flash-lite系)が非対応で
  //   HTTP 400になるため使わない。'low' はそれらのモデルでも受け付けられる
  //   (googleapis/js-genai issue #1581 では、非対応なのは minimal と medium と報告されている)。
  //   ここで「思考」を抑えないと、モデルが長時間考え込んで応答が数十秒かかり、
  //   ブラウザ側が45秒で time out する(v38.1で実際に発生)。
  // 万一 'low' も拒否された場合は、callGeminiModel_ が指定を外して自動で試し直す。
  return /^gemini-2\.5/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: 'low' };
}
// thinkingConfigを送らないときの出力上限。思考ぶんに食われても本文が残るよう余裕を持たせる。
// thinkingConfigを外して試し直すときの出力上限。思考ぶんに食われても本文が残る程度に
// 広げるが、広げすぎるとモデルがそのぶん長く考えて応答が遅くなるため、控えめにする。
function roomyMaxTokens_(maxTokens) {
  return Math.max(1536, (maxTokens || 512) * 2);
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
  var thinking = thinkingConfigFor_(model);
  // 「思考」を止める指定を送らないモデルでは、思考ぶんで出力上限を使い切って本文が
  // 空になるのを防ぐため、最初から出力上限を広めに取る。
  var tokens = thinking ? (maxTokens || 512) : roomyMaxTokens_(maxTokens);
  var r = callGeminiRaw_(url, prompt, tokens, thinking, deadlineMs);
  // 【保険】thinkingConfigを送ったうえで400(かつキー不正ではない)が返った場合、
  // その指定方法をこのモデルが受け付けなかった可能性がある。指定を丸ごと外して
  // 1回だけ試し直す(締め切りが迫っていても、この1回は必ず試す。ここを飛ばすと
  // 「対応していない指定を送り続けて全モデル失敗」から自力で復帰できないため)。
  if (thinking && r.code === 400 && !isFatalGeminiError_(r.code, r.body)) {
    var retry = callGeminiRaw_(url, prompt, roomyMaxTokens_(maxTokens), null, deadlineMs);
    // 再試行も失敗した場合は、元のエラーのほうが原因究明に役立つのでそちらを返す。
    if (retry.code === 200) return retry;
  }
  return r;
}

// モデルを順番に試す。人気モデルは混雑(503)しやすく、無料枠(429)もモデルごとに
// 別枠なので、同じモデルを叩き続けるのではなく、リストの順に切り替えたほうが成功しやすい。
// models を省略した場合は本家Flash系のみ(後方互換用)。
function callGemini_(apiKey, prompt, maxTokens, models, budgetMs) {
  models = models || [GEMINI_MODEL].concat(GEMINI_FALLBACK_MODELS || []);
  // 全体の締め切り。Geminiが混雑(503)しているとモデルごとに再試行の待ち時間が積み上がり、
  // 応答が返るまでにブラウザ側(特にiOS Safari)が先に諦めて「Load failed」になっていた。
  // 予算は呼び出し元(callAi_)が決める: Groqが控えにいるなら短く、Geminiしか無いなら長く。
  var deadlineMs = new Date().getTime() + (budgetMs || 20000);
  var lastCode = 0, lastBody = '';
  for (var i = 0; i < models.length; i++) {
    // 次のモデルを「試し始める」前に締め切りを確認する。1回の呼び出し自体は途中で
    // 打ち切れないので、ここで止めないと予算を大きく超えて応答が返らなくなる。
    if (i > 0 && new Date().getTime() > deadlineMs) break;
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
  // 一時的な混雑(5xx)だけ、1回だけ短い間隔を空けて再試行する。429(枠切れ)は叩き直しても
  // 成功しないので再試行しない(Gemini側と同じ考え方)。
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

// AI呼び出しの入口。GEMINI_API_KEY・GROQ_API_KEYのうち設定されているものだけを使う
// (どちらか一方だけでも動く)。
//
// 【v38で呼び出し順を変更】以前はGeminiを先に総当たりし、全滅したときだけGroqへ
// 回していた。しかしGeminiが混雑・枠切れだと、モデル5種類ぶんの試行と再試行の待ち時間が
// 積み上がって応答までに数十秒かかり、iPhoneのSafariが先に接続を諦めて「Load failed」に
// なっていた(「🤖 AIのひとこと」が使えない主因)。Groqは応答が速く1日あたりの無料枠も
// 広いため、設定されていればGroqを最優先で1回だけ呼ぶ。Geminiは、Groq未設定または
// Groq失敗時の控えとして使う。
//
// 両方失敗した場合は、原因の切り分けに使える情報が多いGemini側のエラーを優先して返す
// (Gemini未設定なら当然Groq側のエラーを返す)。
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
      // Groqが控えにいる場合は短めに切り上げる。Geminiしか無い場合は、諦めるのが
      // 早すぎて『どのモデルも試し切れずに失敗』とならないよう、長めの予算を与える。
      return callGemini_(geminiKey, prompt, maxTokens, geminiModels, groqKey ? 10000 : 22000);
    } catch (e) {
      geminiError = e;
    }
  }
  // Geminiだけを設定していて、そのGeminiが不調(混雑・無料枠切れ・モデル側の仕様変更)の
  // ときは、Groqを設定すれば回避できる。エラー文にその案内を添える。
  if (geminiError && !groqKey) {
    throw new Error(String(geminiError.message || geminiError) +
      ' ／ 現在GROQ_API_KEYが未設定のため、Geminiが不調だとAI機能が使えません。' +
      'console.groq.com で無料のキーを発行し(クレジットカード登録不要)、Apps Scriptの' +
      '「プロジェクトの設定」→「スクリプト プロパティ」に GROQ_API_KEY として登録すると、' +
      'Groq側が優先して使われるためこの種のエラーを回避できます。');
  }
  throw geminiError || groqError;
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

/**
 * 接続確認(v39.1)。版数に加えて、AIキーが設定されているかどうかを真偽値だけで返す。
 * キーの値そのものは返さない——「設定されているか」が分かれば、アプリ側で
 * 「Groq未設定なのでGeminiの不調をそのまま受けている」状態を案内できる。
 */
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
