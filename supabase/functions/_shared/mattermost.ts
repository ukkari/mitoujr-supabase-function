// supabase/functions/_shared/mattermost.ts

// 例: Bot Token (パーソナルアクセストークンやBotアクセストークン)
// またはIncoming WebhookのURLを使う場合は下記のように環境変数として設定
const MATTERMOST_TOKEN = Deno.env.get('MATTERMOST_BOT_TOKEN') ?? ''
const MATTERMOST_HOST = Deno.env.get("MATTERMOST_URL") ?? ""

// メンターグループ: r3a1ho64b7ghfdogr3xyrw9gya

const MENTOR_GROUP_ID = 'r3a1ho64b7ghfdogr3xyrw9gya'
//const MENTOR_GROUP_ID = '3eia1uggojy4pf64nf9apcr6rr'

// Mattermost API (token 認証) でメンター一覧を取得する関数
export async function getMentors(): Promise<{id: string; username: string}[]> {
  const url = `${MATTERMOST_HOST}/api/v4/users?in_group=${MENTOR_GROUP_ID}&per_page=200`
  
  const res = await fetch(url, {
    headers: { 
      'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
      'Accept': 'application/json'
    }
  })
  if (!res.ok) {
    console.error('Failed to fetch mentors:', await res.text())
    return []
  }
  const data = await res.json()
  // 必要なフィールドだけ抜き出す
  return data.map((u: any) => ({
    id: u.id,
    username: u.username
  }))
}

// 指定した postId の reaction 情報を取得する
// reaction には user_id や emoji_name などが含まれる
export async function getReactions(postId: string): Promise<any[]> {
  const url = `${MATTERMOST_HOST}/api/v4/posts/${postId}/reactions`
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
      'Accept': 'application/json'
    }
  })
  if (!res.ok) {
    console.error('Failed to fetch reactions:', await res.text())
    return []
  }
  return await res.json() // [ { user_id, post_id, emoji_name, create_at }, ... ]
}

// スレッドへの返信を投稿する: 
// - 引数の `rootId` はスレッド元ポストID
// - channelId は投稿先チャンネルID
// - message は本文(mention含む)
export async function postReply(channelId: string, rootId: string, message: string) {
  const url = `${MATTERMOST_HOST}/api/v4/posts`
  const body = {
    channel_id: channelId,
    message,
    root_id: rootId,  // スレッドに紐づく
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    console.error('Failed to post reply:', await res.text())
    return null
  }
  return await res.json()
}

/**
 * 新しいポストをチャンネルに投稿する
 * @param channelId 
 * @param message 
 * @returns 
 */
export async function createPost(channelId: string, message: string) {
    const url = `${MATTERMOST_HOST}/api/v4/posts`
    const body = {
      channel_id: channelId,
      message,
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
  
    if (!res.ok) {
      console.error('Failed to create post:', await res.text())
      return null
    }
    return await res.json() // { id, channel_id, message, ... }
  }