export type StallEvent = { type: 'STALLED'; gapMs: number; atMs: number } | { type: 'RECOVERED'; atMs: number };

export class StallDetector {
  private lastFrameAtMs: number;
  private stalled = false;

  constructor(
    private readonly stallThresholdMs: number,
    private readonly now: () => number,
  ) {
    this.lastFrameAtMs = now();
  }

  /** Call every time a real frame arrives (e.g. from requestVideoFrameCallback). */
  onFrame(): StallEvent | undefined {
    const at = this.now();
    this.lastFrameAtMs = at;
    if (this.stalled) {
      this.stalled = false;
      return { type: 'RECOVERED', atMs: at };
    }
    return undefined;
  }

  /** Call on a periodic tick independent of frame arrival, to catch a stall in progress. */
  checkForStall(): StallEvent | undefined {
    const at = this.now();
    const gapMs = at - this.lastFrameAtMs;
    if (!this.stalled && gapMs >= this.stallThresholdMs) {
      this.stalled = true;
      return { type: 'STALLED', gapMs, atMs: at };
    }
    return undefined;
  }
}
