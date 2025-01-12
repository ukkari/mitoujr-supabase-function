// supabase/functions/slash-reminder-mentors/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts"
import { corsHeaders } from "../_shared/cors.ts"
import { createPost } from "../_shared/mattermost.ts"

/**
 * Mattermost で `/reminder-mentors 2025/02/27 [contents...]` のように呼ぶ。
 *  1) Mattermost から送られる token が、.env にある MATTERMOST_SLASH_TOKEN と一致するか確認
 *  2) テキストの最初の単語を日付(YYYY/MM/DD)としてパース
 *  3) 残りのコンテンツをまとめて DB の content に保存
 *  4) 新規ポストを作成し、その post_id, channel_id, due_date, content を reminders に upsert
 */

const MATTERMOST_SLASH_TOKEN = Deno.env.get("MATTERMOST_SLASH_TOKEN") ?? ""

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
