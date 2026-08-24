export type RetryOptions = {
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response): number {
  const value = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value * 1000, MAX_DELAY_MS) : 0;
}

function transient(response: Response): boolean {
  return response.status === 429 || response.status >= 500 ||
    (response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'));
}

export async function fetchWithRetry(url: string | URL, init: RequestInit = {}, options: RetryOptions = {}): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!transient(response) || attempt === retries) return response;
      const delay = Math.min(Math.max(retryAfterMs(response), baseDelayMs * (attempt + 1)), MAX_DELAY_MS);
      await sleep(delay);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(Math.min(baseDelayMs * (attempt + 1), MAX_DELAY_MS));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error('fetch failed after retries');
}
