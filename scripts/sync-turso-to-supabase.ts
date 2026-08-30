import { createClient } from "@libsql/client";

const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_AUTH_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!tursoUrl || !tursoToken || !supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY are required",
  );
}

const sinceArg = process.argv.indexOf("--since");
const since = sinceArg >= 0 ? process.argv[sinceArg + 1] : undefined;
if (!since || Number.isNaN(Date.parse(since))) {
  throw new Error("--since <ISO timestamp> is required for rollback sync safety");
}

const client = createClient({ url: tursoUrl, authToken: tursoToken });
const result = await client.execute({
  sql: `
    SELECT post_id, channel_id, due_date, content, target_usernames_json,
           completed, updated_at
    FROM reminders WHERE updated_at >= ? ORDER BY post_id
  `,
  args: [since],
});
const rows = result.rows.map((row) => {
  const targets = typeof row.target_usernames_json === "string"
    ? JSON.parse(row.target_usernames_json) as unknown
    : null;
  const body = String(row.content ?? "");
  return {
    post_id: String(row.post_id),
    channel_id: String(row.channel_id),
    due_date: String(row.due_date),
    content: Array.isArray(targets)
      ? JSON.stringify({ body, target_usernames: targets.map(String) })
      : body,
    completed: Number(row.completed) === 1,
    updated_at: String(row.updated_at),
  };
});

if (rows.length > 0) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/reminders?on_conflict=post_id`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    },
  );
  if (!response.ok) throw new Error(`Supabase rollback sync failed (${response.status})`);
}
console.log(JSON.stringify({ since, synchronized: rows.length }, null, 2));
client.close();
