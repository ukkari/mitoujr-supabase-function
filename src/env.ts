export type SummaryTarget = "yesterday" | "today";

export type SummaryWorkflowParams = {
  target: SummaryTarget;
  targetDateJst: string;
  requestedBy: "cron" | "admin";
};

export type WorkflowStatus = {
  status:
    | "queued"
    | "running"
    | "paused"
    | "errored"
    | "terminated"
    | "complete"
    | "waiting"
    | "waitingForPause"
    | "unknown";
  error?: { name: string; message: string };
  output?: unknown;
};

export type WorkflowInstanceBinding = {
  id: string;
  status(): Promise<WorkflowStatus>;
  restart(options?: unknown): Promise<void>;
};

export type WorkflowBinding = {
  create(options: {
    id: string;
    params: SummaryWorkflowParams;
  }): Promise<WorkflowInstanceBinding>;
  get(id: string): Promise<WorkflowInstanceBinding>;
};

export interface Env {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  MATTERMOST_URL: string;
  MATTERMOST_BOT_TOKEN: string;
  MATTERMOST_SLASH_TOKEN: string;
  MATTERMOST_SLASH_REMINDER_TOKEN: string;
  MATTERMOST_MAIN_TEAM: string;
  MATTERMOST_SUMMARY_CHANNEL: string;
  MATTERMOST_MENTOR_GROUP_ID: string;
  OPENAI_API_KEY: string;
  OPENAI_TEXT_MODEL: string;
  OPENAI_IMAGE_MODEL: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_TTS_MODEL?: string;
  GEMINI_VOICE?: string;
  VIDEO_RUNNER_SECRET?: string;
  VIDEO_TEST_CHANNEL?: string;
  ADMIN_TRIGGER_SECRET: string;
  DRY_RUN?: string;
  DAILY_SUMMARY_WORKFLOW: WorkflowBinding;
}

export function isDryRun(env: Env): boolean {
  return env.DRY_RUN === "true";
}

export function assertRequiredEnv(env: Env): void {
  const required: Array<keyof Env> = [
    "TURSO_DATABASE_URL",
    "TURSO_AUTH_TOKEN",
    "MATTERMOST_URL",
    "MATTERMOST_BOT_TOKEN",
    "MATTERMOST_SLASH_TOKEN",
    "MATTERMOST_SLASH_REMINDER_TOKEN",
    "MATTERMOST_MAIN_TEAM",
    "MATTERMOST_SUMMARY_CHANNEL",
    "MATTERMOST_MENTOR_GROUP_ID",
    "OPENAI_API_KEY",
    "ADMIN_TRIGGER_SECRET",
  ];

  const missing = required.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`Missing required bindings: ${missing.join(", ")}`);
  }
}
