import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  canonicalizeReminder,
  migrationStats,
  type SourceReminder,
} from "./lib/reminder-migration";

const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}
const outputArg = process.argv.indexOf("--output");
const output = resolve(
  outputArg >= 0 && process.argv[outputArg + 1]
    ? process.argv[outputArg + 1]
    : ".migration-data/supabase-reminders.json",
);

const rows: SourceReminder[] = [];
for (let offset = 0; ; offset += 1000) {
  const response = await fetch(
    `${url}/rest/v1/reminders?select=*&order=post_id.asc&offset=${offset}&limit=1000`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );
  if (!response.ok) throw new Error(`Supabase export failed (${response.status})`);
  const page = await response.json() as SourceReminder[];
  rows.push(...page);
  if (page.length < 1000) break;
}

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output, ...migrationStats(rows.map(canonicalizeReminder)) }, null, 2));
