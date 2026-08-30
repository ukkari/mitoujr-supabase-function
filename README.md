# Mattermost Automation on Cloudflare Workers

未踏ジュニア Mattermost のリマインダーと日次サマリーを、Cloudflare Workers / Cron Triggers / Workflows と Turso で実行する。

本番 Worker は `https://mattermost-automation.ukkaripon.workers.dev`。Mattermost の `/reminder` と `/reminder-mentors` はこの Worker に接続済みで、定期処理も Cloudflare Cron から起動する。旧 Supabase Cron は全件停止済みである。

Supabase Functions / Postgres は移行後の監視とロールバックに備えて当面残すが、新しい本番処理からは参照しない。Supabase Storage だけは既存音声リンクの読み取り先として維持する。音声生成と新規 Storage アップロードは廃止済み。

移行時の検証値と切替手順は [Cloudflare Workers + Turso migration runbook](docs/2026-08-30-cloudflare-turso-migration.md) に記録している。

## Architecture

| Component | Role |
|---|---|
| Cloudflare Worker + Hono | Slash Command と管理 API の HTTP エンドポイント、Cron の `scheduled()` handler |
| Cloudflare Cron Triggers | 00:00 JST のリマインダーと 07:00 JST の前日サマリー起動 |
| Cloudflare Workflows | Mattermost 収集、OpenAI 生成、Mattermost 投稿のステップ実行と再試行 |
| Turso / libSQL | リマインダー、配信 claim、Workflow の一時本文を保存 |
| Mattermost API | 投稿、スレッド・reaction・User Group・チャンネルの取得、画像アップロード |
| OpenAI API | `gpt-5.6-luna` のテキスト要約と `gpt-image-2` の画像生成 |
| Supabase Storage | 移行前に生成された既存音声オブジェクトの読み取り専用保管先 |

処理経路は次のとおり。

```text
Mattermost Slash Command ──POST──> Worker ──> Turso / Mattermost API

Cloudflare Cron 00:00 JST ──> Worker scheduled() ──> Turso ──> Mattermost reply

Cloudflare Cron 07:00 JST ──> Workflow
  ├─ Mattermost の前日投稿を収集
  ├─ OpenAI でテキスト要約
  ├─ OpenAI で画像生成し Mattermost へアップロード
  └─ Mattermost のサマリーチャンネルへ投稿
```

## Production routes

外部公開する Route は以下だけで、Cron 用の HTTP Route は存在しない。CORS と本番用 `debug=true` Routeも設けていない。

| Method | Path | Purpose | Authentication |
|---|---|---|---|
| `POST` | `/slash-reminder` | Mattermost `/reminder` | form の Slash Command token |
| `POST` | `/slash-reminder-mentors` | Mattermost `/reminder-mentors` | form の Slash Command token |
| `POST` | `/admin/daily-summary` | 日次サマリーを手動起動 | `Authorization: Bearer ...` |
| `GET` | `/admin/daily-summary/:runId` | Workflow 状態を確認 | `Authorization: Bearer ...` |

Mattermost 側の Request URL は次の設定にする。

```text
/reminder
https://mattermost-automation.ukkaripon.workers.dev/slash-reminder

/reminder-mentors
https://mattermost-automation.ukkaripon.workers.dev/slash-reminder-mentors
```

想定外の method / path は `404`、Slash token 不一致は `403`、管理 API の認証不備は `401` で拒否する。

## Slash Commands

入力は Mattermost の `application/x-www-form-urlencoded` 形式を維持している。

```text
/reminder YYYY/MM/DD @user1 @user2 本文
/reminder YYYY/MM/DD @user-group 本文
/reminder stop <post_id または post link>

/reminder-mentors YYYY/MM/DD 本文
/reminder-mentors stop <post_id または post link>
```

- 日付は実在する日付を含め、厳密な `YYYY/MM/DD` だけを受け付ける。
- `/reminder` は通常ユーザーと Mattermost User Group の両方を受け付ける。
- User Group は完全一致で検索し、全ページのメンバーを個別 username に展開してから Turso へ保存する。
- ユーザーやUser Groupを解決できない場合は、意図しない Group mention を避けるため登録しない。
- `/reminder-mentors` と、対象ユーザー情報がない旧形式データはメンターグループを対象にする。
- `stop` は冪等で、停止済み reminder への再実行も成功応答にする。
- 新規 reminder の `post_id` を Turso の主キーとして使用する。

## Scheduled reminder

`0 15 * * *`（UTC）、つまり毎日 00:00 JST に未完了 reminder を確認する。

1. Mattermost の元投稿が削除済みなら reminder を完了扱いにする。
2. 元投稿とスレッド上の `done`、`white_check_mark`、`heavy_check_mark` reaction を確認する。
3. 対象者全員が完了していれば Turso の `completed` を更新する。
4. 締切日の7、5、3、2、1日前、当日、または期限後なら未完了者へ reply する。
5. `post_id + JST実行日` を `reminder_deliveries` で claim してから投稿する。

日数は経過時間ではなくJSTのカレンダー日で計算する。同一日の delivery は一意で、失敗状態と15分以上更新されていない pending claim だけ再試行できる。Mattermost の `pending_post_id` も保存するため、API 応答喪失時の再送でも二重投稿を抑止する。

## Daily summary Workflow

`0 22 * * *`（UTC）、つまり毎日 07:00 JST に前日 00:00–24:00 JST のサマリーを起動する。Workflow ID は `summary-YYYY-MM-DD` で、Cron と手動起動が重なっても対象日ごとに一意になる。

Workflow は以下の単位で外部 I/O を分離する。

1. 公開チャンネル一覧を取得する。
2. 更新のあったチャンネルを1チャンネルずつ収集する。
3. OpenAI でテキストサマリーを生成する。
4. OpenAI で画像を生成し Mattermost へアップロードする。
5. テキストと画像をサマリーチャンネルへ投稿する。
6. Turso の一時本文を消去する。

チャンネル収集・テキスト生成・最終投稿は最大3回、画像生成とアップロードは最大2回、指数 backoff で再試行する。画像だけ失敗した場合はテキストのみ投稿する。更新がなければその旨を投稿する。

チャンネルの purpose / header に `🈲` または `🚫` がある場合は除外する。制限判定API自体が失敗した場合も、情報漏えいを避けてそのチャンネルを除外する。サマリーチャンネル自身と、表示名に `notification` を含むチャンネルも収集対象外である。

Workflow の step 出力には Mattermost 本文を含めない。生成に必要な本文は `summary_runs` / `summary_run_fragments` に最大48時間だけ保存し、成功時に即時消去する。

## Admin API

`ADMIN_TRIGGER_SECRET` を Bearer token として指定する。shell history へ値を直書きしないこと。

当日分を手動起動する例：

```bash
curl -X POST "https://mattermost-automation.ukkaripon.workers.dev/admin/daily-summary" \
  -H "Authorization: Bearer $ADMIN_TRIGGER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"target":"today"}'
```

前日分の場合は `target` を `yesterday` にする。成功時は Workflow ID を含む `202`、同じ対象日の実行中または完了済み instance があれば `409` を返す。`errored` または `terminated` の instance だけ再開できる。

```bash
curl \
  "https://mattermost-automation.ukkaripon.workers.dev/admin/daily-summary/summary-2026-08-30" \
  -H "Authorization: Bearer $ADMIN_TRIGGER_SECRET"
```

旧音声機能の `type` パラメーターは、値にかかわらず `400` で拒否する。

## Database

本番は Turso の `mattermost-automation` database、既存 `default` group、東京 primary (`aws-ap-northeast-1`) を使用する。

| Table | Purpose |
|---|---|
| `reminders` | 元投稿、チャンネル、締切日、本文、対象ユーザーJSON、完了状態、作成・更新時刻、旧行JSON |
| `reminder_deliveries` | `post_id + delivery_date_jst` 単位の claim、試行回数、Mattermost reply ID、エラー |
| `summary_runs` | Workflowの対象日と一時収集本文・生成文、48時間の有効期限 |
| `summary_run_fragments` | チャンネル単位の一時収集本文 |
| `schema_migrations` | 適用済み migration version |

Migration は `migrations/` のファイル名順に適用され、再実行しても適用済み version はスキップする。

```bash
npm run db:migrate
npm run db:migrate
```

Supabase からの移行またはロールバック時だけ、次のスクリプトが Supabase にアクセスする。Worker runtime には Supabase dependency がない。

```bash
npm run db:export-supabase
npm run db:import
npm run db:verify
npm run db:export-turso
npm run db:rollback-sync -- --since <cutover-ISO-timestamp>
```

`db:verify` は総件数、completed別件数、締切日の最小・最大、正規化行の SHA-256 checksum を比較する。移行データは `.migration-data/` に mode `0600` で保存し、Git の対象外にする。

## Configuration and secrets

ローカルは Node.js 24 を使用する。

```bash
npm ci
npx wrangler login
turso auth login
```

秘密値はコミットしない。ローカルでは [.dev.vars.example](.dev.vars.example) と同じキーを `.dev.vars` に設定し、本番 / staging は `wrangler secret put` を使用する。

| Secret | Purpose |
|---|---|
| `TURSO_DATABASE_URL` | libSQL endpoint |
| `TURSO_AUTH_TOKEN` | Turso database token |
| `MATTERMOST_URL` | Mattermost base URL |
| `MATTERMOST_BOT_TOKEN` | Mattermost API bot token |
| `MATTERMOST_SLASH_REMINDER_TOKEN` | `/reminder` request verification |
| `MATTERMOST_SLASH_TOKEN` | `/reminder-mentors` request verification |
| `MATTERMOST_MAIN_TEAM` | 収集対象 team ID |
| `MATTERMOST_SUMMARY_CHANNEL` | サマリー投稿先 channel ID |
| `MATTERMOST_MENTOR_GROUP_ID` | メンター対象 group ID |
| `OPENAI_API_KEY` | テキスト・画像生成 |
| `ADMIN_TRIGGER_SECRET` | 管理 API と冪等投稿IDの署名 |

通常変数は [wrangler.jsonc](wrangler.jsonc) で管理する。

| Variable | Production | Staging |
|---|---|---|
| `OPENAI_TEXT_MODEL` | `gpt-5.6-luna` | `gpt-5.6-luna` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` | `gpt-image-2` |
| `DRY_RUN` | `false` | `true` |
| Cron Triggers | 2件 | なし |

`DRY_RUN=true` は reminder reply とサマリー投稿を抑止する。staging は必ずこの状態を維持し、Cron は登録しない。

## Development and verification

```bash
npm run typecheck
npm test
npm run deploy:dry-run
npm run dev
```

テストは strict な日付検証、JST締切日前後、User Group完全一致と201人 pagination、stop の冪等性、削除済み投稿、3種類の done reaction、不明ユーザー、旧 content 形式、Turso障害、認証、音声パラメーター拒否、配信重複防止、Workflow retry と画像 fallback を対象にする。

staging へは次でデプロイする。

```bash
npm run deploy:staging
```

staging は `mattermost-automation-staging`、Workflow は `daily-summary-workflow-staging` である。ただし、初回本番切替時に staging Worker を本番名へ rename して秘密値を引き継いだため、再度 staging を使う場合は staging secrets が揃っていることを先に確認する。

## Deployment and CI

本番への手動デプロイ：

```bash
npm run deploy
```

GitHub Actions は Pull Request で次を検証する。

- TypeScript typecheck
- Vitest
- 空の libSQL DB への migration 2回適用
- `wrangler deploy --dry-run`

`main` への push では検証成功後に本番 Worker と Workflow をデプロイする。GitHub の `production` environment に `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` が必要である。

## Operations

本番のデプロイと Workflow を確認する。

```bash
npx wrangler deployments status
npx wrangler deployments list
npx wrangler workflows describe daily-summary-workflow
npx wrangler workflows instances list daily-summary-workflow
```

特定 instance の step、retry、error を確認する。

```bash
npx wrangler workflows instances describe \
  daily-summary-workflow summary-2026-08-30
```

Worker のリアルタイムログ：

```bash
npx wrangler tail mattermost-automation --format pretty
```

ログには token、Mattermost本文、OpenAI promptを出さない。通常ログは件数、run ID、post ID、statusなどの運用メタデータに限定する。

## Current migration status

- [x] Supabase `reminders` 14件を Turso へ移行し、件数・状態・日付範囲・checksumを照合
- [x] Workers Paid へ変更
- [x] Cloudflare production secrets を設定
- [x] Supabase Cron 5件を停止
- [x] Cloudflare Worker / Workflow / Cron Triggersを本番デプロイ
- [x] 実チャンネルでテキスト・画像投稿と一時本文消去を確認
- [x] Mattermost `/reminder` と `/reminder-mentors` の Request URL を Cloudflareへ変更
- [ ] 2回の日次サイクルでTurso更新、Workflow、Mattermost投稿、重複なしを確認
- [ ] 監視完了後に Supabase Functions / Postgres と旧 deployment secretsを終了
- [x] Supabase Storage と既存 object は維持

## Rollback

1. [wrangler.jsonc](wrangler.jsonc) から本番 Cron Triggers を外してデプロイする。
2. 切替時刻以降に Turso で作成・更新された reminder を Supabase へ逆同期する。
3. Mattermost の2つの Slash Command Request URLを旧Supabase URLへ戻す。
4. Supabase の reminder とテキストサマリー Cron を再有効化する。

```bash
npm run db:rollback-sync -- --since 2026-08-30T13:55:42Z
```

音声 Cron は新構成から意図的に廃止しているため、ロールバック時も明示的な判断なしに再有効化しない。Supabase Functions と Storage は2回の監視サイクルが完了するまで削除しない。

## Repository layout

```text
src/
  index.ts                 Hono routes と scheduled handler
  routes/                  Slash Command / 管理 API
  reminder-cron.ts         リマインダー定期処理
  workflow.ts              Cloudflare Workflow entrypoint
  workflow-runner.ts       日次サマリーの step、retry、fallback
  summary.ts               Mattermost収集とOpenAI生成
  mattermost.ts            Mattermost API client
  db.ts                    Turso repositories
  domain/                  日付、reminder、冪等性の純粋ロジック
migrations/                Turso schema migrations
scripts/                   DB移行・照合・ロールバック
test/                      Vitest tests
supabase/functions/        移行前のDeno Functionsと既存画像asset
docs/                      移行Runbook
```
