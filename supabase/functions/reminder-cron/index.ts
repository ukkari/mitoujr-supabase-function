// supabase/functions/reminder-cron/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts"
import { corsHeaders } from "../_shared/cors.ts"
import { getMentors, getReactions, postReply } from "../_shared/mattermost.ts"

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(JSON.stringify({ message: 'ok' }), { headers: corsHeaders() })
  }

  try {
    // 「completed = false or null」のみ対象にする (全員完了していないものだけ)
    const { data: reminders, error } = await supabaseAdmin
      .from('reminders')
      .select('*')
      .or('completed.is.null,completed.eq.false') // completed が NULL or false のもの
    if (error || !reminders) {
      console.error(error)
      return new Response(
        JSON.stringify({ error: error?.message }),
        { headers: corsHeaders(), status: 500 }
      )
    }

    // 今日の日付 (JST想定) を取得
    const now = new Date()

    // 期限前に特別リマインドする日数
    const remindDays = [7, 5, 3, 2, 1]

    // メンター一覧を一度だけ取得
    const mentors = await getMentors()

    for (const r of reminders) {
      const { post_id: postId, channel_id: channelId, due_date: dueDateStr } = r
      // 期限日
      const dueDate = new Date(dueDateStr)
      // 残り日数 (当日=0, 過去なら負値)
      const diff = dueDate.getTime() - now.getTime()
      const diffDays = Math.ceil(diff / (1000 * 60 * 60 * 24))

      // まず "done" リアクションのついている user_id を取得
      let reactions = await getReactions(postId)
      // null や undefined なら空配列にする => エラー回避
      if (!reactions) {
        reactions = []
      }

      const doneUserIds = reactions
        .filter((r: any) => r.emoji_name === 'done')
        .map((r: any) => r.user_id)

      // missing (まだ"done"を付けていないメンター)
      const missing = mentors.filter(m => !doneUserIds.includes(m.id))

      // 全員が完了なら completed = true に更新して、これ以上リマインド不要
      if (missing.length === 0) {
        // DB更新
        const { error: compError } = await supabaseAdmin
          .from('reminders')
          .update({ completed: true })
          .eq('post_id', postId)
        if (compError) {
          console.error('Error updating completed:', compError)
        }
        // 次の reminder には進まず continue
        continue
      }

      // ここから先は "まだ完了していない人がいる" 場合
      // リマインドを送る条件:
      //  1) diffDays が remindDays (7,5,3,2,1) に含まれる、または
      //  2) diffDays <= 0 (期限当日 & 期限切れ後) => 毎日リマインド
      //
      // 期限後も引き続き毎日リマインドするには: diffDays <= 0 の時に送る
      const shouldRemind =
        remindDays.includes(diffDays) || diffDays <= 0

      if (shouldRemind) {
        // missing メンターを mention してリマインド
        const mentionText = missing.map(m => `@${m.username}`).join(' ')
        // diffDays <= 0 の場合は期限を過ぎている
        if (diffDays < 0) {
          const overdueDays = Math.abs(diffDays) // 期限から何日経過
          const replyMessage = `締切日 (${dueDateStr}) を${overdueDays}日過ぎています。まだ "done" がついていないメンター: ${mentionText}`
          await postReply(channelId, postId, replyMessage)
        } else if (diffDays === 0) {
          // 期限当日
          const replyMessage = `今日は締切日 (${dueDateStr}) です！まだ "done" がついていないメンター: ${mentionText}`
          await postReply(channelId, postId, replyMessage)
        } else {
          // 事前リマインド (7,5,3,2,1日前)
          const replyMessage = `締切日 (${dueDateStr}) まであと ${diffDays}日です！まだ "done" がついていないメンター: ${mentionText}`
          await postReply(channelId, postId, replyMessage)
        }
      }
    }

    return new Response(JSON.stringify({ message: 'Reminder check completed.' }), {
      headers: corsHeaders(),
      status: 200
    })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), {
      headers: corsHeaders(),
      status: 500
    })
  }
})
