import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
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
});
