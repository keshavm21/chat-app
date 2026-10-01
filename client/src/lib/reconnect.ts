// client/src/lib/reconnect.ts
// Socket.io reconnects by itself after a lost connection, but not after the server refuses
// the handshake in its middleware: it gives the socket up (socket.active turns false). A
// refusal that says "Authentication" means the session is gone, and the page logs out.
// Any other (the server could not reach its database) is temporary, so the page retries
// it with this, and the tab comes back online without a reload.
// Framework-free, so client/test/reconnect.test.js can run it under `node --test`.

export interface RetryOptions {
  /** The first delay, doubled for each further attempt. */
  baseMs?: number;
  /** The longest delay. */
  maxMs?: number;
  /** A number in [0, 1), for the jitter. */
  random?: () => number;
}

/**
 * The delay before retry number `attempt` (1, 2, …): baseMs doubled each time, up to maxMs,
 * then 25 % either way at random, so tabs that failed together do not retry together.
 */
export function retryDelay(attempt: number, { baseMs = 1000, maxMs = 30_000, random = Math.random }: RetryOptions = {}): number {
  const delay = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(delay * (0.75 + random() * 0.5));
}

/** Whether a connect_error means the session is gone (the server says "Authentication error: …"). */
export function isAuthenticationError(message: string): boolean {
  return message.toLowerCase().includes('authentication');
}

/**
 * Calls `connect` again after refused handshakes. schedule() after each refusal (it
 * replaces a retry still pending and backs off further), reset() once connected, and
 * stop() when the page goes away, after which nothing is scheduled any more.
 */
export function createHandshakeRetry(connect: () => void, options: RetryOptions = {}) {
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  return {
    /** Schedules the next attempt and returns its delay, or undefined once stopped. */
    schedule(): number | undefined {
      if (stopped) return undefined;
      cancel();
      attempt += 1;
      const delay = retryDelay(attempt, options);
      timer = setTimeout(() => {
        timer = undefined;
        connect();
      }, delay);
      return delay;
    },
    reset(): void {
      attempt = 0;
      cancel();
    },
    stop(): void {
      stopped = true;
      cancel();
    },
  };
}
