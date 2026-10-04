/**
 * Training Log + AI (v44.1)  2/5  保存.gs — シートへの保存と読み込み
 *
 * このコードは5つのファイルに分けてあります(スマホでは長い貼り付けが
 * 途中で切れることがあるため)。5つすべてを貼り付けて初めて動きます。
 * 1ファイル版(apps-script-1file.gs)を貼れた方は、こちらは不要です。
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

  return { status: 'ok', payload: payload, lastWriteAt: prop_('LAST_WRITE_AT') || null };
}

function normalizeCell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v;
}
