// supabase/functions/_shared/mattermost.ts

// 例: Bot Token (パーソナルアクセストークンやBotアクセストークン)
// またはIncoming WebhookのURLを使う場合は下記のように環境変数として設定
const MATTERMOST_TOKEN = Deno.env.get('MATTERMOST_BOT_TOKEN') ?? ''
const MATTERMOST_HOST = Deno.env.get("MATTERMOST_URL") ?? ""

// メンターグループ: r3a1ho64b7ghfdogr3xyrw9gya

const MENTOR_GROUP_ID = Deno.env.get('MATTERMOST_MENTOR_GROUP_ID') ?? 'r3a1ho64b7ghfdogr3xyrw9gya'

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

// username からユーザー情報を取得する
export async function getUserByUsername(username: string): Promise<{id: string; username: string} | null> {
  const normalized = username.replace(/^@/, '').trim()
  if (!normalized) {
    return null
  }
  const url = `${MATTERMOST_HOST}/api/v4/users/username/${encodeURIComponent(normalized)}`
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
      'Accept': 'application/json'
    }
  })
  if (!res.ok) {
    if (res.status !== 404) {
      console.error('Failed to fetch user by username:', normalized, await res.text())
    }
    return null
  }
  const data = await res.json()
  return {
    id: data.id,
    username: data.username
  }
}

// 複数 username からユーザー情報を取得する
export async function getUsersByUsernames(usernames: string[]): Promise<{id: string; username: string}[]> {
  const normalized = Array.from(new Set(
    usernames.map((u) => u.replace(/^@/, '').trim()).filter((u) => u.length > 0)
  ))
  if (normalized.length === 0) {
    return []
  }
  const results = await Promise.all(normalized.map((u) => getUserByUsername(u)))
  return results.filter((u): u is {id: string; username: string} => u !== null)
}

// ユーザーID一覧からユーザー情報を取得する
export async function getUsersByIds(userIds: string[]): Promise<{id: string; username: string}[]> {
  const normalized = Array.from(new Set(userIds.map((u) => u.trim()).filter((u) => u.length > 0)))
  if (normalized.length === 0) {
    return []
  }
  const url = `${MATTERMOST_HOST}/api/v4/users/ids`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(normalized)
  })
  if (!res.ok) {
    console.error('Failed to fetch users by ids:', await res.text())
    return []
  }
  const data = await res.json()
  return data.map((u: any) => ({
    id: u.id,
    username: u.username
  }))
}

// User Group を name で取得する
export async function getUserGroupByName(name: string): Promise<{id: string; name: string} | null> {
  const normalized = name.replace(/^@/, '').trim()
  if (!normalized) {
    return null
  }
  const url = `${MATTERMOST_HOST}/api/v4/groups?q=${encodeURIComponent(normalized)}&filter_allow_reference=true&per_page=200`
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
      'Accept': 'application/json'
    }
  })
  if (!res.ok) {
    console.error('Failed to fetch user group by name:', normalized, await res.text())
    return null
  }
  const data = await res.json()
  const groups = Array.isArray(data)
    ? data
    : Array.isArray(data?.groups)
    ? data.groups
    : []
  const group = groups.find((g: any) => g?.name === normalized)
  if (!group) {
    return null
  }
  return {
    id: group.id,
    name: group.name
  }
}

// User Group メンバー一覧を取得する
export async function getUserGroupMembers(groupId: string): Promise<{id: string; username: string}[]> {
  const perPage = 200
  const membersById = new Map<string, {id: string; username: string}>()

  for (let page = 0; ; page += 1) {
    const url = `${MATTERMOST_HOST}/api/v4/groups/${encodeURIComponent(groupId)}/members?page=${page}&per_page=${perPage}`
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
        'Accept': 'application/json'
      }
    })
    if (!res.ok) {
      console.error('Failed to fetch user group members:', await res.text())
      return []
    }

    const data = await res.json()
    const members = Array.isArray(data)
      ? data
      : Array.isArray(data?.members)
      ? data.members
      : []
    for (const member of members) {
      const userId = member?.id ?? member?.user_id
      const username = member?.username
      if (
        typeof userId === 'string' && userId.length > 0 &&
        typeof username === 'string' && username.length > 0
      ) {
        membersById.set(userId, { id: userId, username })
      }
    }

    const totalMemberCount = typeof data?.total_member_count === 'number'
      ? data.total_member_count
      : null
    if (
      members.length < perPage ||
      (totalMemberCount !== null && membersById.size >= totalMemberCount)
    ) {
      break
    }
  }

  return Array.from(membersById.values())
}

// User Group メンバーの user_id 一覧を取得する
export async function getUserGroupMemberIds(groupId: string): Promise<string[]> {
  const members = await getUserGroupMembers(groupId)
  return members.map((member) => member.id)
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

// スレッド内のポストID一覧を取得する (root + replies)
export async function getThreadPostIds(rootId: string): Promise<string[]> {
  const url = `${MATTERMOST_HOST}/api/v4/posts/${rootId}/thread`
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
      'Accept': 'application/json'
    }
  })
  if (!res.ok) {
    console.error('Failed to fetch thread posts:', await res.text())
    return [rootId]
  }
  const data = await res.json()
  const postsObj = data?.posts ?? {}
  const ids = Object.keys(postsObj)
  return ids.length > 0 ? ids : [rootId]
}

// 指定した postId の投稿を取得する
// 404 の場合は notFound を true で返す
export async function getPost(postId: string): Promise<{ post: any | null; notFound: boolean }> {
  const url = `${MATTERMOST_HOST}/api/v4/posts/${postId}`
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${MATTERMOST_TOKEN}`,
      'Accept': 'application/json'
    }
  })
  if (res.status === 404) {
    return { post: null, notFound: true }
  }
  if (!res.ok) {
    console.error('Failed to fetch post:', await res.text())
    return { post: null, notFound: false }
  }
  const data = await res.json()
  return { post: data, notFound: false }
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

/**
 * 既存ポストを更新する
 * @param postId
 * @param channelId
 * @param message
 * @returns
 */
export async function updatePost(postId: string, channelId: string, message: string) {
  const url = `${MATTERMOST_HOST}/api/v4/posts/${postId}`
  const body = {
    id: postId,
    channel_id: channelId,
    message,
  }

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${MATTERMOST_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    console.error("Failed to update post:", await res.text())
    return null
  }
  return await res.json()
}
