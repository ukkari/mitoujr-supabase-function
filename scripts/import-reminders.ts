import { createClient, type InStatement } from "@libsql/client";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalizeReminder,
  migrationStats,
  type SourceReminder,
} from "./lib/reminder-migration";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required");
const inputArg = process.argv.indexOf("--input");
const input = resolve(
  inputArg >= 0 && process.argv[inputArg + 1]
    ? process.argv[inputArg + 1]
    : ".migration-data/supabase-reminders.json",
);
const source = JSON.parse(await readFile(input, "utf8")) as SourceReminder[];
const rows = source.map(canonicalizeReminder);
const client = createClient({ url, authToken });

for (let offset = 0; offset < rows.length; offset += 100) {
  const statements: InStatement[] = rows.slice(offset, offset + 100).map((row) => ({
    sql: `
      INSERT INTO reminders (
        post_id, channel_id, due_date, content, target_usernames_json,
        completed, created_at, updated_at, legacy_row_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(post_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        due_date = excluded.due_date,
        content = excluded.content,
        target_usernames_json = excluded.target_usernames_json,
        completed = excluded.completed,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        legacy_row_json = excluded.legacy_row_json
    `,
    args: [
      row.post_id,
      row.channel_id,
      row.due_date,
      row.content,
      row.target_usernames_json,
      row.completed,
      row.created_at,
      row.updated_at,
      row.legacy_row_json,
    ],
  }));
  await client.batch(statements, "write");
}
console.log(JSON.stringify({ input, imported: migrationStats(rows) }, null, 2));
client.close();
