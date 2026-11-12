import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { jstDate } from "../src/domain/date";
import {
  runDailySummaryWorkflow,
  type WorkflowRunnerDependencies,
  type WorkflowStepLike,
} from "../src/workflow-runner";

class RetryingStep implements WorkflowStepLike {
  readonly outputs: unknown[] = [];

  async do<T>(
    _name: string,
    optionsOrCallback: { retries: { limit: number } } | (() => Promise<T>),
    callback?: () => Promise<T>,
  ): Promise<T> {
    const operation = typeof optionsOrCallback === "function"
      ? optionsOrCallback
      : callback!;
    const limit = typeof optionsOrCallback === "function"
      ? 0
      : optionsOrCallback.retries.limit;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const output = await operation();
        this.outputs.push(output);
        return output;
      } catch (error) {
        if (attempt >= limit) throw error;
      }
    }
  }
}

function fixture(options: { imageFails?: boolean; textFailsOnce?: boolean } = {}) {
  let textAttempts = 0;
  const repository = {
    saveInput: vi.fn().mockResolvedValue(undefined),
    appendInputFragment: vi.fn().mockResolvedValue(undefined),
    loadInput: vi.fn().mockResolvedValue({
      summaryRaw: "sensitive Mattermost body",
      label: "今日",
      targetDateJst: "2026-08-30",
    }),
    saveSummary: vi.fn().mockResolvedValue(undefined),
    loadSummary: vi.fn().mockResolvedValue("sensitive generated summary"),
    clearContent: vi.fn().mockResolvedValue(undefined),
  };
  const mattermost = {
    postSummary: vi.fn().mockResolvedValue({ id: "no-updates-post" }),
    uploadSummaryFile: vi.fn().mockResolvedValue("file-id"),
    postSummaryWithFile: vi.fn().mockResolvedValue({ id: "summary-post" }),
  };
  const dependencies = {
    repository,
    mattermost: () => mattermost,
    prepareCollection: vi.fn().mockResolvedValue({
      channels: [{
        id: "channel-id",
        name: "channel-name",
        display_name: "Channel",
        type: "O",
        last_post_at: 1,
      }],
      label: "今日",
      targetDateJst: "2026-08-30",
      startTimeUtc: 1,
      endTimeUtc: 2,
    }),
    collectChannel: vi.fn().mockResolvedValue("sensitive Mattermost body"),
    generateText: vi.fn().mockImplementation(async () => {
      textAttempts += 1;
      if (options.textFailsOnce && textAttempts === 1) throw new Error("temporary OpenAI error");
      return "sensitive generated summary";
    }),
    generateImage: options.imageFails
      ? vi.fn().mockRejectedValue(new Error("temporary image error"))
      : vi.fn().mockResolvedValue({
        bytes: new Uint8Array([1, 2, 3]),
        altText: "image description",
      }),
    pendingPostId: vi.fn().mockResolvedValue("cf:pending"),
    dispatchVideo: vi.fn().mockResolvedValue({ httpStatus: 204 }),
  } as unknown as WorkflowRunnerDependencies;
  return { dependencies, repository, mattermost };
}

const env = {
  ADMIN_TRIGGER_SECRET: "admin-secret",
  DRY_RUN: "false",
} as Env;
const params = {
  target: "today" as const,
  targetDateJst: "2026-08-30",
  requestedBy: "admin" as const,
};
const cronParams = { ...params, requestedBy: "cron" as const };

afterEach(() => vi.restoreAllMocks());

describe("daily summary workflow", () => {
  it("uploads and posts an image in separate retryable steps", async () => {
    const step = new RetryingStep();
    const { dependencies, mattermost, repository } = fixture();
    const result = await runDailySummaryWorkflow(
      env,
      params,
      "summary-2026-08-30",
      step,
      dependencies,
    );
    expect(result).toEqual({ outcome: "posted-with-image", postId: "summary-post" });
    expect(mattermost.uploadSummaryFile).toHaveBeenCalledOnce();
    expect(mattermost.postSummaryWithFile).toHaveBeenCalledWith(
      "sensitive generated summary",
      "file-id",
      "image description",
      "cf:pending",
    );
    expect(repository.clearContent).toHaveBeenCalledOnce();
  });

  it("publishes text when image generation exhausts its retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const step = new RetryingStep();
    const { dependencies, mattermost } = fixture({ imageFails: true });
    const result = await runDailySummaryWorkflow(
      env,
      params,
      "summary-2026-08-30",
      step,
      dependencies,
    );
    expect(result).toEqual({ outcome: "posted-text-fallback", postId: "summary-post" });
    expect(mattermost.postSummaryWithFile).toHaveBeenCalledWith(
      "sensitive generated summary",
      null,
      undefined,
      "cf:pending",
    );
  });

  it("retries a temporary OpenAI error without putting bodies in step outputs", async () => {
    const step = new RetryingStep();
    const { dependencies } = fixture({ textFailsOnce: true });
    await runDailySummaryWorkflow(
      env,
      params,
      "summary-2026-08-30",
      step,
      dependencies,
    );
    const persistedOutputs = JSON.stringify(step.outputs);
    expect(persistedOutputs).not.toContain("sensitive Mattermost body");
    expect(persistedOutputs).not.toContain("sensitive generated summary");
  });

  it("dispatches the video only after the cron summary is posted and cleaned up", async () => {
    const step = new RetryingStep();
    const { dependencies, mattermost, repository } = fixture();
    await runDailySummaryWorkflow(env, cronParams, "summary-2026-08-30", step, dependencies);
    expect(dependencies.dispatchVideo).toHaveBeenCalledWith(env, "2026-08-30");
    const publishOrder = mattermost.postSummaryWithFile.mock.invocationCallOrder[0];
    const cleanupOrder = repository.clearContent.mock.invocationCallOrder[0];
    const dispatchOrder = vi.mocked(dependencies.dispatchVideo).mock.invocationCallOrder[0];
    expect(publishOrder).toBeLessThan(cleanupOrder);
    expect(cleanupOrder).toBeLessThan(dispatchOrder);
  });

  it("keeps the posted summary complete when GitHub dispatch fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const step = new RetryingStep();
    const { dependencies } = fixture();
    vi.mocked(dependencies.dispatchVideo).mockRejectedValue(new Error("GitHub video dispatch failed (503)"));
    const result = await runDailySummaryWorkflow(env, cronParams, "summary-2026-08-30", step, dependencies);
    expect(result).toEqual({ outcome: "posted-with-image", postId: "summary-post" });
    expect(dependencies.dispatchVideo).toHaveBeenCalledTimes(4);
  });

  it("does not dispatch a video for a manual summary or a no-updates day", async () => {
    const manual = fixture();
    await runDailySummaryWorkflow(env, params, "summary-2026-08-30", new RetryingStep(), manual.dependencies);
    expect(manual.dependencies.dispatchVideo).not.toHaveBeenCalled();

    const empty = fixture();
    vi.mocked(empty.dependencies.collectChannel).mockResolvedValue("");
    await runDailySummaryWorkflow(env, cronParams, "summary-2026-08-30", new RetryingStep(), empty.dependencies);
    expect(empty.dependencies.dispatchVideo).not.toHaveBeenCalled();
  });

  it("dispatches an already posted summary without collecting or posting it again", async () => {
    const { dependencies, mattermost } = fixture();
    const videoEnv = {
      ...env,
      DAILY_SUMMARY_WORKFLOW: {
        get: vi.fn().mockResolvedValue({ status: vi.fn().mockResolvedValue({
          status: "complete", output: JSON.stringify({ outcome: "posted-with-image", postId: "existing-summary" }),
        }) }),
      },
    } as unknown as Env;
    const result = await runDailySummaryWorkflow(videoEnv,
      { mode: "video-dispatch", targetDateJst: jstDate(), requestedBy: "admin" },
      "video-dispatch-today", new RetryingStep(), dependencies);
    expect(result).toEqual({ outcome: "video-dispatched", targetDateJst: jstDate(), summaryPostId: "existing-summary", httpStatus: 204 });
    expect(dependencies.dispatchVideo).toHaveBeenCalledWith(videoEnv, jstDate());
    expect(dependencies.prepareCollection).not.toHaveBeenCalled();
    expect(mattermost.postSummaryWithFile).not.toHaveBeenCalled();
  });

  it("refuses video-only dispatch when the daily summary has no updates", async () => {
    const { dependencies } = fixture();
    const videoEnv = {
      ...env,
      DAILY_SUMMARY_WORKFLOW: {
        get: vi.fn().mockResolvedValue({ status: vi.fn().mockResolvedValue({
          status: "complete", output: { outcome: "no-updates", postId: "no-updates-post" },
        }) }),
      },
    } as unknown as Env;
    await expect(runDailySummaryWorkflow(videoEnv,
      { mode: "video-dispatch", targetDateJst: jstDate(), requestedBy: "admin" },
      "video-dispatch-today", new RetryingStep(), dependencies)).rejects.toThrow("has not posted an update");
    expect(dependencies.dispatchVideo).not.toHaveBeenCalled();
  });
});
