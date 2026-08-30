import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalizeReminder,
  migrationStats,
  type CanonicalReminder,
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
const expected = source.map(canonicalizeReminder);
const client = createClient({ url, authToken });
const result = await client.execute("SELECT * FROM reminders ORDER BY post_id");
const actual = result.rows.map((row): CanonicalReminder => ({
  post_id: String(row.post_id),
  channel_id: String(row.channel_id),
  due_date: String(row.due_date),
  content: String(row.content ?? ""),
  target_usernames_json: typeof row.target_usernames_json === "string"
    ? row.target_usernames_json
    : null,
  completed: Number(row.completed),
  created_at: typeof row.created_at === "string" ? row.created_at : null,
  updated_at: String(row.updated_at),
  legacy_row_json: String(row.legacy_row_json),
}));
const expectedStats = migrationStats(expected);
const actualStats = migrationStats(actual);
console.log(JSON.stringify({ expected: expectedStats, actual: actualStats }, null, 2));
if (JSON.stringify(expectedStats) !== JSON.stringify(actualStats)) {
  throw new Error("Turso reminders verification failed");
}
client.close();
