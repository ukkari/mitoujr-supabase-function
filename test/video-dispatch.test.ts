import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { dispatchSummaryVideo } from "../src/video-dispatch";

afterEach(() => vi.unstubAllGlobals());

it("dispatches the exact summary date and posting intent to GitHub", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  const env = { GITHUB_VIDEO_DISPATCH_TOKEN: "test-token" } as Env;
  await expect(dispatchSummaryVideo(env, "2026-09-29")).resolves.toEqual({ httpStatus: 204 });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toContain("/actions/workflows/summary-video.yml/dispatches");
  expect(JSON.parse(String(init.body))).toEqual({
    ref: "main", inputs: { date: "2026-09-29", post: "true", automatic: "true" },
  });
});

it("fails without a configured token and never calls GitHub", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(dispatchSummaryVideo({} as Env, "2026-09-29")).rejects.toThrow("not configured");
  expect(fetchMock).not.toHaveBeenCalled();
});
