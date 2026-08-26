import { describe, it, expect } from 'vitest';
import { StallDetector } from '../stall-detector';

function makeClock(startMs = 0) {
  let now = startMs;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('StallDetector', () => {
  it('reports no stall while frames keep arriving within the threshold', () => {
    const clock = makeClock();
    const detector = new StallDetector(3000, clock.now);
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      expect(detector.onFrame()).toBeUndefined();
    }
  });

  it('checkForStall reports STALLED once the gap exceeds the threshold', () => {
    const clock = makeClock();
    const detector = new StallDetector(3000, clock.now);
    detector.onFrame();
    clock.advance(3500);
    const event = detector.checkForStall();
    expect(event).toEqual({ type: 'STALLED', gapMs: 3500, atMs: 3500 });
  });

  it('does not re-report STALLED on a subsequent check while still stalled', () => {
    const clock = makeClock();
    const detector = new StallDetector(3000, clock.now);
    detector.onFrame();
    clock.advance(3500);
    detector.checkForStall();
    clock.advance(1000);
    expect(detector.checkForStall()).toBeUndefined();
  });

  it('onFrame reports RECOVERED the first time a frame arrives after a stall', () => {
    const clock = makeClock();
    const detector = new StallDetector(3000, clock.now);
    detector.onFrame();
    clock.advance(3500);
    detector.checkForStall();
    clock.advance(100);
    expect(detector.onFrame()).toEqual({ type: 'RECOVERED', atMs: 3600 });
  });
});
