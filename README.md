# Mattermost automation on Cloudflare Workers

Mattermost のリマインダーと日次サマリーを、Cloudflare Workers / Cron Triggers / Workflows と Turso で実行する。Supabase Functions と Postgres は移行後に停止し、Supabase Storage は既存音声リンクの読み取り用途だけに残す。新しい音声生成・Storage アップロードは行わない。

## Runtime

- `POST /slash-reminder`: `/reminder` 互換の form-urlencoded Slash Command
- `POST /slash-reminder-mentors`: `/reminder-mentors` 互換の Slash Command
- `POST /admin/daily-summary`: 認証済みの手動 Workflow 起動
- `GET /admin/daily-summary/:runId`: 認証済みの Workflow 状態確認
- `0 15 * * *`: 毎日 00:00 JST のリマインダー
- `0 22 * * *`: 毎日 07:00 JST の前日サマリー

Cron 用の外部 HTTP Route は存在しない。日次サマリーの Workflow ID は `summary-YYYY-MM-DD` で、対象 JST 日ごとに一意になる。

## Setup

Node.js 24 で依存関係を入れ、Cloudflare と Turso にログインする。

```bash
npm ci
npx wrangler login
turso auth login
```

秘密値はコミットせず、ローカルでは 1Password から `.dev.vars` をマウントする。必要なキーは [.dev.vars.example](.dev.vars.example) に列挙している。本番と staging には `wrangler secret put` で同じキーを設定する。`OPENAI_TEXT_MODEL`、`OPENAI_IMAGE_MODEL`、`DRY_RUN` は `wrangler.jsonc` の通常変数である。

日次収集は Mattermost API の subrequest 数が Free plan 上限を超えるため、本番切替前に Workers Paid plan が必要。Workflow step の出力にはMattermost本文を含めず、一時本文は Turso の `summary_runs` / `summary_run_fragments` に最大48時間だけ保持し、成功時に即時消去する。

## Local verification

```bash
npm run typecheck
npm test
npm run deploy:dry-run
npm run dev
```

ローカルの `debug=true` Route は設けていない。投稿抑止は staging の `DRY_RUN=true` で行う。ログには token や Mattermost 本文を出さない。

## Turso schema and data migration

`mattermost-automation` DB を既存の `default` group に作る。

```bash
turso db create mattermost-automation --group default
turso db show mattermost-automation --url
turso db tokens create mattermost-automation
```

URL と token を環境に渡し、migration を適用する。migration は再適用可能である。

```bash
npm run db:migrate
npm run db:migrate
```

Supabase の全 reminders を変更せずにエクスポートし、Turso に取り込んで照合する。

```bash
npm run db:export-supabase
npm run db:import
npm run db:verify
```

`db:verify` は総件数、completed 別件数、締切日の最小・最大、正規化行の SHA-256 checksum を比較する。移行ファイルは `.migration-data/` に mode `0600` で保存され、Git 対象外である。

## Admin API

`Authorization: Bearer <ADMIN_TRIGGER_SECRET>` が必須。

```bash
curl -X POST "https://<worker>/admin/daily-summary" \
  -H "Authorization: Bearer $ADMIN_TRIGGER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"target":"yesterday"}'

curl "https://<worker>/admin/daily-summary/summary-2026-08-29" \
  -H "Authorization: Bearer $ADMIN_TRIGGER_SECRET"
```

`target` は `yesterday` または `today`。開始は `202`、同じ対象日の実行中または完了済み Workflow は `409`。失敗・停止済みだけ再開できる。`type`、特に旧 `type=audio` は `400` で拒否する。

## Deployment and cutover

まず staging をデプロイし、実投稿なしで現行処理と対象を比較する。

```bash
npm run deploy:staging
```

本番切替は次の順番を崩さない。

1. Supabase Scheduler を停止する。
2. Supabase から最終差分を再エクスポートし、Turso へ import / verify する。
3. `npm run deploy` で本番 Worker、Workflows、Cron Triggers をデプロイする。
4. Mattermost の Slash Command URL を Workers URL の2つの POST Routeへ変更する。
5. 2回の日次サイクルで Turso、Workflow、Mattermost 投稿、重複の有無を確認する。
6. 問題がなければ Supabase Functions / Postgres と旧 GitHub secrets を終了する。Storage と既存オブジェクトは削除しない。

GitHub Actions は PR で型・テスト・空DB migration再適用・Wrangler dry-runを検証し、`main` への push で `wrangler deploy` を行う。Repository/Environment secrets には `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` が必要。

## Rollback

Cloudflare Cron を無効化し、切替時刻を指定して Turso で作成・更新された reminder だけを Supabase へ逆同期してから、Mattermost の旧 Slash Command URL と Supabase Scheduler を戻す。

```bash
npm run db:rollback-sync -- --since 2026-08-30T12:00:00Z
```

Supabase Functions と Storage は2回の監視サイクルが終わるまで削除しない。
