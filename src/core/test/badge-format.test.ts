import { describe, it, expect } from 'vitest';
import { formatElapsedBadge, formatClock } from '../badge-format';

const MIN = 60_000;

describe('formatElapsedBadge', () => {
  it('shows whole minutes below an hour', () => {
    expect(formatElapsedBadge(0)).toBe('0m');
    expect(formatElapsedBadge(59_999)).toBe('0m');
    expect(formatElapsedBadge(45 * MIN)).toBe('45m');
    expect(formatElapsedBadge(59 * MIN)).toBe('59m');
  });

  it('switches to hours with zero-padded minutes at an hour', () => {
    expect(formatElapsedBadge(60 * MIN)).toBe('1h00');
    expect(formatElapsedBadge(65 * MIN)).toBe('1h05');
    expect(formatElapsedBadge(150 * MIN)).toBe('2h30');
  });

  it('caps at 9h59 so the text never exceeds four characters', () => {
    expect(formatElapsedBadge(10 * 60 * MIN)).toBe('9h59');
    expect(formatElapsedBadge(99 * 60 * MIN)).toBe('9h59');
  });

  it('treats negative input as zero rather than rendering a minus sign', () => {
    expect(formatElapsedBadge(-5000)).toBe('0m');
  });

  it('never produces more than four characters', () => {
    for (let minutes = 0; minutes <= 700; minutes += 7) {
      expect(formatElapsedBadge(minutes * MIN).length).toBeLessThanOrEqual(4);
    }
  });
});

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
