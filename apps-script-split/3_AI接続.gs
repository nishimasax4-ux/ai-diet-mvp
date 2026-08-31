/**
 * Training Log + AI (v42)  3/5  AI接続.gs — Gemini / Groq への接続
 *
 * このコードは5つのファイルに分けてあります(スマホでは長い貼り付けが
 * 途中で切れてしまうため)。5つすべてを貼り付けて初めて動きます。
 */

function thinkingConfigFor_(model) {

  return /^gemini-2\.5/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: 'low' };
}

function roomyMaxTokens_(maxTokens) {
  return Math.max(1536, (maxTokens || 512) * 2);
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
