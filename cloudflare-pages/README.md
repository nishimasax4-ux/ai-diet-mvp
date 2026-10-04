# Training Log + AI — Cloudflare Pagesへの移行ガイド

これまでGitHub Pagesで公開していた `index.html` / `sw.js` を、Cloudflare Pagesで
公開するための手順です。**アプリのコードは一切変更不要です。** このアプリは単一の
HTMLファイルで、Service Workerの登録もすべて相対パス(`sw.js`・`self.registration.scope`
基準)で書かれているため、どのホスティング先・どのURLに置いても同じように動きます。

同期・AI機能のバックエンド(Google Apps Script または `cloudflare-worker/`)の設定は
今回の移行と無関係です。バックエンドの接続設定(設定タブのURL・トークン)は
ブラウザのlocalStorageに保存されているため、ホスティング先を変えても引き継がれません
(後述の「移行後の注意」を参照)。

## 方法A: GitHubリポジトリ連携(推奨)

今GitHub Pagesで公開しているのと同じリポジトリを、Cloudflareに接続するだけです。
pushするたびに自動でデプロイされるようになり、GitHub Pagesと同じ運用感覚で使えます。

1. [Cloudflareダッシュボード](https://dash.cloudflare.com/) を開き、左メニューの
   「Workers & Pages」→「作成」→「Pages」タブ→「Gitに接続する」を選びます。
2. GitHubアカウントを連携し、対象のリポジトリを選びます。
3. ビルド設定は以下のとおりにします(このアプリはビルド不要の静的ファイルのため)。
   - フレームワークのプリセット: **なし(None)**
   - ビルドコマンド: **空欄のまま**
   - ビルド出力ディレクトリ: `index.html` が置かれている場所(通常はリポジトリの
     ルートなら `/`、サブフォルダに置いているならそのフォルダ名)
4. 「保存してデプロイ」を押すと数十秒でデプロイが完了し、
   `https://(プロジェクト名).pages.dev` のようなURLが発行されます。
5. 以後は、このリポジトリに push するたびに自動で再デプロイされます
   (GitHub Pagesの「Settings → Pages」の代わりに、Cloudflare側が自動更新を担当します)。

## 方法B: 直接アップロード(Wrangler CLI、Gitを使わない場合)

GitHubリポジトリと連携せず、手元のファイルを直接アップロードしたい場合はこちらです。

```bash
# index.html と sw.js だけを入れたフォルダを用意します(例: ./public)
mkdir -p public
cp index.html sw.js public/

# Cloudflareにログイン(初回のみ、ブラウザが開きます)
npx wrangler login

# デプロイ(初回はプロジェクト名を聞かれます)
npx wrangler pages deploy ./public --project-name=training-log
```

以後、ファイルを更新するたびに同じコマンドを再実行すれば上書きデプロイされます。

> `apps-script-1file.gs` や `cloudflare-worker/` のソースまで一緒に公開したくない
> 場合は、方法Bのように `index.html` と `sw.js` だけを入れた専用フォルダから
> デプロイするのがおすすめです(方法Aでリポジトリ全体を連携する場合、リポジトリに
> 置いてあるファイルがそのまま公開されます。今の配布物に機密情報は含まれていません
> が、見た目をすっきりさせたい場合はリポジトリ構成を整理してください)。

## カスタムドメインを使いたい場合(任意)

デプロイしたPagesプロジェクトの画面から「Custom domains」→「Set up a custom domain」で、
お持ちのドメイン(Cloudflareでネームサーバーを管理しているもの)を割り当てられます。
`.pages.dev` のままで構わなければ、この手順は不要です。

## 移行後の注意

- **ブラウザのlocalStorageはURL(オリジン)ごとに独立しています。** 今まで
  `https://(ユーザー名).github.io/...` で使っていた記録データは、新しい
  `https://(プロジェクト名).pages.dev` では見えません。乗り換える際は、設定タブの
  「⬇️ JSONで書き出し」でこれまでのデータを書き出し、新しいURLを開いてから
  「⬆️ JSONから復元」で引き継いでください。Google Sheets連携を設定済みであれば、
  新しいURL側で同じバックエンドのURL・トークンを入力して「☁️ シートから復元する」
  する方法でも引き継げます。
- **ホーム画面に追加(PWA)している場合**、アイコンは古いURLに紐づいたままです。
  新しいURLを開いてから、あらためて「ホーム画面に追加」をやり直してください
  (Service Workerのキャッシュは新しいオリジンで自動的に作り直されるため、
  アプリ側の対応は不要です)。
- **GitHub Pagesを止めるタイミング**は、新しいURLでの動作・データ引き継ぎを
  確認したあとにしてください。しばらくは両方同時に公開しておいても問題ありません
  (リポジトリの「Settings → Pages」で、GitHub Pagesをいつでも無効化できます)。
