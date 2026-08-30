import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Env, WorkflowStatus } from "../src/env";
import { registerAdminRoutes } from "../src/routes/admin";
import { registerSlashRoutes } from "../src/routes/slash";

function appWithStatus(status: WorkflowStatus["status"] = "complete") {
  const restart = vi.fn().mockResolvedValue(undefined);
  const instance = {
    id: "summary-2026-08-29",
    status: vi.fn().mockResolvedValue({ status }),
    restart,
  };
  const workflow = {
    create: vi.fn().mockRejectedValue(new Error("already exists")),
    get: vi.fn().mockResolvedValue(instance),
  };
  const env = {
    ADMIN_TRIGGER_SECRET: "admin-secret",
    DAILY_SUMMARY_WORKFLOW: workflow,
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  registerSlashRoutes(app);
  registerAdminRoutes(app);
  return { app, env, workflow, restart };
}

function adminRequest(body: unknown, secret = "admin-secret") {
  return new Request("https://worker.test/admin/daily-summary", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("admin routes", () => {
  it("requires bearer authentication", async () => {
    const { app, env } = appWithStatus();
    const response = await app.fetch(adminRequest({}, "wrong"), env);
    expect(response.status).toBe(401);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects the removed audio parameter", async () => {
    const { app, env, workflow } = appWithStatus();
    const response = await app.fetch(adminRequest({ type: "audio" }), env);
    expect(response.status).toBe(400);
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it("rejects the legacy audio query parameter", async () => {
    const { app, env, workflow } = appWithStatus();
    const request = adminRequest({ target: "today" });
    const response = await app.fetch(
      new Request(`${request.url}?type=audio`, request),
      env,
    );
    expect(response.status).toBe(400);
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it("returns 409 for a running or completed target day", async () => {
    const { app, env } = appWithStatus("complete");
    const response = await app.fetch(adminRequest({ target: "yesterday" }), env);
    expect(response.status).toBe(409);
  });

  it("restarts only an errored target day", async () => {
    const { app, env, restart } = appWithStatus("errored");
    const response = await app.fetch(adminRequest({ target: "yesterday" }), env);
    expect(response.status).toBe(202);
    expect(restart).toHaveBeenCalledOnce();
    expect((await response.json() as { restarted: boolean }).restarted).toBe(true);
  });

  it("does not expose a cron HTTP route", async () => {
    const { app, env } = appWithStatus();
    const response = await app.fetch(
      new Request("https://worker.test/reminder-cron", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(404);
  });

  it("does not add a CORS preflight route", async () => {
    const { app, env } = appWithStatus();
    const response = await app.fetch(
      new Request("https://worker.test/slash-reminder", { method: "OPTIONS" }),
      env,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
