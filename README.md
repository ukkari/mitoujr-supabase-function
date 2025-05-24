# supabase-function

## デプロイ方法

Update secrets
```bash
npx supabase secrets set --env-file ./supabase/functions/.env
```

Deploy function
```bash
supabase functions deploy today-channels-summary
```

## 使用方法

### テキストサマリー（デフォルト）

```bash
# 昨日のサマリーを生成
curl "https://your-project.supabase.co/functions/v1/today-channels-summary"

# 今日のサマリーを生成  
curl "https://your-project.supabase.co/functions/v1/today-channels-summary?forToday=true"

# デバッグモード（Mattermostに投稿せずに結果を確認）
curl "https://your-project.supabase.co/functions/v1/today-channels-summary?debug=true"

# typeパラメータを明示的に指定（デフォルトと同じ）
curl "https://your-project.supabase.co/functions/v1/today-channels-summary?type=text"
```

### 音声サマリー

```bash
# 昨日のサマリーを音声で生成
curl "https://your-project.supabase.co/functions/v1/today-channels-summary?type=audio"

# 今日のサマリーを音声で生成
curl "https://your-project.supabase.co/functions/v1/today-channels-summary?type=audio&forToday=true"

# 音声サマリーのデバッグモード
curl "https://your-project.supabase.co/functions/v1/today-channels-summary?type=audio&debug=true"
```

## パラメータ

- `type`: `text` (デフォルト) または `audio`
  - `text`: テキストサマリーを生成してMattermostに投稿
  - `audio`: 音声サマリーを生成してWAVファイルをMattermostに投稿
- `forToday`: `true` の場合は今日のサマリー、`false`（デフォルト）の場合は昨日のサマリー
- `debug`: `true` の場合はMattermostに投稿せずに結果のみ返す

## レスポンス例

### テキストモード
```json
{
  "message": "Posted 昨日's channel summary.",
  "summary": "ずんだもんなのだ！昨日のMattermost投稿について..."
}
```

### 音声モード
```json
{
  "message": "Posted 昨日's channel audio summary.",
  "audioUrl": "https://storage.googleapis.com/project-id-tts-output/job-id.wav"
}
```

### デバッグモード
```json
{
  "message": "Debug mode: Generated summary without posting",
  "summary": "...",
  "logs": ["Debug log messages..."]
}
```
　