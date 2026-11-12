import { recoveryHeartbeatSchema } from '../../../../packages/shared/src/index.js';

export class SessionActivityRegistry {
  private readonly expires = new Map<string, number>();

  constructor(
    private readonly leaseMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new Error('Invalid activity lease.');
  }

  touch(sessionId: string) {
    const expiresAt = this.now() + this.leaseMs;
    this.expires.set(sessionId, expiresAt);
    return recoveryHeartbeatSchema.parse({ active: true, expiresAt: new Date(expiresAt).toISOString() });
  }

  isActive(sessionId: string): boolean {
    const expiresAt = this.expires.get(sessionId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.expires.delete(sessionId);
      return false;
    }
    return true;
  }

  clear(sessionId: string): void {
    this.expires.delete(sessionId);
  }
}
