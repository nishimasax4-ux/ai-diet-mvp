/**
 * Training Log + AI (v44.1)  3/5  AI接続.gs — Gemini/Groqへの接続
 *
 * このコードは5つのファイルに分けてあります(スマホでは長い貼り付けが
 * 途中で切れることがあるため)。5つすべてを貼り付けて初めて動きます。
 * 1ファイル版(apps-script-1file.gs)を貼れた方は、こちらは不要です。
 */

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
