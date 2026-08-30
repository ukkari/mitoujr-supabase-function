import { createClient, type Client, type InValue } from "@libsql/client/web";
import type { Env } from "./env";
import type { SummaryInput } from "./summary";

export type ReminderRecord = {
  postId: string;
  channelId: string;
  dueDate: string;
  content: string;
  targetUsernamesJson: string | null;
  completed: boolean;
  createdAt: string | null;
  updatedAt: string;
  legacyRowJson: string | null;
};

export type NewReminder = Omit<ReminderRecord, "completed" | "createdAt" | "legacyRowJson"> & {
  completed?: boolean;
};

function value(row: Record<string, unknown>, key: string): unknown {
  return row[key];
}

function asString(input: unknown, fallback = ""): string {
  return typeof input === "string" ? input : fallback;
}

function mapReminder(row: Record<string, unknown>): ReminderRecord {
  return {
    postId: asString(value(row, "post_id")),
    channelId: asString(value(row, "channel_id")),
    dueDate: asString(value(row, "due_date")),
    content: asString(value(row, "content")),
    targetUsernamesJson: typeof value(row, "target_usernames_json") === "string"
      ? String(value(row, "target_usernames_json"))
      : null,
    completed: Number(value(row, "completed")) === 1,
    createdAt: typeof value(row, "created_at") === "string"
      ? String(value(row, "created_at"))
      : null,
    updatedAt: asString(value(row, "updated_at")),
    legacyRowJson: typeof value(row, "legacy_row_json") === "string"
      ? String(value(row, "legacy_row_json"))
      : null,
  };
}

export class ReminderRepository {
  constructor(private readonly client: Client) {}

  static fromEnv(env: Pick<Env, "TURSO_DATABASE_URL" | "TURSO_AUTH_TOKEN">) {
    return new ReminderRepository(createClient({
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    }));
  }

  async find(postId: string): Promise<ReminderRecord | null> {
    const result = await this.client.execute({
      sql: "SELECT * FROM reminders WHERE post_id = ? LIMIT 1",
      args: [postId],
    });
    return result.rows[0] ? mapReminder(result.rows[0]) : null;
  }

  async listIncomplete(): Promise<ReminderRecord[]> {
    const result = await this.client.execute(
      "SELECT * FROM reminders WHERE completed = 0 ORDER BY due_date, post_id",
    );
    return result.rows.map(mapReminder);
  }

  async upsert(reminder: NewReminder): Promise<void> {
    const now = reminder.updatedAt || new Date().toISOString();
    await this.client.execute({
      sql: `
        INSERT INTO reminders (
          post_id, channel_id, due_date, content, target_usernames_json,
          completed, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(post_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          due_date = excluded.due_date,
          content = excluded.content,
          target_usernames_json = excluded.target_usernames_json,
          completed = excluded.completed,
          updated_at = excluded.updated_at
      `,
      args: [
        reminder.postId,
        reminder.channelId,
        reminder.dueDate,
        reminder.content,
        reminder.targetUsernamesJson,
        reminder.completed ? 1 : 0,
        now,
        now,
      ],
    });
  }

  async markCompleted(postId: string, now = new Date().toISOString()): Promise<void> {
    await this.client.execute({
      sql: "UPDATE reminders SET completed = 1, updated_at = ? WHERE post_id = ?",
      args: [now, postId],
    });
  }

  async claimDelivery(
    postId: string,
    deliveryDateJst: string,
    now = new Date(),
  ): Promise<{ claimed: boolean; claimToken: string; pendingPostId: string }> {
    const claimToken = crypto.randomUUID();
    const pendingPostId = `cf:${crypto.randomUUID()}`;
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    const args: InValue[] = [
      postId,
      deliveryDateJst,
      claimToken,
      pendingPostId,
      nowIso,
      nowIso,
    ];

    await this.client.batch([
      {
        sql: `
          INSERT OR IGNORE INTO reminder_deliveries (
            post_id, delivery_date_jst, status, attempts, claim_token,
            pending_post_id, created_at, updated_at
          ) VALUES (?, ?, 'pending', 1, ?, ?, ?, ?)
        `,
        args,
      },
      {
        sql: `
          UPDATE reminder_deliveries
          SET status = 'pending', attempts = attempts + 1, claim_token = ?,
              last_error = NULL, updated_at = ?
          WHERE post_id = ? AND delivery_date_jst = ?
            AND (status = 'failed' OR (status = 'pending' AND updated_at < ?))
        `,
        args: [claimToken, nowIso, postId, deliveryDateJst, staleBefore],
      },
      {
        sql: `
          UPDATE reminder_deliveries
          SET pending_post_id = COALESCE(pending_post_id, ?)
          WHERE post_id = ? AND delivery_date_jst = ?
        `,
        args: [pendingPostId, postId, deliveryDateJst],
      },
    ], "write");

    const result = await this.client.execute({
      sql: `
        SELECT status, claim_token, pending_post_id FROM reminder_deliveries
        WHERE post_id = ? AND delivery_date_jst = ?
      `,
      args: [postId, deliveryDateJst],
    });
    const row = result.rows[0];
    return {
      claimed: row?.status === "pending" && row?.claim_token === claimToken,
      claimToken,
      pendingPostId: typeof row?.pending_post_id === "string"
        ? row.pending_post_id
        : pendingPostId,
    };
  }

  async markDeliverySent(
    postId: string,
    deliveryDateJst: string,
    claimToken: string,
    replyPostId: string | null,
    now = new Date().toISOString(),
  ): Promise<void> {
    await this.client.execute({
      sql: `
        UPDATE reminder_deliveries
        SET status = 'sent', reply_post_id = ?, sent_at = ?, updated_at = ?
        WHERE post_id = ? AND delivery_date_jst = ? AND claim_token = ?
      `,
      args: [replyPostId, now, now, postId, deliveryDateJst, claimToken],
    });
  }

  async markDeliveryFailed(
    postId: string,
    deliveryDateJst: string,
    claimToken: string,
    error: unknown,
    now = new Date().toISOString(),
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.client.execute({
      sql: `
        UPDATE reminder_deliveries
        SET status = 'failed', last_error = ?, updated_at = ?
        WHERE post_id = ? AND delivery_date_jst = ? AND claim_token = ?
      `,
      args: [message.slice(0, 1000), now, postId, deliveryDateJst, claimToken],
    });
  }
}

export class SummaryRunRepository {
  constructor(private readonly client: Client) {}

  static fromEnv(env: Pick<Env, "TURSO_DATABASE_URL" | "TURSO_AUTH_TOKEN">) {
    return new SummaryRunRepository(createClient({
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    }));
  }

  async cleanupExpired(now = new Date()): Promise<void> {
    const nowIso = now.toISOString();
    await this.client.batch([
      {
        sql: `
          DELETE FROM summary_run_fragments
          WHERE run_id IN (SELECT run_id FROM summary_runs WHERE expires_at <= ?)
        `,
        args: [nowIso],
      },
      {
        sql: "DELETE FROM summary_runs WHERE expires_at <= ?",
        args: [nowIso],
      },
    ], "write");
  }

  async saveInput(runId: string, input: SummaryInput, now = new Date()): Promise<void> {
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();
    await this.client.batch([
      {
        sql: `
          DELETE FROM summary_run_fragments
          WHERE run_id IN (SELECT run_id FROM summary_runs WHERE expires_at <= ?)
        `,
        args: [nowIso],
      },
      {
        sql: "DELETE FROM summary_runs WHERE expires_at <= ?",
        args: [nowIso],
      },
      {
        sql: "DELETE FROM summary_run_fragments WHERE run_id = ?",
        args: [runId],
      },
      {
        sql: `
          INSERT INTO summary_runs (
            run_id, target_date_jst, target_label, raw_content,
            created_at, updated_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET
            target_date_jst = excluded.target_date_jst,
            target_label = excluded.target_label,
            raw_content = excluded.raw_content,
            summary_text = NULL,
            updated_at = excluded.updated_at,
            expires_at = excluded.expires_at
        `,
        args: [
          runId,
          input.targetDateJst,
          input.label,
          input.summaryRaw,
          nowIso,
          nowIso,
          expiresAt,
        ],
      },
    ], "write");
  }

  async loadInput(runId: string): Promise<SummaryInput> {
    const result = await this.client.execute({
      sql: `
        SELECT target_date_jst, target_label, raw_content
        FROM summary_runs WHERE run_id = ? LIMIT 1
      `,
      args: [runId],
    });
    const row = result.rows[0];
    if (!row) {
      throw new Error("Summary workflow input is unavailable");
    }
    const fragments = await this.client.execute({
      sql: `
        SELECT content FROM summary_run_fragments
        WHERE run_id = ? ORDER BY sequence, channel_id
      `,
      args: [runId],
    });
    const summaryRaw = fragments.rows.length > 0
      ? fragments.rows.map((fragment) => String(fragment.content ?? "")).join("")
      : typeof row.raw_content === "string" ? row.raw_content : "";
    return {
      summaryRaw,
      label: row.target_label === "今日" ? "今日" : "昨日",
      targetDateJst: String(row.target_date_jst),
    };
  }

  async appendInputFragment(
    runId: string,
    sequence: number,
    channelId: string,
    fragment: string,
    now = new Date(),
  ): Promise<void> {
    await this.client.execute({
      sql: `
        INSERT INTO summary_run_fragments (
          run_id, sequence, channel_id, content, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id, channel_id) DO UPDATE SET
          sequence = excluded.sequence,
          content = excluded.content,
          updated_at = excluded.updated_at
      `,
      args: [runId, sequence, channelId, fragment, now.toISOString()],
    });
  }

  async saveSummary(runId: string, summary: string, now = new Date()): Promise<void> {
    const result = await this.client.execute({
      sql: `
        UPDATE summary_runs SET summary_text = ?, updated_at = ?
        WHERE run_id = ?
      `,
      args: [summary, now.toISOString(), runId],
    });
    if (result.rowsAffected !== 1) throw new Error("Summary workflow state is unavailable");
  }

  async loadSummary(runId: string): Promise<string> {
    const result = await this.client.execute({
      sql: "SELECT summary_text FROM summary_runs WHERE run_id = ? LIMIT 1",
      args: [runId],
    });
    const summary = result.rows[0]?.summary_text;
    if (typeof summary !== "string" || summary.length === 0) {
      throw new Error("Generated summary is unavailable");
    }
    return summary;
  }

  async clearContent(runId: string, now = new Date()): Promise<void> {
    await this.client.batch([
      {
        sql: "DELETE FROM summary_run_fragments WHERE run_id = ?",
        args: [runId],
      },
      {
        sql: `
          UPDATE summary_runs
          SET raw_content = NULL, summary_text = NULL, updated_at = ?
          WHERE run_id = ?
        `,
        args: [now.toISOString(), runId],
      },
    ], "write");
  }
}
