# Training Log + AI — Cloudflare Workers版バックエンド

これまでGoogle Apps Script(`apps-script-1file.gs`)で動かしていた同期・AI機能の
バックエンドを、Cloudflare Workersで動かすための代替版です。

**アプリから見た役割はApps Script版とまったく同じです。** データの保存先も、引き続き
あなたのGoogleスプレッドシートです。変わるのは「どこでコードが実行されるか」だけで、
アプリ(index.html)側の変更は不要です(設定タブのURL欄に、Apps ScriptのURLの代わりに
このWorkerのURLを貼り付けるだけです)。

## 全体の流れ

1. Googleクラウド側で「サービスアカウント」を作り、スプレッドシートを共有する
2. Cloudflareでこのコードをデプロイする(`wrangler`コマンドを使います)
3. アプリの設定タブに、デプロイしたURLと合言葉を入力する

所要時間の目安は15〜20分です。途中、Google Cloud ConsoleとCloudflareのダッシュボードを
行き来します。

---

## 1. Google側の準備(サービスアカウントを作る)

Apps Script版は「あなたのGoogleアカウントの権限でスプレッドシートを操作する」
仕組みでしたが、Cloudflare Workersはあなたのアカウントにログインできないので、
代わりに「サービスアカウント」という、プログラム用の専用アカウントを使います。

1. [Google Cloud Console](https://console.cloud.google.com/) を開き、新しいプロジェクトを作成します(すでにプロジェクトがあれば流用して構いません)。
2. 左上の検索バーで「Google Sheets API」を検索し、**有効にする** をクリックします。
3. 左メニューの「APIとサービス」→「認証情報」→ 画面上部の「認証情報を作成」→「サービスアカウント」を選びます。
4. 名前は何でも構いません(例: `training-log-backend`)。役割(ロール)の設定はスキップして構いません。
5. 作成されたサービスアカウントの一覧から、今作ったものをクリックし、「キー」タブ →「鍵を追加」→「新しい鍵を作成」→ 形式は **JSON** を選んでダウンロードします。
6. ダウンロードされたJSONファイルをテキストエディタで開き、以下の2つの値を控えておきます(あとでCloudflareのシークレットに設定します)。
   - `client_email` … `xxxxx@xxxxx.iam.gserviceaccount.com` のような形式
   - `private_key` … `-----BEGIN PRIVATE KEY-----` から始まる長い文字列(`\n` を含んだまま控えてOKです)
7. 同期に使いたいGoogleスプレッドシートを開き、右上の「共有」ボタンから、手順6の `client_email` の値を **編集者** として共有します。
   - ここを忘れると、Workerがスプレッドシートを読み書きできずにエラーになります。
8. スプレッドシートのアドレスバーのURLから、`SHEET_ID` を控えます。
   `https://docs.google.com/spreadsheets/d/【ここの部分】/edit` の【ここの部分】です。

## 2. Cloudflare Workersのセットアップ

事前に [Cloudflareの無料アカウント](https://dash.cloudflare.com/sign-up) と、
手元のパソコンに Node.js(18以降)が必要です。

このフォルダ(`cloudflare-worker/`)をパソコンにダウンロードし、ターミナルでこの
フォルダに移動してから、以下を順番に実行します。

```bash
# 1. 必要なツール(wrangler)をインストール
npm install

# 2. Cloudflareアカウントにログイン(ブラウザが開きます)
npx wrangler login

# 3. データ保存用のKV(簡易データベース)を作成
npx wrangler kv namespace create SYNC_KV
```

3の実行結果に `id = "xxxxxxxxxxxx"` のような表示が出るので、その値を
`wrangler.toml` の `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` の部分に書き換えて保存します。

続けて、シークレット(あなたのキー・パスワード類)を登録します。1つずつ実行し、
聞かれたら値を貼り付けてEnterを押してください(画面には表示されません)。

```bash
npx wrangler secret put APP_TOKEN
# → アプリの設定タブに入れる合言葉。自分で決めた文字列でOK(例: 適当な16文字程度のランダム文字列)

npx wrangler secret put SHEET_ID
# → 手順1-8で控えたスプレッドシートのID

npx wrangler secret put GOOGLE_CLIENT_EMAIL
# → 手順1-6で控えた client_email の値

npx wrangler secret put GOOGLE_PRIVATE_KEY
# → 手順1-6で控えた private_key の値(\nが入ったままで貼り付けてください)

npx wrangler secret put GEMINI_API_KEY
# → 任意。Google AI Studio (https://aistudio.google.com/) で発行したキー。使わないなら Ctrl+C でスキップ可

npx wrangler secret put GROQ_API_KEY
# → 推奨。console.groq.com で無料発行(クレジットカード登録不要)。使わないならスキップ可
```

最後にデプロイします。

```bash
npx wrangler deploy
```

成功すると、`https://training-log-backend.あなたのサブドメイン.workers.dev` の
ようなURLが表示されます。これが「バックエンドのURL」です。

## 3. アプリ側の設定

1. トレーニングログアプリを開き、「設定」タブ →「Google Sheets連携」を開きます。
2. 「バックエンドのURL」欄に、手順2でデプロイしたWorkerのURLを貼り付けます。
3. 「アクセストークン」欄に、`APP_TOKEN` に設定したのと同じ値を入力します。
4. 「接続設定を保存」をタップします。
5. 「接続先: v1.0-cf ✅」のように表示されれば成功です。

これで、これまでApps Scriptで行っていた同期・AI機能が、すべてCloudflare Workers
経由で動くようになります。アプリ側の操作感は何も変わりません。

## 更新のしかた

このコードを修正した場合は、`npx wrangler deploy` を再実行するだけで反映されます
(Apps Script版の「デプロイを管理 → 新バージョン」のような手順は不要です)。

## 既知の制限・注意点

- **同時書き込みの排他制御**: Apps Script版は`LockService`で「他の同期処理と
  少し待ち合わせる」仕組みがありましたが、Cloudflare KVの性質上、まったく同じ
  排他制御は再現していません。個人利用・1〜2台での利用であれば実用上問題に
  なることはほぼありませんが、複数端末からほぼ同時に同期した場合、ごくまれに
  後から書き込んだ方が勝つ可能性があります(食い違いの検知自体は従来どおり
  行われるので、「上書きするかどうか」の確認は変わらず表示されます)。
- **料金**: 個人利用の範囲であれば、Cloudflare Workers・KVともに無料枠
  (Workers: 1日10万リクエスト、KV: 1日10万読み取り・1,000書き込み)に収まる
  見込みです。
- **Googleのアクセストークン**: 発行したトークンはCloudflare KVに約1時間
  キャッシュされ、使い回されます。

## トラブルシューティング

- 「Google認証に失敗しました」と出る → `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY`
  の設定、またはスプレッドシートをサービスアカウントに共有できているかを確認してください。
- 「Sheets APIエラー」と出る → スプレッドシートの共有設定(編集者になっているか)、
  `SHEET_ID` が正しいかを確認してください。
- デプロイ後もアプリ側で「接続先」が表示されない → URLの末尾のスラッシュの有無や
  コピーミスがないか確認し、設定タブで保存し直してみてください。
