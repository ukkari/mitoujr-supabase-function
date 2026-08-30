import { createHash } from "node:crypto";

export type SourceReminder = Record<string, unknown>;

export type CanonicalReminder = {
  post_id: string;
  channel_id: string;
  due_date: string;
  content: string;
  target_usernames_json: string | null;
  completed: number;
  created_at: string | null;
  updated_at: string;
  legacy_row_json: string;
};

function normalizeTargets(row: SourceReminder): string | null {
  const direct = row.target_usernames;
  if (Array.isArray(direct)) return JSON.stringify(direct.map(String));
  if (typeof direct === "string" && direct.length > 0) {
    try {
      const parsed = JSON.parse(direct);
      if (Array.isArray(parsed)) return JSON.stringify(parsed.map(String));
    } catch {
      return JSON.stringify(direct.split(",").map((value) =>
        value.replace(/^@/, "").trim()
      ).filter(Boolean));
    }
  }
  if (typeof row.content === "string") {
    try {
      const parsed = JSON.parse(row.content) as Record<string, unknown>;
      if (Array.isArray(parsed.target_usernames)) {
        return JSON.stringify(parsed.target_usernames.map(String));
      }
    } catch {
      // Legacy mentor reminders use plain text.
    }
  }
  return null;
}

export function canonicalizeReminder(row: SourceReminder): CanonicalReminder {
  const updatedAt = typeof row.updated_at === "string"
    ? row.updated_at
    : new Date(0).toISOString();
  return {
    post_id: String(row.post_id ?? ""),
    channel_id: String(row.channel_id ?? ""),
    due_date: String(row.due_date ?? "").slice(0, 10),
    content: typeof row.content === "string" ? row.content : "",
    target_usernames_json: normalizeTargets(row),
    completed: row.completed === true || row.completed === 1 ? 1 : 0,
    created_at: typeof row.created_at === "string" ? row.created_at : null,
    updated_at: updatedAt,
    legacy_row_json: stableStringify(row),
  };
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function migrationStats(rows: CanonicalReminder[]) {
  const sorted = [...rows].sort((left, right) => left.post_id.localeCompare(right.post_id));
  return {
    count: sorted.length,
    completed: sorted.filter((row) => row.completed === 1).length,
    incomplete: sorted.filter((row) => row.completed === 0).length,
    minDueDate: sorted.map((row) => row.due_date).sort()[0] ?? null,
    maxDueDate: sorted.map((row) => row.due_date).sort().at(-1) ?? null,
    sha256: createHash("sha256")
      .update(sorted.map((row) => stableStringify(row)).join("\n"))
      .digest("hex"),
  };
}
