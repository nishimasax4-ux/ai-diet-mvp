/**
 * Training Log + AI (v44.1)  5/5  AI機能.gs — 各AI機能とAI中継
 *
 * このコードは5つのファイルに分けてあります(スマホでは長い貼り付けが
 * 途中で切れることがあるため)。5つすべてを貼り付けて初めて動きます。
 * 1ファイル版(apps-script-1file.gs)を貼れた方は、こちらは不要です。
 */

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
