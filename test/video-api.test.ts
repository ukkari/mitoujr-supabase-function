import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVideoApi } from "../video/api";

const api = createVideoApi("https://worker.example/admin/summary-video/2026-10-06", "private-token");
const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("video API backoff", () => {
  it("recovers a connection reset, preserves the request and creates a fresh timeout", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("private URL and token", { cause: { code: "ECONNRESET" } }))
      .mockResolvedValueOnce(Response.json({ audio: "wav", narration: "本文" }));
    vi.stubGlobal("fetch", fetch);
    const result = api("/audio/9", init);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ audio: "wav", narration: "本文" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe(fetch.mock.calls[0][0]);
    expect(fetch.mock.calls[1][1]).toMatchObject({ ...init, headers: { ...init.headers, Authorization: "Bearer private-token" } });
    expect(fetch.mock.calls[1][1].signal).not.toBe(fetch.mock.calls[0][1].signal);
    expect(console.warn).toHaveBeenCalledWith("Video API /audio/9: TypeError/ECONNRESET; retry 1/4 in 2000ms");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private");
  });

  it.each([408, 429, 500, 502, 503, 504])("retries HTTP %s and releases the failed response", async (status) => {
    const failed = new Response("private upstream body", { status });
    const cancel = vi.spyOn(failed.body!, "cancel");
    const fetch = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(Response.json({ status: "ready" }));
    vi.stubGlobal("fetch", fetch);
    const result = api("/prepare", init);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ status: "ready" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private upstream");
  });

  it.each([400, 401, 403, 404, 409])("does not retry permanent HTTP %s errors", async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response("private upstream body", { status }));
    vi.stubGlobal("fetch", fetch);
    await expect(api("/prepare", init)).rejects.toThrow(`Video API /prepare failed after 1 attempt(s) (HTTP ${status})`);
    expect(fetch).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("adds jitter and stops after four exponentially spaced retries", async () => {
    vi.mocked(Math.random).mockReturnValue(0.5);
    const fetch = vi.fn().mockRejectedValue(new DOMException("private details", "TimeoutError"));
    vi.stubGlobal("fetch", fetch);
    const result = expect(api("/audio/0", init)).rejects.toThrow("failed after 5 attempt(s) (TimeoutError)");
    await vi.runAllTimersAsync();
    await result;
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(vi.mocked(console.warn).mock.calls.map(([line]) => String(line).match(/in (\d+)ms/)?.[1]))
      .toEqual(["2500", "4500", "8500", "16500"]);
  });

  it.each(["5", "Thu, 08 Oct 2026 00:00:05 GMT"])("honors Retry-After %s", async (value) => {
    vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": value } }))
      .mockResolvedValueOnce(Response.json({ status: "ready" }));
    vi.stubGlobal("fetch", fetch);
    const result = api("/prepare", init);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ status: "ready" });
  });

  it("fails instead of retrying earlier than a long Retry-After", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 429, headers: { "Retry-After": "120" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(api("/prepare", init)).rejects.toThrow("failed after 1 attempt(s) (HTTP 429)");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries a broken response body but does not retry invalid JSON", async () => {
    const broken = new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("terminated")); } }));
    const fetch = vi.fn().mockResolvedValueOnce(broken).mockResolvedValueOnce(Response.json({ audio: "wav" }))
      .mockResolvedValueOnce(new Response("private invalid JSON"));
    vi.stubGlobal("fetch", fetch);
    const result = api("/audio/1", init);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ audio: "wav" });
    await expect(api("/prepare", init)).rejects.toThrow("failed after 1 attempt(s) (response error)");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
