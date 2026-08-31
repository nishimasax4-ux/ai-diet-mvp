/**
 * Training Log + AI (v42)  4/5  AI呼出.gs — AIの呼び分けとGroq
 *
 * このコードは5つのファイルに分けてあります(スマホでは長い貼り付けが
 * 途中で切れてしまうため)。5つすべてを貼り付けて初めて動きます。
 */

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
