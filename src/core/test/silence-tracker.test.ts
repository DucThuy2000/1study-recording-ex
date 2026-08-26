import { describe, it, expect } from 'vitest';
import { SilenceTracker } from '../silence-tracker';

describe('SilenceTracker', () => {
  it('does not alert before the threshold is reached', () => {
    const tracker = new SilenceTracker(60, 10);
    for (let i = 0; i < 5; i++) {
      expect(tracker.observe(true)).toBe('NONE');
    }
  });

  it('alerts exactly once when consecutive silence crosses the threshold', () => {
    const tracker = new SilenceTracker(60, 10);
    for (let i = 0; i < 5; i++) tracker.observe(true);
    expect(tracker.observe(true)).toBe('ALERT');
    expect(tracker.observe(true)).toBe('NONE');
  });

  it('reports RECOVERED the first time sound returns after an alert', () => {
    const tracker = new SilenceTracker(60, 10);
    for (let i = 0; i < 6; i++) tracker.observe(true);
    expect(tracker.observe(false)).toBe('RECOVERED');
    expect(tracker.observe(false)).toBe('NONE');
  });

  it('resets the counter on any non-silent observation before the threshold', () => {
    const tracker = new SilenceTracker(60, 10);
    tracker.observe(true);
    tracker.observe(true);
    tracker.observe(false);
    for (let i = 0; i < 5; i++) {
      expect(tracker.observe(true)).toBe('NONE');
    }
  });
});
