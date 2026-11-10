// ============ Muse連携(v44.2) ============
// Meta Museなど外部のAIエージェントから、記録の追加・確認をするための入口。
// アプリ本体の同期とは別に、スプレッドシートの末尾へ1行ずつ追記するだけで、既存の記録は消しません。
// 追記のたびに「最終書き込み時刻」を更新するので、アプリを開いて同期したときに競合として検知され、
// Museの記録が黙って消えることはありません(競合が出たら、設定タブの「シートから復元」で取り込む)。
// 認証: 他のactionと同じ合言葉(APP_TOKEN)を、JSON本文の token か、URLの ?token= で渡します。

var MUSE_STRENGTH_KCAL_PER_SET = 10;
var MUSE_CARDIO_MET = { 'ランニング': 8, 'ジョギング': 7, 'バイク': 7, 'ウォーキング': 3.5, 'クロストレーナー': 5, 'リカベントバイク': 4.5, '買い物': 3, 'その他': 5 };
var MUSE_PARTS = ['胸', '背中', '脚', '肩', '腕', '腹筋'];
var MUSE_PART_HINTS = [
  ['胸', /ベンチ|チェスト|ペック|フライ|クロスオーバー|プッシュアップ|腕立て|ディップ/],
  ['背中', /ラット|プルダウン|ロウ|ローイング|懸垂|チンニング|デッドリフト|ストレートアーム|シュラッグ/],
  ['脚', /スクワット|レッグ|ランジ|カーフ|ヒップ|キックバック|ブルガリアン/],
  ['肩', /ショルダー|サイドレイズ|フェイスプル|リアレイズ|アーノルド|オーバーヘッドプレス/],
  ['腕', /カール|トライセップ|プレスダウン|エクステンション|ハンマー/],
  ['腹筋', /クランチ|腹筋|プランク|レッグレイズ|シットアップ|アブ/]
];
var MUSE_HEADERS = {
  '体重': ['日付', '体重kg', '体脂肪率%', '腹囲cm'],
  '食事': ['日付', '区分', 'メニュー', 'kcal', 'たんぱく質g', '脂質g', '炭水化物g'],
  '筋トレ': ['日付', '部位', '種目', '重量kg', '回数', '消費カロリーkcal'],
  '有酸素': ['日付', '種目', '時間分', '消費カロリーkcal']
};

function museDate_(offsetDays) {
  return Utilities.formatDate(new Date(Date.now() + (offsetDays || 0) * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
}
// 日付は省略可(=今日)。「今日」「昨日」「2026/11/3」「11/3」も可。解釈できなければ null。
function museResolveDate_(d) {
  if (d === undefined || d === null || d === '') return museDate_(0);
  var t = String(d).trim();
  if (/^(today|今日|きょう)$/i.test(t)) return museDate_(0);
  if (/^(yesterday|昨日|きのう)$/i.test(t)) return museDate_(-1);
  var m = t.match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})日?$/);
  if (!m) {
    var mm = t.match(/^(\d{1,2})[\/月](\d{1,2})日?$/);
    if (mm) m = [null, museDate_(0).slice(0, 4), mm[1], mm[2]];
  }
  if (!m) return null;
  var y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
  var dt = new Date(Date.UTC(y, mo - 1, da));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== da) return null;
  return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + da).slice(-2);
}
// 「65.2kg」「10回」「約30分」のような単位つきも数値として読む。読めなければ NaN。
function museLoose_(v) {
  if (typeof v === 'number') return v;
  var s = String(v === undefined || v === null ? '' : v)
    .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/．/g, '.');
  var m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}
function museOpt_(v) { var n = museLoose_(v); return isFinite(n) ? n : ''; }
function museSafe_(v) {
  var s = String(v === undefined || v === null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;   // 数式として解釈されないようにする
}
function museGuessPart_(ex) {
  for (var i = 0; i < MUSE_PART_HINTS.length; i++) if (MUSE_PART_HINTS[i][1].test(String(ex || ''))) return MUSE_PART_HINTS[i][0];
  return null;
}
function museGuessMealType_() {
  var h = Number(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'H'));
  return h >= 4 && h < 10 ? '朝食' : h >= 10 && h < 15 ? '昼食' : h >= 15 && h < 18 ? '間食' : '夕食';
}

function museHelp_() {
  return {
    status: 'ok',
    usage: 'POST このURL に JSON {"action": ..., "token": "合言葉", "payload": {...}} を送る(tokenはURLの ?token=合言葉 でも可)。',
    tip: '記録は museLog が一番かんたん。1回の呼び出しで体重・食事・筋トレ・有酸素をまとめて記録できる。dateは省略すると日本時間の今日。',
    actions: {
      museLog: {
        payload: {
          items: [
            { type: 'weight', weight: '72.4', bodyFat: '24.1(任意)', waist: '(任意)' },
            { type: 'meal', text: '鶏むね肉のサラダ', mealType: '省略可(時刻から自動)', calories: '450', protein: '', fat: '', carb: '' },
            { type: 'strength', exercise: 'チェストプレス', part: '省略可(種目名から推定)', weight: '30(省略=自重)', reps: '10', sets: '3' },
            { type: 'cardio', exercise: 'ウォーキング', minutes: '30' }
          ],
          date: '省略可(今日/昨日/2026-11-03)。items内に個別指定も可'
        },
        note: 'items最大10件。結果は1件ずつ返る'
      },
      museTodaySummary: { payload: { date: '省略可' }, note: '指定日の摂取カロリーと運動の集計' },
      museWeightTrend: { payload: { days: '省略可(14)' } }
    },
    single: 'museLogWeight / museLogMeal / museLogStrength / museLogCardio でも1件ずつ記録できる(museLogと同じ項目)'
  };
}

function museSheetRows_(name) {
  var sh = spreadsheet_().getSheetByName(name);
  if (!sh) return [];
  var v = sh.getDataRange().getValues();
  return v.slice(1).filter(function (r) { return String(r[0] || '').trim() !== ''; })
          .map(function (r) { return r.map(normalizeCell_); });
}
function museLatestWeightKg_() {
  var rows = museSheetRows_('体重').filter(function (r) { return Number(r[1]) > 0; });
  if (!rows.length) return null;
  rows.sort(function (a, b) { return String(a[0]) < String(b[0]) ? -1 : 1; });
  return Number(rows[rows.length - 1][1]);
}
// 行を末尾に追加する(シートが無ければ見出し付きで作る)。排他制御つき。
function museAppend_(name, rows) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('他の処理と競合しました。少し待って再試行してください。');
  try {
    var ss = spreadsheet_();
    var sh = ss.getSheetByName(name);
    var header = MUSE_HEADERS[name];
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    var start = Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(start, 1, rows.length, header.length).setValues(rows);
    var now = new Date().toISOString();
    PropertiesService.getScriptProperties().setProperty('LAST_WRITE_AT', now);
    return now;
  } finally {
    lock.releaseLock();
  }
}

function museOne_(type, p) {
  p = p || {};
  var date = museResolveDate_(p.date);
  if (!date) return { status: 'error', message: 'dateは省略(=今日)か、今日/昨日/2026-11-03のような形で指定してください' };
  if (type === 'weight') {
    var w = museLoose_(p.weight);
    if (!isFinite(w) || w <= 0) return { status: 'error', message: 'weight(kg、数値)が必要です' };
    museAppend_('体重', [[date, w, museOpt_(p.bodyFat), museOpt_(p.waist)]]);
    return { status: 'ok', recorded: { date: date, weight: w } };
  }
  if (type === 'meal') {
    if (!p.text) return { status: 'error', message: 'text(メニュー名)が必要です' };
    var mealType = p.mealType || museGuessMealType_();
    var cal = museOpt_(p.calories); if (cal === '') cal = 0;
    museAppend_('食事', [[date, museSafe_(mealType), museSafe_(p.text), cal, museOpt_(p.protein), museOpt_(p.fat), museOpt_(p.carb)]]);
    return { status: 'ok', recorded: { date: date, mealType: mealType, text: p.text, calories: cal } };
  }
  if (type === 'strength') {
    var part = p.part || museGuessPart_(p.exercise);
    if (MUSE_PARTS.indexOf(part) < 0) return { status: 'error', message: '部位を判断できません。part を ' + MUSE_PARTS.join('/') + ' のいずれかで指定してください' };
    var reps = museLoose_(p.reps);
    if (!isFinite(reps) || reps <= 0) return { status: 'error', message: 'reps(回数、数値)が必要です' };
    var kg = (p.weight === undefined || p.weight === null || p.weight === '') ? 0 : museLoose_(p.weight);
    if (!isFinite(kg) || kg < 0) return { status: 'error', message: 'weight(kg、数値)が正しくありません' };
    var sets = (p.sets === undefined || p.sets === null || p.sets === '') ? 1 : Math.round(museLoose_(p.sets));
    if (!isFinite(sets) || sets < 1 || sets > 20) return { status: 'error', message: 'sets(セット数)は1〜20にしてください' };
    var rows = [];
    for (var i = 0; i < sets; i++) rows.push([date, part, museSafe_(p.exercise || ''), kg, reps, MUSE_STRENGTH_KCAL_PER_SET]);
    museAppend_('筋トレ', rows);   // アプリと同じく、1セット=1行
    return { status: 'ok', recorded: { date: date, part: part, exercise: p.exercise || null, weight: kg, reps: reps, sets: sets } };
  }
  if (type === 'cardio') {
    if (!p.exercise) return { status: 'error', message: 'exercise(種目名、例: ウォーキング)が必要です' };
    var min = museLoose_(p.minutes);
    if (!isFinite(min) || min <= 0) return { status: 'error', message: 'minutes(分、数値)が必要です' };
    var wkg = museLatestWeightKg_();
    var met = MUSE_CARDIO_MET[p.exercise] || MUSE_CARDIO_MET['その他'];
    var kcal = wkg != null ? Math.round((met * 3.5 * wkg / 200) * min) : '';
    museAppend_('有酸素', [[date, museSafe_(p.exercise), min, kcal]]);
    return { status: 'ok', recorded: { date: date, exercise: p.exercise, minutes: min, kcal: kcal === '' ? null : kcal } };
  }
  return { status: 'error', message: 'typeは weight/meal/strength/cardio のいずれかです' };
}
function handleMuseLog_(p) {
  var items = p && Object.prototype.toString.call(p.items) === '[object Array]' ? p.items : null;
  if (!items || !items.length) return { status: 'error', message: 'items(配列)が必要です。museHelpで例を確認できます' };
  if (items.length > 10) return { status: 'error', message: 'itemsは10件までです' };
  var results = [], allOk = true;
  items.forEach(function (it) {
    var r;
    try {
      var rest = {}; Object.keys(it || {}).forEach(function (k) { if (k !== 'type') rest[k] = it[k]; });
      if ((rest.date === undefined || rest.date === null) && p.date !== undefined) rest.date = p.date;
      r = museOne_(it && it.type, rest);
    } catch (e) { r = { status: 'error', message: String(e && e.message ? e.message : e) }; }
    r.type = it && it.type;
    if (r.status !== 'ok') allOk = false;
    results.push(r);
  });
  return { status: allOk ? 'ok' : 'partial', results: results };
}
function handleMuseTodaySummary_(p) {
  var date = museResolveDate_(p && p.date) || museDate_(0);
  var meals = museSheetRows_('食事').filter(function (r) { return r[0] === date; });
  var strength = museSheetRows_('筋トレ').filter(function (r) { return r[0] === date; });
  var cardio = museSheetRows_('有酸素').filter(function (r) { return r[0] === date; });
  var sum = function (rows, i) { return rows.reduce(function (s, r) { return s + (Number(r[i]) || 0); }, 0); };
  return {
    status: 'ok', date: date,
    intakeKcal: Math.round(sum(meals, 3)), proteinG: Math.round(sum(meals, 4)),
    meals: meals.map(function (r) { return { mealType: r[1], text: r[2], kcal: r[3] }; }),
    strengthSets: strength.length, cardioMinutes: sum(cardio, 2), cardioKcal: Math.round(sum(cardio, 3)),
    note: '目標カロリーや基礎代謝はアプリ側にしかないため、ここでは記録の合計だけを返します。'
  };
}
function handleMuseWeightTrend_(p) {
  var days = Math.min(Math.max(Math.round(museLoose_(p && p.days) || 14), 1), 365);
  var cutoff = museDate_(-days);
  var rows = museSheetRows_('体重').filter(function (r) { return String(r[0]) >= cutoff; })
    .sort(function (a, b) { return String(a[0]) < String(b[0]) ? -1 : 1; });
  return { status: 'ok', days: days, entries: rows.map(function (r) { return { date: r[0], weightKg: r[1], bodyFatPct: r[2] === '' ? null : r[2], waistCm: r[3] === '' ? null : r[3] }; }) };
}
// doPost / doGet から呼ぶ。Museのaction以外は null を返す。
function museRoute_(action, payload) {
  if (action === 'museHelp') return museHelp_();
  if (action === 'museLog') return handleMuseLog_(payload);
  if (action === 'museLogWeight') return handleMuseLog_({ items: [Object.assign({ type: 'weight' }, payload || {})] });
  if (action === 'museLogMeal') return handleMuseLog_({ items: [Object.assign({ type: 'meal' }, payload || {})] });
  if (action === 'museLogStrength') return handleMuseLog_({ items: [Object.assign({ type: 'strength' }, payload || {})] });
  if (action === 'museLogCardio') return handleMuseLog_({ items: [Object.assign({ type: 'cardio' }, payload || {})] });
  if (action === 'museTodaySummary') return handleMuseTodaySummary_(payload);
  if (action === 'museWeightTrend') return handleMuseWeightTrend_(payload);
  return null;
}
