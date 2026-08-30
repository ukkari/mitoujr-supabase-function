import { createClient } from "@libsql/client";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required");

const client = createClient({ url, authToken });
const migrationsDir = resolve("migrations");
const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

await client.execute(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )
`);

for (const file of files) {
  const existing = await client.execute({
    sql: "SELECT 1 FROM schema_migrations WHERE version = ? LIMIT 1",
    args: [file],
  });
  if (existing.rows.length > 0) {
    console.log(`Skipped ${file} (already applied)`);
    continue;
  }
  const sql = await readFile(resolve(migrationsDir, file), "utf8");
  await client.executeMultiple(sql);
  await client.execute({
    sql: "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    args: [file, new Date().toISOString()],
  });
  console.log(`Applied ${file}`);
}
client.close();
