// supabase/functions/slash-reminder-mentors/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts"
import { corsHeaders } from "../_shared/cors.ts"
import { createPost, getPost, postReply, updatePost } from "../_shared/mattermost.ts"

/**
 * Mattermost で `/reminder-mentors 2025/02/27 [contents...]` のように呼ぶ。
 *  1) Mattermost から送られる token が、.env にある MATTERMOST_SLASH_TOKEN と一致するか確認
 *  2) テキストの最初の単語を日付(YYYY/MM/DD)としてパース
 *  3) 残りのコンテンツをまとめて DB の content に保存
 *  4) 新規ポストを作成し、その post_id, channel_id, due_date, content を reminders に upsert
 */

const MATTERMOST_SLASH_TOKEN = Deno.env.get("MATTERMOST_SLASH_TOKEN") ?? ""

const POST_ID_REGEX = /^[A-Za-z0-9]{26}$/
const POST_LINK_REGEX = /\/pl\/([A-Za-z0-9]{26})/

function extractPostIdFromText(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const linkMatch = trimmed.match(POST_LINK_REGEX)
  if (linkMatch?.[1]) return linkMatch[1]

  const firstToken = trimmed.split(/\s+/)[0]?.replace(/[<>]/g, "") ?? ""
  if (POST_ID_REGEX.test(firstToken)) return firstToken

  return null
}

async function stopReminder(initialPostId: string, fallbackChannelId: string) {
  // まずは stop ID (= root の post_id) で直接検索する
  const { data: directReminder, error: directSelectError } = await supabaseAdmin
    .from("reminders")
    .select("post_id, channel_id, completed")
    .eq("post_id", initialPostId)
    .maybeSingle()

  if (directSelectError) {
    console.error("Failed to select reminder by stop id:", directSelectError)
    return { status: 500, text: directSelectError.message }
  }

  let rootId = directReminder?.post_id ?? ""
  let replyChannelId = directReminder?.channel_id ?? fallbackChannelId
  let alreadyCompleted = directReminder?.completed === true

  // 見つからない場合のみ、post を辿って root を特定する
  if (!directReminder) {
    const { post, notFound } = await getPost(initialPostId)
    if (notFound || !post) {
      return { status: 200, text: "指定されたポストが見つかりませんでした。" }
    }
    rootId = post.root_id && post.root_id.length > 0 ? post.root_id : post.id
    replyChannelId = post.channel_id || fallbackChannelId

    const { data: reminder, error: selectError } = await supabaseAdmin
      .from("reminders")
      .select("post_id, channel_id, completed")
      .eq("post_id", rootId)
      .maybeSingle()

    if (selectError) {
      console.error("Failed to select reminder via root:", selectError)
      return { status: 500, text: selectError.message }
    }

    if (!reminder) {
      return { status: 200, text: "reminders テーブルに対象が見つかりませんでした。" }
    }

    alreadyCompleted = reminder.completed === true
  }

  if (!rootId) {
    return { status: 200, text: "停止対象の post_id が特定できませんでした。" }
  }

  const { error: updateError } = await supabaseAdmin
    .from("reminders")
    .update({
      completed: true,
      updated_at: new Date().toISOString(),
    })
    .eq("post_id", rootId)

  if (updateError) {
    console.error("Failed to stop reminder:", updateError)
    return { status: 500, text: updateError.message }
  }

  if (replyChannelId) {
    const stopMessage = alreadyCompleted
      ? "このリマインドは既に停止済み（completed=true）です。"
      : "このリマインドは /reminder-mentors stop により停止されました。"
    await postReply(replyChannelId, rootId, stopMessage)
  }

  const responseText = alreadyCompleted
    ? "このリマインドは既に停止済みです。"
    : "リマインドを停止しました（completed=true）。"

  return { status: 200, text: responseText }
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

    // text = "2025/02/27 ここから先が本文\n改行あり..."
    const text = body.get('text')?.toString() || ''
    const channelId = body.get('channel_id')?.toString() || ''
    if (!text || !channelId) {
      return new Response(
        JSON.stringify({ error: 'Missing text or channel_id' }),
        { headers: corsHeaders(), status: 400 }
      )
    }

    const trimmedText = text.trim()
    const firstToken = trimmedText.split(/\s+/)[0]?.toLowerCase() ?? ''

    // stop モード: /reminder-mentors stop <post_id|post_link>
    if (firstToken === 'stop') {
      const stopArgs = trimmedText.slice(firstToken.length).trim()
      const postId = extractPostIdFromText(stopArgs)
      if (!postId) {
        const usage = "Usage: /reminder-mentors stop <post_id|post_link>"
        return new Response(JSON.stringify({
          text: `停止対象の post_id が特定できませんでした。\n${usage}`
        }), {
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
          status: 200
        })
      }

      const result = await stopReminder(postId, channelId)
      return new Response(JSON.stringify({ text: result.text }), {
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        status: result.status
      })
    }

    // 先頭の単語(YYYY/MM/DD)を抜き出し、残りを contents として保持
    // 改行等ふくめて2つ目以降をすべて contents に入れる
    const matched = text.match(/^(\S+)\s([\s\S]+)/)
    if (!matched) {
      const usage = "Usage: /reminder-mentors YYYY/MM/DD contents..."
      return new Response(
        JSON.stringify({ text: `Invalid format.\n${usage}` }),
        { headers: corsHeaders(), status: 200 }
      )
    }

    const dateStr = matched[1] // "2025/02/27"
    let contents = matched[2]  // "ここから先が本文\n改行あり..."
    if (!contents) {
      contents = ""
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

    // 新規ポストをチャンネルに作成 (本文には締切日とcontentsを含める)
    const postMessage = `新しいメンター向けのタスクが作られました。自動でリマインダされます。\n**締切日:** ${dateStr}\n${contents}`
    const newPost = await createPost(channelId, postMessage)
    if (!newPost || !newPost.id) {
      return new Response(
        JSON.stringify({ text: "Failed to create post in Mattermost" }),
        { headers: corsHeaders(), status: 500 }
      )
    }
    const postId = newPost.id

    // 停止用の ID をポスト本文に埋め込む（post_id をそのまま stop ID とする）
    const stopHelpLine = `停止するには: \`/reminder-mentors stop ${postId}\``
    const postMessageWithStop = `${postMessage}\n\n---\n${stopHelpLine}`
    const updatedPost = await updatePost(postId, channelId, postMessageWithStop)
    if (!updatedPost) {
      console.error("Failed to append stop id to post:", postId)
    }

    // ★ [2] remindersテーブルに content フィールドを保存
    const { error: upsertError } = await supabaseAdmin
      .from('reminders')
      .upsert({
        post_id: postId,
        channel_id: channelId,
        due_date: finalDueStr,
        content: contents,            // ここで保存
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
    const successMsg = `リマインド用ポストを作成しました。\n締切日: ${dateStr}`
    return new Response(JSON.stringify({ text: successMsg }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      status: 200
    })
  } catch (err) {
    console.error('slash-reminder-mentors error:', err)
    return new Response(
      JSON.stringify({ text: err.message }),
      { headers: corsHeaders(), status: 500 }
    )
  }
})
