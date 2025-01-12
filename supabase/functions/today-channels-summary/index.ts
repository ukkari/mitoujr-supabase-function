// supabase/functions/today-channels-summary/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

/** 環境変数 */
const MATTERMOST_URL = Deno.env.get("MATTERMOST_URL") ?? "https://mattermost.jr.mitou.org"
const MATTERMOST_BOT_TOKEN = Deno.env.get("MATTERMOST_BOT_TOKEN") ?? ""
const MATTERMOST_MAIN_TEAM = Deno.env.get("MATTERMOST_MAIN_TEAM") ?? ""

/**
 * このEdge Functionが呼ばれたら以下を行う:
 *  1. メインチーム内のチャンネル一覧(パブリック)を取得
 *  2. 今日(午前0時以降)更新があったチャンネルだけ抽出
 *  3. 該当チャンネルの「今日の投稿」を取得
 *  4. まとめて "/summary" の文言付きで Mattermostにポスト
 *
 * 実行は例えば Supabase の Scheduler で1日1回夕方に呼び出す等を想定
 */
serve(async (req) => {
  try {
    // CORS対応 (必要なら)
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204 })
    }

    // （1） チャンネル一覧を取得
    const channels = await fetchPublicChannels(MATTERMOST_MAIN_TEAM)
    if (!channels) {
      return new Response(JSON.stringify({ error: "Failed to fetch channels" }), { status: 500 })
    }

    // 今日の開始時刻(0:00)を取得 (UTC か JST かは要件に応じて調整)
    // ここではサーバーがUTCの場合、now は UTC時間。  
    // 「本日0時に相当するUTC時刻」を使いたい場合などは要検討。
    // 便宜上、シンプルに "ローカル日付の 0時" として:
    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime()

    // （2） "今日更新があった" = channel.last_post_at >= startOfDay
    const updatedToday = channels.filter(ch => ch.type === 'O' && ch.last_post_at >= startOfDay)

    // （3） チャンネルごとに「今日のポスト」を取得し、整形
    let summaryLines: string[] = []
    for (const ch of updatedToday) {
      // channel_id
      const cid = ch.id
      // このチャンネルの "今日のポスト" 一覧を取得
      const todaysPosts = await fetchTodaysPosts(cid, startOfDay)
      if (todaysPosts.length === 0) {
        // ポストが0件ならスキップ
        continue
      }

      // チャンネル見出し
      summaryLines.push(`### # ${ch.display_name}`)

      // 各ポストを少しだけまとめる
      // （例: メッセージの先頭100文字程度 or 全文）
      for (const p of todaysPosts) {
        // 改行などが長い場合には適宜 truncate する
        const msgSnippet = p.message.length > 100
          ? p.message.substring(0, 100) + "..."
          : p.message
        // 時刻表示などを追加しても良い
        // epoch => Date
        const postTime = new Date(p.create_at).toLocaleString()
        summaryLines.push(`- (${postTime}) ${msgSnippet}`)
      }
      summaryLines.push("") // 改行
    }

    if (summaryLines.length === 0) {
      // 今日更新があったチャンネルが無い or 取得できない場合
      // → "更新なし" としてポストする例
      const noneMessage = "今日は更新があったパブリックチャンネルはありません。"
      await postToMattermost(noneMessage)
      return new Response(JSON.stringify({ message: "No updates today." }), { status: 200 })
    }

    // （4） まとめてポスト "/summary\n## 今日更新があったチャンネルの一覧"
    const finalMessage = [
      "## 今日更新があったチャンネル",
      ...summaryLines
    ].join("\n")

    await postToMattermost(finalMessage)

    return new Response(
      JSON.stringify({ message: "Posted today's channel summary." }),
      { status: 200 }
    )

  } catch (err) {
    console.error("today-channels-summary error:", err)
    return new Response(JSON.stringify({ error: err?.message }), { status: 500 })
  }
})

/** Mattermost API (GET) でパブリックチャンネル一覧を取得 */
async function fetchPublicChannels(teamId: string): Promise<any[] | null> {
  try {
    // per_pageなど必要に応じて設定
    const url = `${MATTERMOST_URL}/api/v4/teams/${teamId}/channels?per_page=200`
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${MATTERMOST_BOT_TOKEN}`,
        'Accept': 'application/json',
      }
    })
    if (!res.ok) {
      console.error("[fetchPublicChannels] failed", await res.text())
      return null
    }
    const data = await res.json()
    // data: Channel[] の配列
    return data
  } catch (err) {
    console.error("[fetchPublicChannels] error:", err)
    return null
  }
}

/**
 * 指定したchannel_idから /api/v4/channels/{channel_id}/posts を取得し、
 *  create_at >= startOfDay のものだけを返す。
 */
async function fetchTodaysPosts(channelId: string, startOfDay: number): Promise<any[]> {
  try {
    // per_page=200 などで何ページか取得する必要があるかもしれません (大量にポストがある場合)
    // ここでは簡易的に1回だけ取得
    const url = `${MATTERMOST_URL}/api/v4/channels/${channelId}/posts?per_page=200`
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${MATTERMOST_BOT_TOKEN}`,
        'Accept': 'application/json',
      }
    })
    if (!res.ok) {
      console.error("[fetchTodaysPosts] failed", await res.text())
      return []
    }
    // 例: { order: string[], posts: {...}, next_post_id, prev_post_id, ... }
    const data = await res.json()
    if (!data.posts) {
      return []
    }

    // data.posts はオブジェクト形式: { postId1: Post, postId2: Post, ... }
    // data.order は postId の並び
    const postIds: string[] = data.order || []
    const postsObj = data.posts

    // 取り出して "create_at >= startOfDay" のものをフィルタ
    const result: any[] = []
    for (const pid of postIds) {
      const p = postsObj[pid]
      if (p && p.create_at >= startOfDay) {
        result.push(p)
      }
    }

    // Mattermostは新しい投稿が先頭のことが多いが、
    // デフォルトだと order は 新→古 の順かもしれない。
    // 表示時に 古い順 にしたい場合は sort する:
    result.sort((a, b) => a.create_at - b.create_at)

    return result
  } catch (err) {
    console.error("[fetchTodaysPosts] error:", err)
    return []
  }
}

/**
 * Mattermost に投稿する (送信先チャンネルIDは任意に決める)
 * 例: MATTERMOST_SUMMARY_CHANNEL が指定されていればそこへ投稿
 */
async function postToMattermost(message: string): Promise<void> {
  const channelId = Deno.env.get("MATTERMOST_SUMMARY_CHANNEL") ?? ""
  if (!channelId) {
    console.warn("MATTERMOST_SUMMARY_CHANNEL is not set. Skipping post.")
    return
  }

  const url = `${MATTERMOST_URL}/api/v4/posts`
  const body = {
    channel_id: channelId,
    message
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MATTERMOST_BOT_TOKEN}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const errText = await res.text()
    console.error("[postToMattermost] failed", errText)
    throw new Error(`Failed to post summary: ${errText}`)
  }
}
