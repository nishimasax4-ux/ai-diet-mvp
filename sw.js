/*
 * Training Log + AI — サービスワーカー (v44)
 *
 * 【これがあると何が変わるか】
 * ホーム画面から開いたときに、電波が届かない場所(地下のジム、機内モード)でも
 * アプリが起動するようになります。記録そのものは元々オフラインでも書けますが、
 * v43まではアプリのファイル自体を読み込めず、真っ白な画面になっていました。
 *
 * 【方針: 表示は必ずネットワーク優先】
 * まずネットから最新のindex.htmlを取りに行き、取れたらそれを表示して控えも更新します。
 * 取れなかったときだけ、控えを表示します。
 * 「キャッシュ優先」にすると、更新したのに古い画面が出続けるという厄介な状態に
 * なりやすいため、あえて遅くなっても新しさを優先しています(このアプリは1ファイル
 * だけなので、この方式でも実用上の遅さはほとんどありません)。
 *
 * 【古い控えの捨て方】
 * 控えの置き場所の名前にバージョンを入れてあります。バージョンを上げると
 * 別の置き場所になり、古いほうは activate のときに削除します。
 *
 * 【触らないもの】
 * Google Sheets(Apps Script)との通信はPOSTで、ここでは一切横取りしません。
 * 同期やAIの応答が控えに残ることはありません。
 */
const VERSION = 'v46.6';
const CACHE = 'training-log-' + VERSION;
// このサービスワーカーが置かれている場所(GitHub Pagesのサブフォルダでも動くよう相対で解決)。
const HTML_URL = new URL('./index.html', self.registration.scope).href;
const ROOT_URL = new URL('./', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll([ROOT_URL, HTML_URL]))
      // 初回にネットが不安定でも、インストール自体は失敗させない
      // (次にオンラインで開いたときにfetch側で控えが作られる)。
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.indexOf('training-log-') === 0 && k !== CACHE)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // POST(Apps Scriptへの同期・AI)や他サイトへの通信には手を出さない。
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // 【重要】アプリを開くときの通信は、ブラウザ自身の一時保存を必ず読み飛ばす。
  // GitHub Pagesはページに10分間の保存期間を付けて返すため、そのまま取りに行くと
  // 「更新したのに古い画面のまま」が最大10分続く。ここで no-cache を付けると
  // 毎回サーバーに確認が入り(変わっていなければ中身は再ダウンロードされないので
  // 通信量はほとんど増えない)、更新が確実に反映される。
  const isPageLoad = req.mode === 'navigate' || req.destination === 'document';
  const request = isPageLoad ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : req;

  event.respondWith(
    fetch(request)
      .then((res) => {
        // 取れたら控えを最新にしておく(次のオフライン時に備える)。
        if (res && res.ok) {
          const copy = res.clone();
          // 控えは元のリクエストの見出しで保存する(次にオフラインで開いたとき、
          // 同じ見出しで探せるようにするため)。
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit
          // 「/」で開かれたときなど、リクエストが完全一致しない場合の受け皿。
          || caches.match(HTML_URL)
          || new Response('オフラインです。電波の届く場所で一度開くと、次からはオフラインでも起動できます。',
               { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))
      )
  );
});
