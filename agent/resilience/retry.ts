type RetryOptions = {
  retries: number;
  initialDelayMs: number;
  factor?: number;
  shouldRetry?: (error: unknown) => boolean;
};

export async function withRetry<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
  const factor = options.factor ?? 2;
  let delay = options.initialDelayMs;
  let attempt = 0;

  while (true) {
    try {
      return await task();
    } catch (error) {
      const canRetry = attempt < options.retries && (options.shouldRetry?.(error) ?? true);
      if (!canRetry) {
        throw error;
      }

      await sleep(delay);
      delay *= factor;
      attempt += 1;
    }
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
