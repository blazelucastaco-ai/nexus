export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms before the first retry (default: 1000) */
  baseDelay?: number;
  /** Maximum delay cap in ms (default: 30000) */
  maxDelay?: number;
  /** Called before each retry with the error and upcoming attempt number */
  onRetry?: (error: Error, attempt: number) => void;
}

/**
 * Execute an async function with exponential backoff and jitter.
 *
 * The delay for attempt `n` is: min(maxDelay, baseDelay * 2^n) * random(0.5, 1)
 *
 * @param fn - The async function to retry
 * @param options - Retry configuration
 * @returns The resolved value of `fn`
 * @throws The last error if all retries are exhausted
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30_000,
    onRetry,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === maxRetries) {
        break;
      }

      onRetry?.(lastError, attempt + 1);

      // Exponential backoff: baseDelay * 2^attempt, capped at maxDelay
      const exponentialDelay = baseDelay * Math.pow(2, attempt);
      const cappedDelay = Math.min(maxDelay, exponentialDelay);
      // Add jitter: random value between 50% and 100% of the computed delay
      const jitteredDelay = cappedDelay * (0.5 + Math.random() * 0.5);

      await sleep(jitteredDelay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
