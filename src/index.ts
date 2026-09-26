import { Hono } from "hono";
import type { Env } from "./env";
import { assertRequiredEnv } from "./env";
import { runReminderCron } from "./reminder-cron";
import {
  registerAdminRoutes,
  startSummaryWorkflow,
  WorkflowAlreadyExistsError,
} from "./routes/admin";
import { registerSlashRoutes } from "./routes/slash";
import { SummaryRunRepository } from "./db";
import { cleanupVideoPlans, registerVideoRoutes } from "./routes/video";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (context, next) => {
  assertRequiredEnv(context.env);
  await next();
});

registerSlashRoutes(app);
registerAdminRoutes(app);
registerVideoRoutes(app);

app.notFound((context) => context.json({ error: "Not found" }, 404));
app.onError((error, context) => {
  console.error("Request failed", { error: error.message });
  // Video admin errors are fixed strings (no post bodies or keys); show them to the authenticated runner.
  const authorized = context.req.path.startsWith("/admin/summary-video/") && context.res.status !== 401;
  return context.json({ error: authorized ? error.message : "Internal server error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    assertRequiredEnv(env);
    await SummaryRunRepository.fromEnv(env).cleanupExpired(
      new Date(controller.scheduledTime),
    );
    await cleanupVideoPlans(env, new Date(controller.scheduledTime));
    if (controller.cron === "0 15 * * *") {
      const result = await runReminderCron(env, new Date(controller.scheduledTime));
      console.log("Reminder cron completed", {
        checked: result.checked,
        sent: result.sent,
        completed: result.completed,
        failed: result.failed,
        skippedDuplicate: result.skippedDuplicate,
        dryRunCount: result.dryRunMessages.length,
      });
      return;
    }
    if (controller.cron === "0 22 * * *") {
      try {
        const started = await startSummaryWorkflow(
          env,
          "yesterday",
          "cron",
          new Date(controller.scheduledTime),
        );
        console.log("Daily summary workflow scheduled", {
          runId: started.instance.id,
          restarted: started.restarted,
        });
      } catch (error) {
        if (!(error instanceof WorkflowAlreadyExistsError)) throw error;
        console.log("Daily summary workflow already exists for target date");
      }
      return;
    }
    throw new Error(`Unexpected cron expression: ${controller.cron}`);
  },
};

export { DailySummaryWorkflow } from "./workflow";
