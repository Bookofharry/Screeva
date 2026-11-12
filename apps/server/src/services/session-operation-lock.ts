export class SessionOperationLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    }
  }

  isBusy(sessionId: string): boolean {
    return this.tails.has(sessionId);
  }

  async tryRun<T>(sessionId: string, operation: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
    if (this.tails.has(sessionId)) return { acquired: false };
    let release: (() => void) | undefined;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(sessionId, current);
    try {
      return { acquired: true, value: await operation() };
    } finally {
      release?.();
      if (this.tails.get(sessionId) === current) this.tails.delete(sessionId);
    }
  }
}
