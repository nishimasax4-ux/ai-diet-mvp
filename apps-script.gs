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
 */

const SHEET_NAME = "ログ";
const HEADER = ["日付", "カテゴリ", "項目1", "項目2", "項目3", "項目4"];

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

function doGet(e) {
  // 動作確認用。ブラウザでWebアプリのURLを直接開いたときに返る内容。
  return ContentService
    .createTextOutput(JSON.stringify({ status: "ready", message: "このURLはPOST専用です。index.htmlから自動的に呼び出されます。" }))
    .setMimeType(ContentService.MimeType.JSON);
}
