// supabase/functions/reminder-cron/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts"
import { corsHeaders } from "../_shared/cors.ts"
import { getMentors, getPost, getReactions, getThreadPostIds, getUsersByUsernames, postReply } from "../_shared/mattermost.ts"

type ParsedReminderContent = {
  body: string | null
  targetUsernames: string[] | null
}

function parseReminderContent(raw: unknown): ParsedReminderContent {
  if (typeof raw !== 'string') {
    return { body: null, targetUsernames: null }
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const body = typeof parsed.body === 'string' ? parsed.body : raw
      const targetUsernames = Array.isArray(parsed.target_usernames)
        ? parsed.target_usernames.map((u: string) => u.toString())
        : null
      return { body, targetUsernames }
    }
  } catch {
    // fallback to plain text content
  }
  return { body: raw, targetUsernames: null }
}

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
      const { post: rootPost, notFound } = await getPost(postId)
      const isDeleted = notFound || (typeof rootPost?.delete_at === 'number' && rootPost.delete_at > 0)
      if (isDeleted) {
        const { error: compError } = await supabaseAdmin
          .from('reminders')
          .update({ completed: true })
          .eq('post_id', postId)
        if (compError) {
          console.error('Error updating completed for deleted post:', compError)
        }
        continue
      }
      if (!rootPost) {
        console.error('Failed to fetch root post. Skipping reminder:', postId)
        continue
      }
      // 期限日
      const dueDate = new Date(dueDateStr)
      // 残り日数 (当日=0, 過去なら負値)
      const diff = dueDate.getTime() - now.getTime()
      const diffDays = Math.ceil(diff / (1000 * 60 * 60 * 24))

      // スレッド内 (root + replies) の "done" リアクションを集計
      const threadPostIds = await getThreadPostIds(postId)
      const doneUserIdsSet = new Set<string>()
      for (const pid of threadPostIds) {
        let reactions = await getReactions(pid)
        if (!reactions) {
          reactions = []
        }
        for (const r of reactions) {
          if (r.emoji_name === 'done') {
            doneUserIdsSet.add(r.user_id)
          }
        }
      }
      const doneUserIds = Array.from(doneUserIdsSet)

      const { targetUsernames } = parseReminderContent(r?.content)
      const normalizedTargets = Array.isArray(r?.target_usernames)
        ? r.target_usernames.map((u: string) => u.toString())
        : targetUsernames

      let missingMentions: string[] = []
      let hasPending = false

      if (normalizedTargets && normalizedTargets.length > 0) {
        const targetUsers = await getUsersByUsernames(normalizedTargets)
        const foundNameSet = new Set(targetUsers.map((u) => u.username))
        const cleanedTargets = Array.from(new Set(
          normalizedTargets.map((u) => u.replace(/^@/, '').trim()).filter((u) => u.length > 0)
        ))
        const unknownUsernames = cleanedTargets.filter((u) => !foundNameSet.has(u))
        const missingTargets = targetUsers.filter((u) => !doneUserIdsSet.has(u.id))
        hasPending = missingTargets.length > 0 || unknownUsernames.length > 0
        missingMentions = [
          ...missingTargets.map((u) => `@${u.username}`),
          ...unknownUsernames.map((u) => `@${u}`)
        ]
      } else {
        // missing (まだ"done"を付けていないメンター)
        const missing = mentors.filter(m => !doneUserIds.includes(m.id))
        hasPending = missing.length > 0
        missingMentions = missing.map((m) => `@${m.username}`)
      }

      // 全員が完了なら completed = true に更新して、これ以上リマインド不要
      if (!hasPending) {
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
        // missing 対象者を mention してリマインド
        const mentionText = missingMentions.join(' ')
        // diffDays <= 0 の場合は期限を過ぎている
        if (diffDays < 0) {
          const overdueDays = Math.abs(diffDays) // 期限から何日経過
          const replyMessage = `締切日 (${dueDateStr}) を${overdueDays}日過ぎています。まだ "done" がついていない対象者: ${mentionText}`
          await postReply(channelId, postId, replyMessage)
        } else if (diffDays === 0) {
          // 期限当日
          const replyMessage = `今日は締切日 (${dueDateStr}) です！まだ "done" がついていない対象者: ${mentionText}`
          await postReply(channelId, postId, replyMessage)
        } else {
          // 事前リマインド (7,5,3,2,1日前)
          const replyMessage = `締切日 (${dueDateStr}) まであと ${diffDays}日です！まだ "done" がついていない対象者: ${mentionText}`
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
