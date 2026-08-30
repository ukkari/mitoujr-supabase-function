import { createClient } from "@libsql/client";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required");
const outputArg = process.argv.indexOf("--output");
const output = resolve(
  outputArg >= 0 && process.argv[outputArg + 1]
    ? process.argv[outputArg + 1]
    : ".migration-data/turso-reminders.json",
);
const client = createClient({ url, authToken });
const result = await client.execute("SELECT * FROM reminders ORDER BY post_id");
const rows = result.rows.map((row) => Object.fromEntries(Object.entries(row)));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output, count: rows.length }, null, 2));
client.close();
