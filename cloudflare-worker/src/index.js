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
      // v6.15: body.token(アプリ本体が使う方式)に加えて、Authorizationヘッダーの
      // Bearerトークンでも認証できるようにした。Meta Museなど外部のAIエージェントを
      // 「カスタムコネクタ」として接続する場合、認証情報をHTTPヘッダーで渡す方式が
      // 一般的なため(アプリ本体の動作・互換性は変えていない)。
      const bearerMatch = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
      const suppliedToken = body.token || (bearerMatch ? bearerMatch[1] : '');
      if (!suppliedToken || !safeEqual(String(suppliedToken), expected)) {
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
      // v6.15: Meta Muse(やその他の外部AIエージェント)向けの読み書きアクション。
      // 詳しくはこのファイル末尾の「Muse向けアクション」のコメントを参照。
      if (action === 'museHelp') return json(museHelp());
      if (action === 'museLog') return json(await handleMuseLog(env, body.payload));
      if (action === 'museLogWeight') return json(await handleMuseLogWeight(env, body.payload));
      if (action === 'museLogMeal') return json(await handleMuseLogMeal(env, body.payload));
      if (action === 'museLogStrength') return json(await handleMuseLogStrength(env, body.payload));
      if (action === 'museLogCardio') return json(await handleMuseLogCardio(env, body.payload));
      if (action === 'museTodaySummary') return json(await handleMuseTodaySummary(env, body.payload));
      if (action === 'museWeightTrend') return json(await handleMuseWeightTrend(env, body.payload));
      if (action === 'museRecentTraining') return json(await handleMuseRecentTraining(env, body.payload));
      if (action === 'museTdeeEstimate') return json(await handleMuseTdeeEstimate(env, body.payload));
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

// ============ Muse向けアクション(v6.15) ============
// Meta Muse(やその他の外部AIエージェント)を「カスタムコネクタ」として接続し、
// トレーニング記録を読み書きできるようにするためのアクション群。
//
// 【書き込み(museLogWeight/museLogMeal/museLogStrength/museLogCardio)】
// 既存のaction=saveは「シートを丸ごとクリアしてから書き直す」方式で、アプリ本体
// (index.html)が持つ全件を毎回送る前提になっている。Museのような外部からの
// 書き込みにそのまま使うと、アプリ側が知らない変更を次の同期で消してしまう
// (アプリは自分のlocalStorageが正だと思って上書きするため)。
// そこで書き込み系はSheets APIのappend(末尾に1行追加するだけ)を使い、既存の
// 行を一切消さない方式にした。
// 追記のたびにLAST_WRITE_ATも更新する。これにより、アプリ側が次に同期しようと
// したとき、アプリが覚えている書き込み時刻と食い違うため、既存の「他の端末で
// 書き込みがあった」ときと同じ仕組みで自動的に競合(conflict)として扱われ、
// アプリが黙ってMuseの記録を消してしまうことを防ぐ(index.html側の変更は不要)。
// Museで記録した後にアプリを開いたときに同期の競合が出たら、設定タブの
// 「☁️ シートから復元」で新しい内容を取り込んでください。
// 【注意】アプリが一度もシートへの同期に成功していない(真っさらな状態)場合は
// この食い違いチェック自体が働かないため、少なくとも一度はアプリ側で同期を
// 済ませてからMuse連携を使い始めることをおすすめします。
//
// 【読み取り(museTodaySummary/museWeightTrend/museRecentTraining/museTdeeEstimate)】
// 年齢・身長・性別・活動量などのプロフィールや、目標体重・減量ペースといった
// 「目標」は、この端末のlocalStorageにしか無くスプレッドシートには同期されて
// いない。そのため、ここでは「目標カロリー」や「基礎代謝」は計算できず、実際に
// 記録された摂取カロリー・体重の変化・運動の記録だけから分かる範囲の概算を返す。
const MUSE_STRENGTH_KCAL_PER_SET = 10; // index.htmlのSTRENGTH_KCAL_PER_SETと同じ値
const MUSE_CARDIO_MET = { 'ランニング':8, 'ジョギング':7, 'バイク':7, 'ウォーキング':3.5, 'クロストレーナー':5, 'リカベントバイク':4.5, '買い物':3, 'その他':5 }; // index.htmlのCARDIO_METと同じ
const MUSE_FAT_KCAL_PER_KG = 7200; // index.htmlのFAT_KCAL_PER_KGと同じ
const MUSE_PARTS = ['胸','背中','脚','肩','腕','腹筋']; // index.htmlのPARTSと同じ

function museNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
}
function museDateOk(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  // 形だけでなく実在する日付かも確認する(例: 2026-13-99のような値を弾く)。
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
}
// v7.0: 日本時間(JST)の「今日」。以前はUTCで数えていたため、日本の午前0〜9時に記録すると
// 前日の日付になってしまっていた。
function museJst() { return new Date(Date.now() + 9 * 3600 * 1000); }
function museTodayStr() { return museJst().toISOString().slice(0, 10); }
// v7.0: Museが入力しやすいよう、日付は省略でき(省略=今日)、"今日""昨日""today""yesterday"や
// "2026/11/3"、"11/3"のような書き方も受け付ける。解釈できなければnull。
function museResolveDate(d) {
  if (d == null || d === '') return museTodayStr();
  const t = String(d).trim();
  if (/^(today|今日|きょう)$/i.test(t)) return museTodayStr();
  if (/^(yesterday|昨日|きのう)$/i.test(t)) return new Date(museJst().getTime() - 86400000).toISOString().slice(0, 10);
  let m = t.match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})日?$/);
  if (!m) { const mm = t.match(/^(\d{1,2})[\/月](\d{1,2})日?$/); if (mm) m = [null, String(museJst().getUTCFullYear()), mm[1], mm[2]]; }
  if (!m) return null;
  const out = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return museDateOk(out) ? out : null;
}
// "65.2kg" "10回" "約30分" のような文字つきの数値も受け付ける。数値にできなければNaN。
function museLoose(v) {
  if (typeof v === 'number') return v;
  const m = String(v ?? '').replace(/[０-９．]/g, c => c === '．' ? '.' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}
// 種目名から部位を推定(partを省略したとき用)。当てはまらなければnull。
const MUSE_PART_HINTS = [
  ['胸', /ベンチ|チェスト|ペック|フライ|クロスオーバー|プッシュアップ|腕立て|ディップ/],
  ['背中', /ラット|プルダウン|ロウ|ローイング|懸垂|チンニング|デッドリフト|ストレートアーム|シュラッグ/],
  ['脚', /スクワット|レッグ|ランジ|カーフ|ヒップ|キックバック|ブルガリアン/],
  ['肩', /ショルダー|サイドレイズ|フェイスプル|リアレイズ|アーノルド|オーバーヘッドプレス/],
  ['腕', /カール|トライセップ|プレスダウン|エクステンション|ハンマー/],
  ['腹筋', /クランチ|腹筋|プランク|レッグレイズ|シットアップ|アブ/],
];
function museGuessPart(exercise) {
  const e = String(exercise || '');
  const hit = MUSE_PART_HINTS.find(([, re]) => re.test(e));
  return hit ? hit[0] : null;
}
// 食事区分を省略したとき、日本時間の時刻から推定する(アプリ側のautoSelectMealTypeByTimeと同じ考え方)。
function museGuessMealType() {
  const h = museJst().getUTCHours();
  return h >= 4 && h < 10 ? '朝食' : h >= 10 && h < 15 ? '昼食' : h >= 15 && h < 18 ? '間食' : '夕食';
}

// セキュリティ: text/exercise/mealTypeなど「外部のAIエージェント経由で届く自由記述文字列」を
// そのままスプレッドシートのセルに書き込むと、値が = + - @ で始まる場合にGoogle Sheets側が
// 数式として解釈してしまう(いわゆるスプレッドシート/CSVインジェクション)。先頭にシングル
// クォートを付けて「文字列として扱え」と明示することで無害化する。
function museSafeCell(v) {
  const s = String(v ?? '');
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

// シートが無ければ、見出し行付きで新規作成する(action=save側のシート追加ロジックと
// 似ているが、こちらは1シートだけを対象にした簡易版)。
async function museEnsureSheet(env, title, header) {
  const meta = await sheetsFetch(env, '?fields=sheets.properties');
  const found = (meta.sheets || []).find(s => s.properties.title === title);
  if (found) return found.properties.sheetId;
  const addRes = await sheetsFetch(env, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
  const sheetId = addRes.replies[0].addSheet.properties.sheetId;
  await sheetsFetch(env, `/values/${encodeURIComponent(a1Sheet(title) + '!A1')}?valueInputOption=RAW`, {
    method: 'PUT', body: JSON.stringify({ values: [header] }),
  });
  await sheetsFetch(env, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests: [
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
    ] }),
  });
  return sheetId;
}

// 末尾に1行だけ追加する(クリア→書き直しはしない)。追記後にLAST_WRITE_ATを
// 更新し、アプリ側の次の同期が自動的に競合として検知されるようにする。
async function museAppendRow(env, title, header, row) {
  await museEnsureSheet(env, title, header);
  return museAppendRowNoEnsure(env, title, row);
}

// museEnsureSheetを呼ばない版。同じシートに複数行を連続で追加する場合(例: 筋トレの
// セット数ぶんの行追加)に、1行ごとに無駄なメタデータ取得を繰り返さないための版。
async function museAppendRowNoEnsure(env, title, row) {
  await sheetsFetch(env, `/values/${encodeURIComponent(a1Sheet(title) + '!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST', body: JSON.stringify({ values: [row] }),
  });
  const now = new Date().toISOString();
  await env.SYNC_KV.put('LAST_WRITE_AT', now);
  return now;
}

async function museSheetRows(env, title) {
  let data;
  try { data = await sheetsFetch(env, `/values/${encodeURIComponent(a1Sheet(title))}`); }
  catch (e) { return []; } // シートがまだ無い場合は空として扱う
  const values = data.values || [];
  if (!values.length) return [];
  return values.slice(1).filter(r => String(r[0] || '').trim() !== '');
}

async function museLatestWeightKg(env) {
  const rows = await museSheetRows(env, '体重');
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => String(a[0]) < String(b[0]) ? 1 : -1);
  const w = Number(sorted[0][1]);
  return Number.isFinite(w) ? w : null;
}

async function handleMuseLogWeight(env, p) {
  p = p || {};
  p.date = museResolveDate(p.date);
  if (!p.date) return { status: 'error', message: 'dateは省略(=今日)か、今日/昨日/2026-11-03のような形で指定してください' };
  const weight = museLoose(p.weight);
  if (!Number.isFinite(weight) || weight <= 0) return { status: 'error', message: 'weight(kg、数値)が必要です' };
  const header = ['日付', '体重kg', '体脂肪率%', '腹囲cm'];
  const row = [p.date, weight, p.bodyFat != null ? museNum(p.bodyFat) : '', p.waist != null ? museNum(p.waist) : ''];
  const lastWriteAt = await museAppendRow(env, '体重', header, row);
  return { status: 'ok', recorded: { date: p.date, weight, bodyFat: p.bodyFat ?? null, waist: p.waist ?? null }, lastWriteAt };
}

async function handleMuseLogMeal(env, p) {
  p = p || {};
  p.date = museResolveDate(p.date);
  if (!p.date) return { status: 'error', message: 'dateは省略(=今日)か、今日/昨日/2026-11-03のような形で指定してください' };
  if (!p.mealType) p.mealType = museGuessMealType(); // 省略時は時刻から推定
  if (!p.text) return { status: 'error', message: 'text(メニュー名)が必要です' };
  const calories = p.calories != null && Number.isFinite(museLoose(p.calories)) ? museLoose(p.calories) : 0;
  const header = ['日付', '区分', 'メニュー', 'kcal', 'たんぱく質g', '脂質g', '炭水化物g'];
  const row = [p.date, museSafeCell(p.mealType), museSafeCell(p.text), calories, museNum(museLoose(p.protein)), museNum(museLoose(p.fat)), museNum(museLoose(p.carb))];
  const lastWriteAt = await museAppendRow(env, '食事', header, row);
  return { status: 'ok', recorded: { date: p.date, mealType: p.mealType, text: p.text, calories }, lastWriteAt };
}

async function handleMuseLogStrength(env, p) {
  p = p || {};
  p.date = museResolveDate(p.date);
  if (!p.date) return { status: 'error', message: 'dateは省略(=今日)か、今日/昨日/2026-11-03のような形で指定してください' };
  if (!p.part) p.part = museGuessPart(p.exercise); // 省略時は種目名から推定
  if (!MUSE_PARTS.includes(p.part)) return { status: 'error', message: `部位を判断できません。part を ${MUSE_PARTS.join('/')} のいずれかで指定してください` };
  const reps = museLoose(p.reps), weight = p.weight == null || p.weight === '' ? 0 : museLoose(p.weight); // 重量の省略は自重(0kg)
  if (!Number.isFinite(reps) || reps <= 0) return { status: 'error', message: 'reps(回数、数値)が必要です' };
  if (!Number.isFinite(weight) || weight < 0) return { status: 'error', message: 'weight(kg、数値)が必要です' };
  const setsRaw = p.sets != null ? museLoose(p.sets) : 1;
  if (!Number.isFinite(setsRaw) || setsRaw <= 0) return { status: 'error', message: 'sets(セット数、数値)は1以上にしてください' };
  // セキュリティ: setsに上限を設けないと、1回のリクエストで大量のAPI呼び出しが発生し、
  // Workerの実行時間やGoogle Sheets APIのレート制限を使い果たすおそれがある(DoSリスク)。
  // 実際の筋トレで現実的な最大値として20を上限にする。
  const MUSE_MAX_SETS = 20;
  if (setsRaw > MUSE_MAX_SETS) return { status: 'error', message: `sets(セット数)は${MUSE_MAX_SETS}以下にしてください` };
  const sets = Math.round(setsRaw);
  const exercise = museSafeCell(p.exercise || '');
  const header = ['日付', '部位', '種目', '重量kg', '回数', '消費カロリーkcal'];
  // シートの存在確認はループの外で1回だけ行う(毎回メタデータを取得しない)。
  await museEnsureSheet(env, '筋トレ', header);
  let lastWriteAt = null;
  // index.htmlのhandleAddTraining()と同じく、1セット=1行として、セット数ぶん
  // 同じ内容の行を追加する(データ構造を変えないため)。
  for (let i = 0; i < sets; i++) {
    lastWriteAt = await museAppendRowNoEnsure(env, '筋トレ', [p.date, p.part, exercise, weight, reps, MUSE_STRENGTH_KCAL_PER_SET]);
  }
  return { status: 'ok', recorded: { date: p.date, part: p.part, exercise: p.exercise || null, weight, reps, sets }, lastWriteAt };
}

async function handleMuseLogCardio(env, p) {
  p = p || {};
  p.date = museResolveDate(p.date);
  if (!p.date) return { status: 'error', message: 'dateは省略(=今日)か、今日/昨日/2026-11-03のような形で指定してください' };
  if (!p.exercise) return { status: 'error', message: 'exercise(種目名、例: ランニング・ウォーキング)が必要です' };
  const minutes = museLoose(p.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return { status: 'error', message: 'minutes(分、数値)が必要です' };
  const weightKg = await museLatestWeightKg(env);
  const met = MUSE_CARDIO_MET[p.exercise] || MUSE_CARDIO_MET['その他'];
  // 体重が一度も記録されていない場合は計算できないため空欄にする(index.htmlのbuildPayload()と同じ考え方)。
  const kcal = weightKg != null ? Math.round((met * 3.5 * weightKg / 200) * minutes) : '';
  const header = ['日付', '種目', '時間分', '消費カロリーkcal'];
  const lastWriteAt = await museAppendRow(env, '有酸素', header, [p.date, museSafeCell(p.exercise), minutes, kcal]);
  return { status: 'ok', recorded: { date: p.date, exercise: p.exercise, minutes, kcal: kcal === '' ? null : kcal }, lastWriteAt };
}

// v7.0: Museに「使い方」を自分で読ませるためのアクション。ユーザーはURLと合言葉を渡して
// 「museHelpを呼んで使い方を読んで」と頼むだけでよい(アクション一覧を貼り付ける必要がない)。
function museHelp() {
  return {
    status: 'ok',
    usage: 'POST このURL に JSON {"action": ..., "payload": {...}} を送る。認証は Authorization: Bearer 合言葉。',
    tip: '記録は museLog が一番かんたん。1回の呼び出しで体重・食事・筋トレ・有酸素をまとめて記録できる。dateは省略すると日本時間の今日。',
    actions: {
      museLog: { payload: { items: [
        { type: 'weight', weight: '72.4', bodyFat: '24.1(任意)', waist: '(任意)' },
        { type: 'meal', text: '鶏むね肉のサラダ', mealType: '省略可(時刻から自動)', calories: '450', protein: '', fat: '', carb: '' },
        { type: 'strength', exercise: 'チェストプレス', part: '省略可(種目名から推定)', weight: '30(省略=自重)', reps: '10', sets: '3' },
        { type: 'cardio', exercise: 'ウォーキング', minutes: '30' } ], date: '省略可(今日/昨日/2026-11-03)。items内に個別指定も可' }, note: 'items最大10件。結果は1件ずつ返る' },
      museTodaySummary: { payload: { date: '省略可' }, note: '今日の摂取・運動消費の概算' },
      museWeightTrend: { payload: { days: '省略可(14)' } },
      museRecentTraining: { payload: { days: '省略可(7)' } },
      museTdeeEstimate: { payload: {} },
    },
    single: 'museLogWeight / museLogMeal / museLogStrength / museLogCardio でも1件ずつ記録できる(museLogと同じ項目)',
  };
}
// v7.0: 複数の記録を1回で。{items:[{type:'weight'|'meal'|'strength'|'cardio', ...}], date?}
async function handleMuseLog(env, p) {
  const items = p && Array.isArray(p.items) ? p.items : null;
  if (!items || !items.length) return { status: 'error', message: 'items(配列)が必要です。museHelpで例を確認できます' };
  if (items.length > 10) return { status: 'error', message: 'itemsは10件までです' };
  const handlers = { weight: handleMuseLogWeight, meal: handleMuseLogMeal, strength: handleMuseLogStrength, cardio: handleMuseLogCardio };
  const results = [];
  for (const it of items) {
    const h = it && handlers[it.type];
    if (!h) { results.push({ status: 'error', message: 'typeは weight/meal/strength/cardio のいずれかです' }); continue; }
    const { type, ...rest } = it;
    if (rest.date == null && p.date != null) rest.date = p.date;
    try { results.push({ type, ...(await h(env, rest)) }); }
    catch (e) { results.push({ type, status: 'error', message: String(e && e.message ? e.message : e) }); }
  }
  return { status: results.every(r => r.status === 'ok') ? 'ok' : 'partial', results };
}

async function handleMuseTodaySummary(env, p) {
  const date = (p && museDateOk(p.date)) ? p.date : museTodayStr();
  const meals = (await museSheetRows(env, '食事')).filter(r => r[0] === date);
  const strength = (await museSheetRows(env, '筋トレ')).filter(r => r[0] === date);
  const cardio = (await museSheetRows(env, '有酸素')).filter(r => r[0] === date);
  const intakeKcal = meals.reduce((s, r) => s + (Number(r[3]) || 0), 0);
  const strengthBurn = strength.reduce((s, r) => s + (Number(r[5]) || 0), 0);
  const cardioBurn = cardio.reduce((s, r) => s + (Number(r[3]) || 0), 0);
  return {
    status: 'ok', date,
    intakeKcal: Math.round(intakeKcal),
    exerciseBurnKcal: Math.round(strengthBurn + cardioBurn),
    mealsLogged: meals.length, strengthSetsLogged: strength.length, cardioSessionsLogged: cardio.length,
    note: '摂取カロリーと、運動による消費カロリーだけの概算です。基礎代謝ぶんは含みません(プロフィール情報が端末内にしか無いため)。',
  };
}

async function handleMuseWeightTrend(env, p) {
  const days = (p && Number.isFinite(Number(p.days)) && Number(p.days) > 0) ? Math.min(Math.round(Number(p.days)), 180) : 14;
  const rows = await museSheetRows(env, '体重');
  const sorted = [...rows].sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1);
  const cutoff = new Date(); cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const recent = sorted.filter(r => String(r[0]) >= cutoffStr);
  const points = recent.map(r => ({
    date: r[0], weight: Number(r[1]) || null,
    bodyFat: r[2] !== '' && r[2] != null ? Number(r[2]) : null,
    waist: r[3] !== '' && r[3] != null ? Number(r[3]) : null,
  }));
  const first = points[0], last = points[points.length - 1];
  const change = (first && last && points.length > 1) ? Math.round((last.weight - first.weight) * 10) / 10 : 0;
  return { status: 'ok', days, count: points.length, points, change };
}

async function handleMuseRecentTraining(env, p) {
  const days = (p && Number.isFinite(Number(p.days)) && Number(p.days) > 0) ? Math.min(Math.round(Number(p.days)), 90) : 7;
  const cutoff = new Date(); cutoff.setUTCDate(cutoff.getUTCDate() - days + 1);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const strength = (await museSheetRows(env, '筋トレ')).filter(r => String(r[0]) >= cutoffStr)
    .map(r => ({ date: r[0], part: r[1], exercise: r[2], weightKg: Number(r[3]) || null, reps: Number(r[4]) || null }));
  const cardio = (await museSheetRows(env, '有酸素')).filter(r => String(r[0]) >= cutoffStr)
    .map(r => ({ date: r[0], exercise: r[1], minutes: Number(r[2]) || null }));
  return { status: 'ok', days, strength, cardio };
}

// index.html の estimateTdeeForWindow_() / estimateTdeeSummary_()(v6.13)と同じ考え方を、
// スプレッドシートの行データから計算する版。
function museWeightAvgInRange(rows, startStr, endStr) {
  const inRange = rows.filter(r => r[0] >= startStr && r[0] <= endStr);
  if (!inRange.length) return null;
  const weight = inRange.reduce((s, r) => s + (Number(r[1]) || 0), 0) / inRange.length;
  const withBf = inRange.filter(r => r[2] !== '' && r[2] != null);
  const bodyFat = withBf.length ? withBf.reduce((s, r) => s + Number(r[2]), 0) / withBf.length : null;
  return { weight, bodyFat };
}
function museAvgIntakeInRange(rows, startStr, endStr) {
  const byDate = {};
  rows.forEach(r => {
    const c = Number(r[3]) || 0;
    if (c <= 0) return;
    if (r[0] < startStr || r[0] > endStr) return;
    byDate[r[0]] = (byDate[r[0]] || 0) + c;
  });
  const days = Object.keys(byDate);
  if (!days.length) return null;
  const total = days.reduce((s, d) => s + byDate[d], 0);
  return { avg: total / days.length, loggedDays: days.length };
}
function museEstimateTdeeWindow(weightRows, mealRows, weeks, todayStr) {
  const today = new Date(todayStr + 'T00:00:00Z');
  const windowStart = new Date(today); windowStart.setUTCDate(today.getUTCDate() - weeks * 7 + 1);
  const earlyEnd = new Date(windowStart); earlyEnd.setUTCDate(windowStart.getUTCDate() + 6);
  const lateStart = new Date(today); lateStart.setUTCDate(today.getUTCDate() - 6);
  const windowStartStr = windowStart.toISOString().slice(0, 10);
  const earlyEndStr = earlyEnd.toISOString().slice(0, 10);
  const lateStartStr = lateStart.toISOString().slice(0, 10);

  const early = museWeightAvgInRange(weightRows, windowStartStr, earlyEndStr);
  const late = museWeightAvgInRange(weightRows, lateStartStr, todayStr);
  if (!early || !late) return null;

  const intake = museAvgIntakeInRange(mealRows, windowStartStr, todayStr);
  if (!intake || intake.loggedDays < weeks * 7 * 0.5) return null;

  const effectiveDays = Math.max(1, weeks * 7 - 7);
  const weightLossKg = early.weight - late.weight;
  const estimateByWeight = Math.round(intake.avg + (weightLossKg * MUSE_FAT_KCAL_PER_KG) / effectiveDays);
  let estimateByBodyFat = null;
  if (early.bodyFat != null && late.bodyFat != null) {
    const fatLossKg = (early.weight * early.bodyFat / 100) - (late.weight * late.bodyFat / 100);
    estimateByBodyFat = Math.round(intake.avg + (fatLossKg * MUSE_FAT_KCAL_PER_KG) / effectiveDays);
  }
  return { weeks, estimateByWeight, estimateByBodyFat };
}

async function handleMuseTdeeEstimate(env, p) {
  const todayStr = (p && museDateOk(p.date)) ? p.date : museTodayStr();
  const weightRows = await museSheetRows(env, '体重');
  const mealRows = await museSheetRows(env, '食事');
  const results = [3, 5, 7].map(w => museEstimateTdeeWindow(weightRows, mealRows, w, todayStr)).filter(Boolean);
  if (!results.length) {
    return { status: 'ok', available: false, message: '体重・食事の記録が3週間ぶんそろっていないため、計算できませんでした。' };
  }
  const avgByWeight = Math.round(results.reduce((s, r) => s + r.estimateByWeight, 0) / results.length);
  const fatResults = results.filter(r => r.estimateByBodyFat != null);
  const avgByBodyFat = fatResults.length
    ? Math.round(fatResults.reduce((s, r) => s + r.estimateByBodyFat, 0) / fatResults.length)
    : null;
  return { status: 'ok', available: true, date: todayStr, avgByWeight, avgByBodyFat, windows: results };
}
