import { describe, it, expect } from 'vitest';
import { formatClock } from '../time-format';

const MIN = 60_000;

describe('formatClock', () => {
  it('shows mm:ss below an hour', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(45 * MIN + 12_000)).toBe('45:12');
  });

  it('shows h:mm:ss at an hour and beyond', () => {
    expect(formatClock(65 * MIN + 30_000)).toBe('1:05:30');
    expect(formatClock(2 * 60 * MIN)).toBe('2:00:00');
  });

  it('treats negative input as zero', () => {
    expect(formatClock(-1)).toBe('00:00');
  });
});
