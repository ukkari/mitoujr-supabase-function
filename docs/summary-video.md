# 日本語の Mattermost 日次まとめ動画

既存の文章・画像まとめに加えて、前日 00:00–24:00 JST の投稿を最長60秒（話題が少ない日は短く）の
日本語音声付き MP4 にし、同じ `MATTERMOST_SUMMARY_CHANNEL` へ投稿する。
GitHub Actions の起動時刻は **毎日07:00 JST**。実際の投稿は動画完成後で、
Actions の混雑による起動遅延もあり得る。

## 実装と再利用元

[PlaceReel](https://github.com/ukkari/placereel) の commit
`2f4582c69885682385b861cb0c13efb1cf84d6de` から、120 BPM のタイムライン、
Canvas の文字組み、トランジション、dopamine 演出、効果音・BGM、
音程を維持する音声伸縮を `video/vendor/placereel/` に取り込んだ。
Google Maps / Apify / 英語口コミの処理は使用しない。

```text
GitHub Actions (07:00 JST)
  ├─ Worker 管理API → Mattermost収集 → Geminiで日本語台本・演出
  ├─ Worker 管理API → Gemini TTSでシーンごとの読み上げ
  ├─ Chromium → PlaceReelのCanvas・BGM・効果音
  ├─ FFmpeg → 720×1280 / 30fps / 10〜60秒 / H.264 + AAC MP4
  └─ Worker 管理API → まとめ投稿のスレッドへ動画を返信
```

目的は「どのチャンネルで何が起きているか」を広く知ってもらうこと。投稿があったチャンネルは原則1チャンネル1シーンで、
投稿の多い順に紹介する（最大13シーン）。入りきらないチャンネルは、締めの前の4秒で「ほかにも N チャンネルで動きあり！」として
チャンネル名・投稿数・人数・よく投稿した人のアイコンを一覧表示する（最大12件、それ以上は件数のみ）。架空の話題で水増ししない。冒頭・締めは各2秒。
話題ごとに Gemini が30種類の声から配役し（隣り合う話題は別の声）、「驚きを隠せずハイテンションで」のような演技指示と、
必要なら冒頭の笑い声・息をのむ音などを付けて読み上げる。各声は場面の切り替わりの0.2秒前から話し始め、前の声と最大0.35秒重なる。
読み上げは1.7倍を目安に早送り（1.45〜2倍）し、各シーンの長さは実際の音声から3〜6秒（1秒=2拍刻み）に決める。
そのため動画の長さは話題数で変わり、例えば7話題なら約25〜30秒になる。本文が56秒を超える場合は最大2倍まで速める。
それでも収まらない場合は文章を短く生成し直し、台本と音声を両方更新する。
それでも収まらなければ失敗とし、途中で切れた音声や無音動画を投稿しない。
動画は、同じ日の文章・画像まとめ（Workflow `summary-<日付>` が投稿）のスレッドへの返信として、スレッドの最後に投稿する。
本文は Gemini が作る絵文字入りのタイトル1行だけで、チャンネルへのリンクは付けない。
まとめと動画はどちらも07:00 JSTに動き出すため、まとめの投稿が未完了なら、動画ジョブは1分おき・最大20分待ってから返信する
（Worker は 425 を返し、投稿権を確保しない）。まとめが完了しなければ失敗とし、単独投稿はしない。
`VIDEO_TEST_CHANNEL` を設定した検証バージョンでは、テストチャンネルへ単独で投稿する。

### 映像の構成（dopamine 演出）

- 冒頭2秒: 見出しを叩きつけ、投稿数・メンバー数・リアクション数のカウントアップと、よく投稿した人のアイコンを表示する。
- 絵文字: Gemini が日・話題ごとに絵文字を3〜5個選ぶ（絵文字以外は除外）。話題の頭に巨大な絵文字を叩きつけて右上に置き、
  背景は絵文字の壁紙、カード登場時に絵文字が飛び散る。リアクションは配信の「いいね」のように湧き上がる。
- 各話題: 種類バッジ（進捗・相談・共有・盛り上がり・お知らせ）、見出しの単語ポップ、
  **元投稿カード1〜4枚**（アイコン・ユーザー名・時刻・本文の抜粋・リアクション／返信数）を拍に合わせて順に表示する。
  別チャンネルの関連投稿も同じシーンに並べられる。絵文字ステッカー、毎回異なるトランジションも入る。
- その日いちばんリアクションを集めた投稿で、フリーズ＋ブーム音＋「リアクション ×N」スタンプを出す。
- 締め2秒: 盛り上げた人たちのアイコンを並べ、紙吹雪を出す。
- 読み上げの文章は画面に表示しない（画面は投稿カードと演出に使う）。

Gemini は番号付きの全投稿（リアクション・返信数つき）を読み、シーンごとに表示する投稿と
42文字以内の抜粋を選ぶ。抜粋が本文にそのまま含まれない場合は、本文の冒頭を使う（言い換えた引用は出さない）。
台本（48時間で消去）に保存するのは、選ばれた投稿の抜粋・ユーザー名・ユーザーIDだけで、本文全体は保存しない。
アイコンは `GET /admin/summary-video/:date/avatar/:userId` で Worker が取得して中継する。
取得できるのは台本に登場する人に限る。取得できない場合は頭文字のアイコンを表示する。

動画の台本・音声は `GEMINI_API_KEY` のみを使う。既存の文章・画像まとめは従来の
OpenAI 設定を維持する。TTS は [Gemini の現行 REST 仕様](https://ai.google.dev/gemini-api/docs/speech-generation)
の `interactions`、`speech_metadata`、WAV 出力を使用する。

## キーの保存先

| 保存先 | キー | 用途 |
|---|---|---|
| Cloudflare Worker Secrets | `OPENAI_API_KEY` | 既存の文章・画像まとめ |
| Cloudflare Worker Secrets | `GEMINI_API_KEY` | 新しい動画の台本・音声 |
| Cloudflare Worker Secrets | `MATTERMOST_*`, `TURSO_*` | 既存の投稿・DBアクセス |
| Cloudflare Worker Secrets | `ADMIN_TRIGGER_SECRET` | 管理APIのBearer認証 |
| Cloudflare Worker Secrets | `VIDEO_RUNNER_SECRET` | 動画APIだけの専用Bearer認証 |
| GitHub Actions `production` secrets | `VIDEO_RUNNER_SECRET` | 動画ジョブからWorkerへの認証（同じ値） |
| GitHub Actions secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | 既存のデプロイ処理 |
| ローカルのGit対象外 `.dev.vars` | 開発用の各値 | `wrangler dev` 用。自動で本番から取得されない |

Cloudflare の保存済み Secret は値を読み戻せない。名前の確認は
`npx wrangler secret list --env=""`。設定は対話入力で行い、チャットやログに値を出さない。

```bash
npx wrangler login
npx wrangler secret put GEMINI_API_KEY --env=""
npx wrangler secret put VIDEO_RUNNER_SECRET --env=""
gh secret set VIDEO_RUNNER_SECRET --repo ukkari/mitoujr-supabase-function --env production
```

`GEMINI_MODEL`（既定 `gemini-3.8-flash`）、`GEMINI_TTS_MODEL`
（既定 `gemini-3.8-flash-tts`）、`GEMINI_VOICE`（既定 `Kore`）は任意のWorker変数。
`VIDEO_RUNNER_SECRET` は新しく生成した十分に長いランダム値を両方に登録する。
既存の `ADMIN_TRIGGER_SECRET` を変更する必要はない。ローカル実行は管理用キーでも認証できる。

## 検証と有効化

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run deploy:dry-run
npm run video:demo
```

`video:demo` は秘密値不要。架空の投稿・ユーザー・テストトーン・BGMで、実際に動画を
書き出して ffprobe で形式・寸法・音声・長さ・40 MiB以下を検証する。
出力は `dist/video/summary.mp4` と確認用の静止画。デモの投稿は拒否する。
Linux では日本語フォント `fonts-noto-cjk` と絵文字フォント `fonts-noto-color-emoji` も必要（Actionsでは導入済み）。

Worker の認証情報が揃ったら、管理APIを含む変更をデプロイする。
`summary_videos` テーブルは migration `0005` または認証済みの最初の prepare
リクエストで冪等に作成される。既存のTurso秘密値を動画ジョブへ移す必要はない。

ローカルから実データで動画のみ生成する例（環境変数は事前設定）：

```bash
export VIDEO_API_URL=https://mattermost-automation.ukkaripon.workers.dev
npm run video -- --date 2026-09-25
# 内容を確認し、テストチャンネルで検証した後に投稿する
npm run video -- --date 2026-09-25 --post
```

ローカルの `.dev.vars.video` に動画APIの接続情報を保存している場合は、
`node --env-file=.dev.vars.video --import tsx video/run.ts` で読み込める。
このファイルは `.gitignore` の対象であり、Gitへ追加しない。

本番を操作する前に、テスト用の `.dev.vars` の `MATTERMOST_SUMMARY_CHANNEL` を
テストチャンネルへ向けて `wrangler dev` で添付投稿を確認する。
staging の `DRY_RUN=true` は変更しない。`--post` のない実行でもGeminiの生成料金は発生する。

本番トラフィックを切り替えない Worker Version URL でも検証できる。
その検証バージョンだけに `VIDEO_TEST_CHANNEL=z-times-yuukai` のように公開チャンネルの
名前を設定すると、動画の添付先がそのチャンネルになる。配信IDも `test:チャンネル名:日付`
に分離され、本番の同日分を投稿済みにはしない。本番設定にはこの変数を入れない。

GitHub の `Daily Mattermost summary video` は手動起動できる。手動起動の `post` は
既定で `false`。実データを含むMP4・音声・台本はActions artifactへアップロードしない。
確認が終わったらリポジトリ変数を有効にする。

```bash
gh variable set SUMMARY_VIDEO_ENABLED --body true --repo ukkari/mitoujr-supabase-function
```

変更がデフォルトブランチに入ると、翌朝7時の自動起動対象になる。
停止は `SUMMARY_VIDEO_ENABLED=false`。既存の文章まとめのCronは独立している。

## 再実行・データ保持

- 管理APIは `/admin/summary-video/:date/prepare`、`/audio/:index`、`/avatar/:userId`、`/publish`。
  Bearer認証必須。対象日は直近7日と当日だけ。
- 日付ごとに配信状態をTursoへ記録する。投稿済みの日は再生成・再投稿しない。
- 投稿中は10分の占有期間を設ける。応答喪失後はBot自身の
  `props.summary_video_date` を照合してから再試行する。
- 投稿失敗は成功扱いにしない。占有期間経過後に同じ日を再実行できる。
- 台本は48時間の有効期限を持ち、投稿成功時に即時消去する。期限切れはCronとprepareで
  消去する（物理削除は次の実行時）。本文・音声・キーをログへ出さない。
- 公開チャンネルだけを収集し、`🈲` / `🚫` のチャンネルとスレッド、通知チャンネル、
  投稿先、入退室等のシステム投稿を除外する。制限確認失敗時も除外する。
- 当日に話題がなければ動画は作らず、既存の「更新なし」文章投稿に任せる。

## この変更での確認状況

ローカルで型検査、ユニット・APIテスト、Worker dry-run bundle、
60秒MP4の実レンダリングと日本語レイアウトを確認。
2026-09-26に本番のGeminiキーを使い、前日分の実データから日本語音声入り60秒MP4を生成し、
検証用Workerバージョンから `z-times-yuukai` へ添付投稿できることを確認した。
本番コードのデプロイと定期起動の有効化は、この変更の反映後に行う。
