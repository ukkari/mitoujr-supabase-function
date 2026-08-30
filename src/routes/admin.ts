import { Hono } from "hono";
import type { Env, SummaryTarget, WorkflowInstanceBinding } from "../env";
import { currentTargetDate } from "../summary";
import { secureEqual } from "./slash";

export class WorkflowAlreadyExistsError extends Error {
  constructor(readonly details: unknown) {
    super("A workflow for this target date already exists");
    this.name = "WorkflowAlreadyExistsError";
  }
}

async function authenticated(request: Request, env: Env): Promise<boolean> {
  const authorization = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;
  return await secureEqual(authorization.slice(prefix.length), env.ADMIN_TRIGGER_SECRET);
}

export function workflowId(targetDateJst: string): string {
  return `summary-${targetDateJst}`;
}

export async function startSummaryWorkflow(
  env: Env,
  target: SummaryTarget,
  requestedBy: "cron" | "admin",
  now = new Date(),
): Promise<{ instance: WorkflowInstanceBinding; restarted: boolean }> {
  const targetDateJst = currentTargetDate(target, now);
  const id = workflowId(targetDateJst);
  try {
    const instance = await env.DAILY_SUMMARY_WORKFLOW.create({
      id,
      params: { target, targetDateJst, requestedBy },
    });
    return { instance, restarted: false };
  } catch (createError) {
    let instance: WorkflowInstanceBinding;
    try {
      instance = await env.DAILY_SUMMARY_WORKFLOW.get(id);
    } catch {
      throw createError;
    }
    const details = await instance.status();
    if (details.status !== "errored" && details.status !== "terminated") {
      throw new WorkflowAlreadyExistsError(details);
    }
    await instance.restart();
    return { instance, restarted: true };
  }
}

export function registerAdminRoutes(app: Hono<{ Bindings: Env }>) {
  app.post("/admin/daily-summary", async (context) => {
    if (!await authenticated(context.req.raw, context.env)) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    const body: Record<string, unknown> = await context.req
      .json<Record<string, unknown>>()
      .catch(() => ({}));
    if ("type" in body || context.req.query("type") !== undefined) {
      return context.json({ error: "Audio summaries are no longer supported" }, 400);
    }
    const target = body.target ?? "yesterday";
    if (target !== "yesterday" && target !== "today") {
      return context.json({ error: "target must be yesterday or today" }, 400);
    }
    try {
      const started = await startSummaryWorkflow(context.env, target, "admin");
      return context.json({
        runId: started.instance.id,
        target,
        status: "queued",
        restarted: started.restarted,
      }, 202);
    } catch (error) {
      if (!(error instanceof WorkflowAlreadyExistsError)) throw error;
      return context.json({
        error: error.message,
        details: error.details,
      }, 409);
    }
  });

  app.get("/admin/daily-summary/:runId", async (context) => {
    if (!await authenticated(context.req.raw, context.env)) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    const runId = context.req.param("runId");
    if (!/^summary-\d{4}-\d{2}-\d{2}$/.test(runId)) {
      return context.json({ error: "Invalid run id" }, 400);
    }
    try {
      const instance = await context.env.DAILY_SUMMARY_WORKFLOW.get(runId);
      return context.json({ runId, details: await instance.status() });
    } catch {
      return context.json({ error: "Workflow not found" }, 404);
    }
  });
}
