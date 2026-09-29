import type { Env } from "./env";

const dispatchUrl = "https://api.github.com/repos/ukkari/mitoujr-supabase-function/actions/workflows/summary-video.yml/dispatches";

export async function dispatchSummaryVideo(env: Env, targetDateJst: string): Promise<{ httpStatus: number }> {
  if (!env.GITHUB_VIDEO_DISPATCH_TOKEN) throw new Error("GITHUB_VIDEO_DISPATCH_TOKEN is not configured");
  const response = await fetch(dispatchUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_VIDEO_DISPATCH_TOKEN}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "mattermost-automation-worker",
    },
    body: JSON.stringify({ ref: "main", inputs: { date: targetDateJst, post: "true", automatic: "true" } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 200 && response.status !== 204) {
    await response.body?.cancel();
    throw new Error(`GitHub video dispatch failed (${response.status})`);
  }
  await response.body?.cancel();
  return { httpStatus: response.status };
}
