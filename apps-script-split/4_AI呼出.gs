/**
 * Training Log + AI (v44.1)  4/5  AI呼出.gs — 呼び分けと動作確認
 *
 * このコードは5つのファイルに分けてあります(スマホでは長い貼り付けが
 * 途中で切れることがあるため)。5つすべてを貼り付けて初めて動きます。
 * 1ファイル版(apps-script-1file.gs)を貼れた方は、こちらは不要です。
 */

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

function callAiVision_(prompt, maxTokens, image) {
  var geminiKey = prop_('GEMINI_API_KEY');
  var groqKey = prop_('GROQ_API_KEY');
  if (!geminiKey && !groqKey) {
    throw new Error('GEMINI_API_KEYもGROQ_API_KEYも設定されていません(どちらか一方の設定で動作します)');
  }
  var groqError = null, geminiError = null;
  if (groqKey) {
    for (var i = 0; i < GROQ_VISION_MODELS.length; i++) {
      try {
        return callGroq_(groqKey, prompt, maxTokens, GROQ_VISION_MODELS[i], image);
      } catch (e) {
        groqError = e;
      }
    }
  }
  if (geminiKey) {
    try {

      var deadlineMs = new Date().getTime() + (groqKey ? 12000 : 25000);
      var models = ['gemini-2.5-flash', GEMINI_MODEL];
      var lastCode = 0, lastBody = '';
      for (var j = 0; j < models.length; j++) {
        if (j > 0 && new Date().getTime() > deadlineMs) break;
        var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                  models[j] + ':generateContent?key=' + encodeURIComponent(geminiKey);
        var r = callGeminiRaw_(url, prompt, maxTokens, thinkingConfigFor_(models[j]), deadlineMs, image);
        if (r.code === 200) {
          var data = JSON.parse(r.body);
          var cand = data.candidates && data.candidates[0];
          if (cand && cand.content && cand.content.parts) {
            return cand.content.parts.map(function (p) { return p.text || ''; }).join('');
          }
        }
        lastCode = r.code; lastBody = r.body;
        if (!shouldTryNextModel_(r.code, r.body)) break;
      }
      throw new Error('Gemini APIエラー (HTTP ' + lastCode + '): ' + lastBody.slice(0, 300));
    } catch (e2) {
      geminiError = e2;
    }
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
