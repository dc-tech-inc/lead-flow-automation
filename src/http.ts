export interface RetryOptions {
  /** Retries after the first attempt. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Returns [0,1); injectable so tests are deterministic. */
  random?: () => number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = "HttpError";
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * fetch with a per-attempt timeout and exponential backoff with jitter.
 * Retries network errors, timeouts and 408/425/429/5xx; any other non-2xx throws HttpError at once.
 * Honors Retry-After (capped at maxDelayMs).
 */
export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOptions = {}): Promise<Response> {
  const {
    retries = 3,
    baseDelayMs = 200,
    maxDelayMs = 5_000,
    timeoutMs = 5_000,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    random = Math.random,
  } = opts;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.5 + random() / 2);
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;
      if (!RETRYABLE_STATUS.has(res.status)) throw new HttpError(res.status, url);
      lastError = new HttpError(res.status, url);
      const hinted = retryAfterMs(res);
      if (hinted !== null) delay = Math.min(maxDelayMs, hinted);
    } catch (err) {
      if (err instanceof HttpError && !RETRYABLE_STATUS.has(err.status)) throw err;
      lastError = err; // network error or timeout
    }
    if (attempt < retries) await sleep(delay);
  }
  throw lastError;
}
