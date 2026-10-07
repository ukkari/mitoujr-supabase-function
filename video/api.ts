const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
const networkCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);
const maxRetries = 4;
const maxDelayMs = 60_000;

class HttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number) {
    super(`HTTP ${status}`);
  }
}

function retryAfterMs(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

function isNetworkError(error: unknown): error is Error {
  return error instanceof Error && ["TypeError", "TimeoutError", "AbortError"].includes(error.name);
}

function reason(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (!(error instanceof Error)) return "request error";
  // Only allow known error names/codes into logs, never URLs, headers or response bodies.
  const name = isNetworkError(error) ? error.name : "response error";
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return `${name}${typeof code === "string" && networkCodes.has(code) ? `/${code}` : ""}`;
}

// Only for replayable prepare/audio operations. Publishing retains its separate
// delivery lease/reconciliation logic and must not blindly retry an ambiguous PUT.
export function createVideoApi(endpoint: string, secret: string) {
  return async function api(path: string, init: RequestInit = {}): Promise<any> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetch(endpoint + path, {
          ...init,
          headers: { Authorization: `Bearer ${secret}`, ...init.headers },
          redirect: "error",
          signal: AbortSignal.timeout(240_000),
        });
        if (!response.ok) {
          const error = new HttpError(response.status, retryAfterMs(response.headers.get("Retry-After")));
          await response.body?.cancel().catch(() => {});
          throw error;
        }
        // Reading the body is part of the attempt: connections can fail after headers arrive.
        return await response.json();
      } catch (error) {
        const retryable = error instanceof HttpError ? retryableStatuses.has(error.status) : isNetworkError(error);
        const serverDelay = error instanceof HttpError ? error.retryAfterMs : 0;
        const detail = reason(error);
        // Do not retry earlier than Retry-After, or wait indefinitely on a quota error.
        if (!retryable || attempt >= maxRetries || serverDelay > maxDelayMs) {
          throw new Error(`Video API ${path} failed after ${attempt + 1} attempt(s) (${detail})`);
        }
        const delay = Math.max(2000 * 2 ** attempt + Math.floor(Math.random() * 1000), serverDelay);
        console.warn(`Video API ${path}: ${detail}; retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };
}
