/**
 * トレーニングログアプリ用 Google Apps Script
 *
 * 使い方は README.md を参照してください。概要:
 * 1. 記録用のGoogleスプレッドシートを新規作成する
 * 2. 拡張機能 > Apps Script を開き、このファイルの内容を貼り付ける
 * 3. デプロイ > 新しいデプロイ > 種類「ウェブアプリ」
 *    - 実行するユーザー: 自分
 *    - アクセスできるユーザー: 全員
 * 4. 発行されたURLを index.html の GAS_URL に貼り付ける
 *
 * 【オプション】「🔍 AIで栄養を調べる」機能を使う場合のみ、追加でもう1手順必要です:
 * 5. Google AI Studio (https://aistudio.google.com/apikey) で無料のGemini APIキーを取得する
 * 6. このApps Scriptプロジェクトの「プロジェクトの設定」→「スクリプト プロパティ」で
 *    プロパティ名 GEMINI_API_KEY / 値にそのキーを追加して、必ず保存ボタンまで押す
 * この機能を使わない場合、5・6の手順は不要です(他の機能には一切影響しません)。
 *
 * 【設定確認用】6.まで終えたのにアプリ側で「APIキーが未設定」と出る場合は、
 * このデプロイURLの末尾に ?check=key を付けてSafariで直接開いてください
 * (例: https://script.google.com/macros/s/.../exec?check=key )。
 * キーの中身は表示せず、設定できているかどうかと文字数だけを返します。
 * コードを今回のバージョンに更新した場合は、末尾の手順で必ず「新しいバージョン」として
 * デプロイし直してください(スクリプト プロパティの追加だけなら再デプロイ不要ですが、
 * コード自体の変更は再デプロイしないと反映されません)。
 */

const SHEET_NAME = "ログ";
const HEADER = ["日付", "カテゴリ", "項目1", "項目2", "項目3", "項目4"];
const GEMINI_MODEL = "gemini-2.0-flash"; // 変更したい場合はここを書き換えてください

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  return sheet;
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // 「🔍 AIで栄養を調べる」からのリクエストはシート同期とは別処理。
    if (body.action === "estimateNutrition") {
      return handleEstimateNutrition_(body.foodName);
    }

    // 既定の動作(これまで通り): 記録全体をシートへ同期
    const rows = body.rows || [];
    const sheet = getSheet_();

    sheet.clearContents();
    sheet.appendRow(HEADER);
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, HEADER.length).setValues(rows);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ status: "ok", count: rows.length }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// 食品名からカロリー・タンパク質・脂質・炭水化物を概算する(Google Gemini APIを利用)。
// GEMINI_API_KEY が未設定の場合はエラーを返すだけで、シート同期など他の機能には影響しない。
function handleEstimateNutrition_(foodName) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: "GEMINI_API_KEY が未設定です(Apps Scriptのスクリプトプロパティを確認してください)" }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (!foodName) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: "食品名が空です" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const prompt = "次の食品・料理の一般的な1人前あたりのおおよその栄養価を推定してください。" +
    "出力は必ず次のJSON形式のみとし、説明文やコードブロックの記号は付けないでください。" +
    '{"kcal": 数値, "protein": 数値(g), "fat": 数値(g), "carb": 数値(g)}\n' +
    "食品名: " + foodName;

  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + apiKey;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
  };

  try {
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const text = res.getContentText();
    if (code < 200 || code >= 300) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: "error", message: "Gemini API エラー(" + code + "): " + text.slice(0, 300) }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const data = JSON.parse(text);
    const raw = data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;
    if (!raw) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: "error", message: "Geminiからの応答を解析できませんでした" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const nutrition = JSON.parse(raw);
    return ContentService
      .createTextOutput(JSON.stringify({
        status: "ok",
        nutrition: {
          kcal: Math.round(Number(nutrition.kcal) || 0),
          protein: Math.round(Number(nutrition.protein) || 0),
          fat: Math.round(Number(nutrition.fat) || 0),
          carb: Math.round(Number(nutrition.carb) || 0),
        },
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  // 動作確認用。ブラウザでWebアプリのURLを直接開いたときに返る内容。
  // URLの末尾に ?check=key を付けて開くと、GEMINI_API_KEYがこのApps Scriptプロジェクトに
  // 正しく設定されているかどうかを確認できます(キーの中身自体は表示されません。
  // 設定の有無と文字数だけを返すので、安全に確認用として使えます)。
  if (e && e.parameter && e.parameter.check === "key") {
    const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
    return ContentService
      .createTextOutput(JSON.stringify({
        status: "ready",
        geminiKeyConfigured: !!apiKey,
        geminiKeyLength: apiKey ? apiKey.length : 0,
        message: apiKey
          ? "GEMINI_API_KEYはこのApps Scriptプロジェクトに設定されています(値は安全のため表示しません)。それでもアプリ側で「未設定」エラーが出る場合は、index.htmlのGAS_URLと、このプロジェクトのデプロイURLが一致しているかご確認ください。"
          : "GEMINI_API_KEYはこのApps Scriptプロジェクトに設定されていません。「プロジェクトの設定」(歯車アイコン)→ 一番下の「スクリプト プロパティ」で、プロパティ名 GEMINI_API_KEY / 値にAPIキーを追加し、必ず保存ボタンまで押してください。",
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService
    .createTextOutput(JSON.stringify({ status: "ready", message: "このURLはPOST専用です。index.htmlから自動的に呼び出されます。URLの末尾に ?check=key を付けて開くと、GEMINI_API_KEYの設定状況を確認できます。" }))
    .setMimeType(ContentService.MimeType.JSON);
}
