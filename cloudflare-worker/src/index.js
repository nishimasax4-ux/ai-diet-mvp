/**
 * Training Log + AI — Cloudflare Workers版バックエンド
 *
 * apps-script-1file.gs(Google Apps Script版)と同じAPI(doPost互換)を実装した
 * ドロップイン代替です。index.htmlの「設定」タブ→「Google Sheets連携」のURL欄に、
 * このWorkerをデプロイしたURL(例: https://training-log-backend.your-subdomain.workers.dev)
 * をそのまま貼り付けて使えます。アプリ側の変更は不要です。
 *
 * データの保存先は引き続きGoogleスプレッドシートです(Google Sheets APIをサービス
 * アカウントで呼び出します)。実行環境だけをApps ScriptからCloudflare Workersに
 * 置き換える、という位置づけです。
 *
 * 【必要なシークレット】 wrangler secret put <名前> で設定してください。
 *   APP_TOKEN            … アプリの設定タブに入れる合言葉(必須)
 *   SHEET_ID             … 同期先のGoogleスプレッドシートのID(必須)
 *   GOOGLE_CLIENT_EMAIL  … サービスアカウントのメールアドレス(必須)
 *   GOOGLE_PRIVATE_KEY   … サービスアカウントの秘密鍵(PEM形式、必須)
 *   GEMINI_API_KEY       … Google AI Studioで発行(任意)
 *   GROQ_API_KEY         … console.groq.comで発行(推奨。写真判定にも使われます)
 *
 * 【必要なバインディング】 wrangler.tomlで設定してください。
 *   KV Namespace "SYNC_KV" … 最終書き込み時刻の記録・Googleアクセストークンのキャッシュに使用
 *
 * 詳しいセットアップ手順は README.md を参照してください。
 */

// ============ モデル設定(apps-script-1file.gsと同じ内容) ============
const GEMINI_MODEL = 'gemini-3.7-flash';
const GEMINI_FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-2.5-flash'];
const GEMINI_LITE_MODELS = ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'];
const NUTRITION_MODELS = [...GEMINI_LITE_MODELS, GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];
const ADVICE_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', GEMINI_MODEL];
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_VISION_MODELS = ['qwen/qwen3.6-27b', 'qwen/qwen3.8-27b'];
const BACKEND_VERSION = 'v1.0-cf';
const SHEET_NAMES = ['筋トレ', '有酸素', '体重', '食事'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json;charset=utf-8', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    if (request.method !== 'POST') return json({ status: 'error', message: 'POST only' });

    let body;
    try {
      body = JSON.parse(await request.text());
    } catch (e) {
      return json({ status: 'error', message: 'リクエストの本文がJSONとして読めませんでした' });
    }

    try {
      const expected = env.APP_TOKEN;
      if (!expected) return json({ status: 'error', message: 'サーバ側にAPP_TOKENが設定されていません' });
      if (!body.token || !safeEqual(String(body.token), expected)) {
        return json({ status: 'error', message: '認証に失敗しました(トークンが一致しません)' });
      }

      const action = body.action || 'save';
      if (action === 'ping') return json(await handlePing(env));
      if (action === 'save') return json(await handleSave(env, body.payload, body.knownWriteAt, body.force));
      if (action === 'load') return json(await handleLoad(env));
      if (action === 'estimateNutrition') return json(await handleNutrition(env, body.foodName));
      if (action === 'advice') return json(await handleAdvice(env, body.context));
      if (action === 'mealPlan') return json(await handleMealPlan(env, body.context));
      if (action === 'analyzePhoto') return json(await handleAnalyzePhoto(env, body.imageBase64, body.mimeType));
      if (action === 'aiText') return json(await handleAiText(env, body));
      if (action === 'aiVision') return json(await handleAiVision(env, body));
      return json({ status: 'error', message: '不明なaction: ' + action });
    } catch (err) {
      return json({ status: 'error', message: String(err && err.message ? err.message : err) });
    }
  },
};

// ============ 認証 ============
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ============ ping ============
async function handlePing(env) {
  return {
    status: 'ok',
    backendVersion: BACKEND_VERSION,
    ai: { gemini: !!env.GEMINI_API_KEY, groq: !!env.GROQ_API_KEY },
  };
}

// ============ Google認証(サービスアカウント・JWT) ============
function base64url(data) {
  let binary;
  if (typeof data === 'string') {
    binary = unescape(encodeURIComponent(data));
  } else {
    const bytes = new Uint8Array(data);
    binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function signJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;

  // 秘密鍵は、サービスアカウントのJSONからコピーしたままの文字列(\nがエスケープ
  // された状態)で渡されることが多いため、実際の改行に戻してからインポートする。
  const pem = String(env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );
  return `${unsigned}.${base64url(signature)}`;
}

async function getAccessToken(env) {
  // KVにキャッシュがあれば使い回す(Google側のトークン発行回数を減らし、応答も速くなる)。
  const cachedRaw = await env.SYNC_KV.get('GOOGLE_ACCESS_TOKEN');
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw);
      if (cached.exp > Date.now() + 60000) return cached.token;
    } catch (e) { /* 壊れていたら取り直す */ }
  }

  const assertion = await signJwt(env);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      'Google認証に失敗しました: ' +
      (data.error_description || data.error || JSON.stringify(data)) +
      '(GOOGLE_CLIENT_EMAIL・GOOGLE_PRIVATE_KEYの設定、サービスアカウントへのスプレッドシート共有をご確認ください)'
    );
  }
  const expiresIn = data.expires_in || 3600;
  await env.SYNC_KV.put(
    'GOOGLE_ACCESS_TOKEN',
    JSON.stringify({ token: data.access_token, exp: Date.now() + expiresIn * 1000 }),
    { expirationTtl: expiresIn }
  );
  return data.access_token;
}

// ============ Google Sheets API ============
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

async function sheetsFetch(env, path, options = {}) {
  const token = await getAccessToken(env);
  const res = await fetch(`${SHEETS_API}/${env.SHEET_ID}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error('Sheets APIエラー: ' + (data.error && data.error.message ? data.error.message : JSON.stringify(data)));
  }
  return data;
}

// シート名を "'名前'" の形でA1記法に埋め込む(名前中の ' はエスケープ)。
function a1Sheet(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

async function writeSheetValues(env, title, header, rows, sheetId) {
  const values = header.length ? [header, ...rows] : rows;
  // GAS版のsh.clear()と同じく、シートの中身を丸ごと消してから書き直す方式。
  await sheetsFetch(env, `/values/${encodeURIComponent(a1Sheet(title))}:clear`, { method: 'POST', body: '{}' });
  if (values.length) {
    await sheetsFetch(env, `/values/${encodeURIComponent(a1Sheet(title) + '!A1')}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values }),
    });
  }
  if (header.length && sheetId != null) {
    // 見出し行の太字・1行目の固定・列幅の自動調整(GAS版の見た目を踏襲)。
    await sheetsFetch(env, ':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
          { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
          { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: Math.max(1, header.length) } } },
        ],
      }),
    });
  }
}

async function handleSave(env, payload, knownWriteAt, force) {
  if (!payload || typeof payload !== 'object') return { status: 'error', message: 'payloadがありません' };

  // GAS版のLockServiceによる排他制御は、Cloudflare KVの性質上そのままは再現していない
  // (README.mdの「既知の制限」を参照)。他端末との食い違い検知(conflict)だけは踏襲する。
  const lastWriteAt = await env.SYNC_KV.get('LAST_WRITE_AT');
  if (!force && knownWriteAt && lastWriteAt && knownWriteAt !== lastWriteAt) {
    return {
      status: 'conflict',
      lastWriteAt,
      message: '他の端末で、この端末が把握している内容より新しいデータが書き込まれています。',
    };
  }

  const meta = await sheetsFetch(env, '?fields=sheets.properties');
  const titleToId = {};
  (meta.sheets || []).forEach(s => { titleToId[s.properties.title] = s.properties.sheetId; });

  const names = Object.keys(payload);
  const missing = names.filter(n => !(n in titleToId));
  if (missing.length) {
    const addRes = await sheetsFetch(env, ':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ requests: missing.map(title => ({ addSheet: { properties: { title } } })) }),
    });
    (addRes.replies || []).forEach(r => {
      if (r.addSheet) titleToId[r.addSheet.properties.title] = r.addSheet.properties.sheetId;
    });
  }

  let written = 0;
  for (const name of names) {
    const t = payload[name] || {};
    const header = t.header || [];
    const rows = t.rows || [];
    await writeSheetValues(env, name, header, rows, titleToId[name]);
    written += rows.length;
  }

  const now = new Date().toISOString();
  await env.SYNC_KV.put('LAST_WRITE_AT', now);
  return { status: 'ok', written, at: now, lastWriteAt: now };
}

async function handleLoad(env) {
  const payload = {};
  for (const name of SHEET_NAMES) {
    let data;
    try {
      data = await sheetsFetch(env, `/values/${encodeURIComponent(a1Sheet(name))}`);
    } catch (e) {
      // シートがまだ存在しない場合はSheets APIがエラーを返すので、空として扱う。
      payload[name] = { header: [], rows: [] };
      continue;
    }
    const values = data.values || [];
    if (!values.length) { payload[name] = { header: [], rows: [] }; continue; }
    const header = values[0];
    const rows = values.slice(1).filter(r => String(r[0] || '').trim() !== '');
    payload[name] = { header, rows };
  }
  const lastWriteAt = await env.SYNC_KV.get('LAST_WRITE_AT');
  return { status: 'ok', payload, lastWriteAt: lastWriteAt || null };
}

// ============ AI呼び出し(Gemini / Groq、apps-script-1file.gsと同じロジック) ============
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function shouldRetrySameModel(code) { return code === 503 || (code >= 500 && code < 600); }
function isFatalGeminiError(code, body) { return code === 400 && /API key not valid|API_KEY_INVALID/i.test(String(body || '')); }
function shouldTryNextModel(code, body) {
  if (isFatalGeminiError(code, body)) return false;
  if (code === 400) return true;
  return code === 429 || code === 404 || shouldRetrySameModel(code);
}
function thinkingConfigFor(model) {
  return /^gemini-2\.5/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: 'low' };
}
function roomyMaxTokens(maxTokens) { return Math.max(1536, (maxTokens || 512) * 2); }

async function callGeminiRaw(url, prompt, maxTokens, thinkingConfig, deadlineMs, image, wantJson) {
  const generationConfig = { temperature: 0.4, maxOutputTokens: maxTokens || 512 };
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  if (wantJson) generationConfig.responseMimeType = 'application/json';
  const body = JSON.stringify({
    contents: [{
      parts: image
        ? [{ inline_data: { mime_type: image.mimeType || 'image/jpeg', data: image.data } }, { text: prompt }]
        : [{ text: prompt }],
    }],
    generationConfig,
  });

  const RETRY_DELAYS_MS = [800, 2000];
  let code = 0, text = '';
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    code = res.status;
    text = await res.text();
    if (code === 200) break;
    if (!shouldRetrySameModel(code) || attempt === RETRY_DELAYS_MS.length) break;
    if (Date.now() + RETRY_DELAYS_MS[attempt] > deadlineMs) break;
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  return { code, body: text };
}

async function callGeminiModel(apiKey, model, prompt, maxTokens, deadlineMs, wantJson) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const thinking = thinkingConfigFor(model);
  const tokens = thinking ? (maxTokens || 512) : roomyMaxTokens(maxTokens);
  const r = await callGeminiRaw(url, prompt, tokens, thinking, deadlineMs, null, wantJson);
  if (thinking && r.code === 400 && !isFatalGeminiError(r.code, r.body)) {
    const retry = await callGeminiRaw(url, prompt, roomyMaxTokens(maxTokens), null, deadlineMs, null, wantJson);
    if (retry.code === 200) return retry;
  }
  return r;
}

async function callGemini(apiKey, prompt, maxTokens, models, budgetMs, wantJson) {
  models = models && models.length ? models : [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];
  const deadlineMs = Date.now() + (budgetMs || 20000);
  let lastCode = 0, lastBody = '';
  for (let i = 0; i < models.length; i++) {
    if (i > 0 && Date.now() > deadlineMs) break;
    const r = await callGeminiModel(apiKey, models[i], prompt, maxTokens, deadlineMs, wantJson);
    if (r.code === 200) {
      const data = JSON.parse(r.body);
      const cand = data.candidates && data.candidates[0];
      if (!cand || !cand.content || !cand.content.parts) {
        const reason = cand && cand.finishReason ? cand.finishReason : '不明';
        throw new Error(`Geminiから本文が返りませんでした(finishReason: ${reason} / モデル: ${models[i]})`);
      }
      return cand.content.parts.map(p => p.text || '').join('');
    }
    lastCode = r.code; lastBody = r.body;
    if (!shouldTryNextModel(r.code, r.body)) break;
    if (Date.now() > deadlineMs) break;
  }
  throw new Error(`Gemini APIエラー (HTTP ${lastCode}): ${lastBody.slice(0, 300)}`);
}

async function callGroq(apiKey, prompt, maxTokens, model, image, wantJson) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const content = image
    ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${image.mimeType || 'image/jpeg'};base64,${image.data}` } }]
    : prompt;
  const payload = {
    model: model || GROQ_MODEL,
    messages: [{ role: 'user', content }],
    temperature: 0.4,
    max_tokens: maxTokens || 512,
  };
  if (wantJson) payload.response_format = { type: 'json_object' };
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };

  let res = await fetch(url, { method: 'POST', headers, body });
  let code = res.status, text = await res.text();
  if (code >= 500 && code < 600) {
    await sleep(800);
    res = await fetch(url, { method: 'POST', headers, body });
    code = res.status; text = await res.text();
  }
  if (code !== 200) throw new Error(`Groq APIエラー (HTTP ${code}): ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const choice = data.choices && data.choices[0];
  const out = choice && choice.message && choice.message.content;
  if (!out) throw new Error(`Groqから本文が返りませんでした(応答: ${text.slice(0, 200)})`);
  return out;
}

async function callAi(env, prompt, maxTokens, geminiModels, wantJson) {
  const geminiKey = env.GEMINI_API_KEY, groqKey = env.GROQ_API_KEY;
  if (!geminiKey && !groqKey) throw new Error('GEMINI_API_KEYもGROQ_API_KEYも設定されていません(どちらか一方の設定で動作します)');
  let groqError = null, geminiError = null;
  if (groqKey) {
    try { return await callGroq(groqKey, prompt, maxTokens, undefined, undefined, wantJson); }
    catch (e) { groqError = e; }
  }
  if (geminiKey) {
    try { return await callGemini(geminiKey, prompt, maxTokens, geminiModels, groqKey ? 10000 : 22000, wantJson); }
    catch (e) { geminiError = e; }
  }
  if (geminiError && !groqKey) {
    throw new Error(
      `${geminiError.message || geminiError} ／ 現在GROQ_API_KEYが未設定のため、Geminiが不調だとAI機能が使えません。` +
      'console.groq.com で無料のキーを発行し(クレジットカード登録不要)、Workerのシークレットに ' +
      '`wrangler secret put GROQ_API_KEY` で登録すると、Groq側が優先して使われるためこの種のエラーを回避できます。'
    );
  }
  throw geminiError || groqError;
}

async function callAiVision(env, prompt, maxTokens, image, wantJson) {
  const geminiKey = env.GEMINI_API_KEY, groqKey = env.GROQ_API_KEY;
  if (!geminiKey && !groqKey) throw new Error('GEMINI_API_KEYもGROQ_API_KEYも設定されていません(どちらか一方の設定で動作します)');
  let groqError = null, geminiError = null;
  if (groqKey) {
    for (const m of GROQ_VISION_MODELS) {
      try { return await callGroq(groqKey, prompt, maxTokens, m, image, wantJson); }
      catch (e) { groqError = e; }
    }
  }
  if (geminiKey) {
    try {
      const deadlineMs = Date.now() + (groqKey ? 12000 : 25000);
      const models = ['gemini-2.5-flash', GEMINI_MODEL];
      let lastCode = 0, lastBody = '';
      for (let j = 0; j < models.length; j++) {
        if (j > 0 && Date.now() > deadlineMs) break;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${models[j]}:generateContent?key=${encodeURIComponent(geminiKey)}`;
        const r = await callGeminiRaw(url, prompt, maxTokens, thinkingConfigFor(models[j]), deadlineMs, image, wantJson);
        if (r.code === 200) {
          const data = JSON.parse(r.body);
          const cand = data.candidates && data.candidates[0];
          if (cand && cand.content && cand.content.parts) return cand.content.parts.map(p => p.text || '').join('');
        }
        lastCode = r.code; lastBody = r.body;
        if (!shouldTryNextModel(r.code, r.body)) break;
      }
      throw new Error(`Gemini APIエラー (HTTP ${lastCode}): ${lastBody.slice(0, 300)}`);
    } catch (e2) { geminiError = e2; }
  }
  throw geminiError || groqError;
}

// ============ AI機能ハンドラ(apps-script-1file.gsと同じプロンプト) ============
function round1(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

function parseJsonLoose(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (e) { return null; }
}

async function handleNutrition(env, foodName) {
  if (!foodName) return { status: 'error', message: '食品名が空です' };
  const prompt =
    '次の食品の栄養価を、日本で一般的な1食あたりの目安量で概算してください。\n' +
    `食品名: ${foodName}\n\n` +
    'JSONのみを返してください。前置き・後書き・コードフェンスは不要です。\n' +
    '形式: {"kcal": 数値, "protein": 数値, "fat": 数値, "carb": 数値}\n' +
    'protein/fat/carb の単位はグラム、小数第1位まで。';
  const text = await callAi(env, prompt, 512, NUTRITION_MODELS, false);
  const n = parseJsonLoose(text);
  if (!n || typeof n.kcal === 'undefined') {
    return { status: 'error', message: `AIの応答を解釈できませんでした(応答: ${String(text).slice(0, 200)})` };
  }
  return {
    status: 'ok',
    nutrition: { kcal: Math.round(Number(n.kcal) || 0), protein: round1(n.protein), fat: round1(n.fat), carb: round1(n.carb) },
  };
}

async function handleAdvice(env, ctx) {
  if (!ctx) return { status: 'error', message: 'contextがありません' };
  const prompt =
    'あなたは親しみやすいパーソナルトレーナー兼栄養サポート役です。\n' +
    '以下は利用者の直近2週間の記録(JSON)です。これをもとに、日本語で3〜4文の短いコメントを書いてください。\n\n' +
    '### 守ること\n' +
    '- 具体的な数字や種目名に触れ、記録をちゃんと見ていると伝わる内容にする\n' +
    '- 良かった点を1つ、次にやると良いことを1つ、必ず入れる\n' +
    '- 断定的な医学的助言・診断はしない。極端な食事制限は勧めない\n' +
    '- 記録が少ない日を責めない。前向きで落ち着いた口調で\n' +
    '- 見出しや箇条書きは使わず、地の文だけで書く\n\n' +
    '### 記録\n' + JSON.stringify(ctx);
  const text = await callAi(env, prompt, 768, ADVICE_MODELS, false);
  if (!text) return { status: 'error', message: 'AIから応答がありませんでした' };
  return { status: 'ok', text: String(text).trim() };
}

async function handleMealPlan(env, ctx) {
  if (!ctx) return { status: 'error', message: 'contextがありません' };
  const prompt =
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
    '### 今日の状況\n' + JSON.stringify(ctx);
  const text = await callAi(env, prompt, 700, ADVICE_MODELS, false);
  if (!text) return { status: 'error', message: 'AIから応答がありませんでした' };
  const parsed = parseJsonLoose(text);
  const plan = (parsed && parsed.meals && parsed.meals.length) ? parsed.meals : null;
  return { status: 'ok', text: String(text).trim(), plan };
}

async function handleAnalyzePhoto(env, imageBase64, mimeType) {
  if (!imageBase64) return { status: 'error', message: '画像がありません' };
  const prompt =
    'この写真に写っている食事を判定してください。\n\n' +
    'JSONのみを返してください。前置き・後書き・コードフェンスは不要です。\n' +
    '形式: {"foods":[{"name":"料理名","kcal":数値,"protein":数値,"fat":数値,"carb":数値}]}\n' +
    '- 確からしい順に最大3件\n' +
    '- name は日本語の一般的な料理名。写真から読み取れる分量も含める(例:「鶏の唐揚げ(5個)」)\n' +
    '- 栄養値は、その分量あたりの概算。protein/fat/carb はグラム、小数第1位まで\n' +
    '- 複数の料理が写っている場合は、それぞれを1件ずつ挙げる\n' +
    '- 食事が写っていないと判断した場合は {"foods":[]} だけを返す';
  const text = await callAiVision(env, prompt, 700, { data: String(imageBase64), mimeType: mimeType || 'image/jpeg' }, false);
  const parsed = parseJsonLoose(text);
  if (!parsed || !parsed.foods) return { status: 'error', message: 'AIの応答を解釈できませんでした' };
  const foods = [];
  (parsed.foods || []).slice(0, 3).forEach(f => {
    if (!f || !f.name) return;
    foods.push({
      name: String(f.name).slice(0, 60),
      kcal: Math.round(Number(f.kcal) || 0),
      protein: round1(f.protein),
      fat: round1(f.fat),
      carb: round1(f.carb),
    });
  });
  return { status: 'ok', foods };
}

const AI_PRESETS = {
  nutrition: { models: NUTRITION_MODELS, maxTokens: 512 },
  advice: { models: ADVICE_MODELS, maxTokens: 768 },
  mealplan: { models: ADVICE_MODELS, maxTokens: 700 },
};
const AI_PROMPT_MAX = 20000;
const AI_MAXTOKENS_MAX = 1500;

function clampMaxTokens(v, fallback) {
  const n = Math.round(Number(v));
  if (!isFinite(n) || n <= 0) return fallback;
  return Math.min(n, AI_MAXTOKENS_MAX);
}

function aiRelayPrompt(body) {
  const prompt = body && body.prompt ? String(body.prompt) : '';
  if (!prompt.trim()) return { error: 'promptがありません' };
  if (prompt.length > AI_PROMPT_MAX) return { error: `promptが長すぎます(${prompt.length}文字)` };
  return { prompt };
}

async function handleAiText(env, body) {
  const p = aiRelayPrompt(body);
  if (p.error) return { status: 'error', message: p.error };
  const preset = AI_PRESETS[String((body && body.preset) || 'advice')] || AI_PRESETS.advice;
  const text = await callAi(env, p.prompt, clampMaxTokens(body && body.maxTokens, preset.maxTokens), preset.models, !!(body && body.json));
  if (!text) return { status: 'error', message: 'AIから応答がありませんでした' };
  return { status: 'ok', text: String(text).trim() };
}

async function handleAiVision(env, body) {
  const p = aiRelayPrompt(body);
  if (p.error) return { status: 'error', message: p.error };
  if (!body.imageBase64) return { status: 'error', message: '画像がありません' };
  const text = await callAiVision(
    env, p.prompt, clampMaxTokens(body.maxTokens, 700),
    { data: String(body.imageBase64), mimeType: body.mimeType || 'image/jpeg' },
    !!body.json
  );
  if (!text) return { status: 'error', message: 'AIから応答がありませんでした' };
  return { status: 'ok', text: String(text).trim() };
}
