// supabase/functions/slash-reminder/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts"
import { corsHeaders } from "../_shared/cors.ts"
import {
  createPost,
  getUserByUsername,
  getUserGroupByName,
  getUserGroupMemberIds,
  getUsersByIds,
} from "../_shared/mattermost.ts"

/**
 * Mattermost で `/reminder 2025/02/27 @user1 @user2 [contents...]` のように呼ぶ。
 *  1) Mattermost から送られる token が、.env にある MATTERMOST_SLASH_TOKEN と一致するか確認
 *  2) 先頭の単語を日付(YYYY/MM/DD)としてパース
 *  3) 次の @username 群を対象者として抽出
 *  4) 残りのコンテンツをまとめて DB の content に保存
 */

const MATTERMOST_SLASH_TOKEN =
  Deno.env.get("MATTERMOST_SLASH_REMINDER_TOKEN") ?? ""

async function expandMentions(rawMentions: string[]): Promise<string[]> {
  const result: string[] = []
  const seen = new Set<string>()

  const addUsername = (username: string) => {
    const normalized = username.replace(/^@/, "").trim()
    if (!normalized || seen.has(normalized)) {
      return
    }
    seen.add(normalized)
    result.push(normalized)
  }

  for (const mention of rawMentions) {
    const normalized = mention.replace(/^@/, "").trim()
    if (!normalized) {
      continue
    }
    const user = await getUserByUsername(normalized)
    if (user) {
      addUsername(user.username)
      continue
    }
    const group = await getUserGroupByName(normalized)
    if (group) {
      const memberIds = await getUserGroupMemberIds(group.id)
      const members = await getUsersByIds(memberIds)
      for (const member of members) {
        addUsername(member.username)
      }
      continue
    }
    // user/group として見つからない場合はそのまま扱う
    addUsername(normalized)
  }

  return result
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(JSON.stringify({ message: 'ok' }), { headers: corsHeaders() })
  }

  try {
    // Mattermost Slash Command は form-urlencoded or multipart/form-data
    const body = await req.formData()

    // ★ [1] スラッシュコマンドから送信された token と .env の MATTERMOST_SLASH_TOKEN を比較
    const token = body.get('token')?.toString() || ''
    if (token !== MATTERMOST_SLASH_TOKEN) {
      return new Response(
        JSON.stringify({ text: 'Invalid slash command token' }),
        { headers: corsHeaders(), status: 403 }
      )
    }

    // text = "2025/02/27 @user1 @user2 ここから先が本文\n改行あり..."
    const text = body.get('text')?.toString() || ''
    const channelId = body.get('channel_id')?.toString() || ''
    if (!text || !channelId) {
      return new Response(
        JSON.stringify({ error: 'Missing text or channel_id' }),
        { headers: corsHeaders(), status: 400 }
      )
    }

    // 先頭の単語(YYYY/MM/DD)を抜き出し、残りを rest として保持
    const firstMatched = text.match(/^(\S+)\s+([\s\S]+)/)
    if (!firstMatched) {
      const usage = "Usage: /reminder YYYY/MM/DD @user1 @user2 contents..."
      return new Response(
        JSON.stringify({ text: `Invalid format.\n${usage}` }),
        { headers: corsHeaders(), status: 200 }
      )
    }

    const dateStr = firstMatched[1] // "2025/02/27"
    const rest = firstMatched[2]    // "@user1 @user2 ここから先が本文..."

    // 先頭の @username 群を抽出 (1つ以上必須)
    const mentionMatched = rest.match(/^((?:@\S+\s+)+)([\s\S]*)$/)
    if (!mentionMatched) {
      const usage = "Usage: /reminder YYYY/MM/DD @user1 @user2 contents..."
      return new Response(
        JSON.stringify({ text: `Invalid format.\n${usage}` }),
        { headers: corsHeaders(), status: 200 }
      )
    }

    const mentionPart = mentionMatched[1]
    let contents = mentionMatched[2] ?? ""

    const rawMentions = mentionPart.trim().split(/\s+/)
    const targetUsernames = await expandMentions(rawMentions)

    if (targetUsernames.length === 0) {
      const usage = "Usage: /reminder YYYY/MM/DD @user1 @user2 contents..."
      return new Response(
        JSON.stringify({ text: `Invalid format.\n${usage}` }),
        { headers: corsHeaders(), status: 200 }
      )
    }

    contents = contents.trimStart()
    if (!contents) {
      const usage = "Usage: /reminder YYYY/MM/DD @user1 @user2 contents..."
      return new Response(
        JSON.stringify({ text: `Invalid format.\n${usage}` }),
        { headers: corsHeaders(), status: 200 }
      )
    }

    // YYYY/MM/DD -> YYYY-MM-DD に変換
    const isoLike = dateStr.replace(/\//g, '-')
    const dueDate = new Date(isoLike)
    if (isNaN(dueDate.getTime())) {
      return new Response(
        JSON.stringify({ text: "Invalid date format. Use YYYY/MM/DD" }),
        { headers: corsHeaders(), status: 200 }
      )
    }
    const yyyy = dueDate.getFullYear()
    const mm = String(dueDate.getMonth() + 1).padStart(2, '0')
    const dd = String(dueDate.getDate()).padStart(2, '0')
    const finalDueStr = `${yyyy}-${mm}-${dd}`

    // 新規ポストをチャンネルに作成 (本文には対象ユーザーと締切日とcontentsを含める)
    const mentionText = targetUsernames.map((u) => `@${u}`).join(' ')
    const postMessage = `リマインド対象のタスクが作られました。自動でリマインダされます。\n**対象:** ${mentionText}\n**締切日:** ${dateStr}\n完了したらこのポストに :done: リアクションを付けてください。\n${contents}`
    const newPost = await createPost(channelId, postMessage)
    if (!newPost || !newPost.id) {
      return new Response(
        JSON.stringify({ text: "Failed to create post in Mattermost" }),
        { headers: corsHeaders(), status: 500 }
      )
    }
    const postId = newPost.id

    const contentPayload = JSON.stringify({
      body: contents,
      target_usernames: targetUsernames
    })

    // remindersテーブルに content フィールドを保存
    const { error: upsertError } = await supabaseAdmin
      .from('reminders')
      .upsert({
        post_id: postId,
        channel_id: channelId,
        due_date: finalDueStr,
        content: contentPayload,
        updated_at: new Date().toISOString()
      })
    if (upsertError) {
      console.error('upsertError:', upsertError)
      return new Response(
        JSON.stringify({ text: upsertError.message }),
        { headers: corsHeaders(), status: 500 }
      )
    }

    // slash command のレスポンス(エフェメラル)
    const successMsg = `リマインド用ポストを作成しました。\n対象: ${mentionText}\n締切日: ${dateStr}`
    return new Response(JSON.stringify({ text: successMsg }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      status: 200
    })
  } catch (err) {
    console.error('slash-reminder error:', err)
    return new Response(
      JSON.stringify({ text: err.message }),
      { headers: corsHeaders(), status: 500 }
    )
  }
})
