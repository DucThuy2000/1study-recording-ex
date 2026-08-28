import { describe, it, expect } from 'vitest';
import { evaluateStorageGuard, sumBacklogBytes, formatBytes } from '../storage-guard';
import type { SessionLedgerEntry } from '../session-ledger';
import { CONFIG } from '../../shared/config';

function entry(overrides: Partial<SessionLedgerEntry> = {}): SessionLedgerEntry {
  return {
    sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 0,
    status: 'RECORDING', totalChunks: 1, bytesTotal: 1000,
    ...overrides,
  };
}

describe('evaluateStorageGuard', () => {
  it('allows when both free space and backlog are within bounds', () => {
    expect(evaluateStorageGuard(CONFIG.DISK_MIN_FREE_BYTES + 1, 0)).toEqual({ allowed: true });
  });

  it('blocks on low free space before checking backlog (R10 takes priority)', () => {
    const outcome = evaluateStorageGuard(CONFIG.DISK_MIN_FREE_BYTES - 1, 0);
    expect(outcome).toEqual({ allowed: false, reason: 'LOW_DISK', freeBytes: CONFIG.DISK_MIN_FREE_BYTES - 1 });
  });

  it('blocks on backlog over the cap when free space is fine', () => {
    const outcome = evaluateStorageGuard(CONFIG.DISK_MIN_FREE_BYTES + 1, CONFIG.BACKLOG_MAX_BYTES + 1);
    expect(outcome).toEqual({ allowed: false, reason: 'BACKLOG_HIGH', backlogBytes: CONFIG.BACKLOG_MAX_BYTES + 1 });
  });

  it('reports LOW_DISK, not BACKLOG_HIGH, when both are bad', () => {
    const outcome = evaluateStorageGuard(0, CONFIG.BACKLOG_MAX_BYTES + 1);
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.reason).toBe('LOW_DISK');
  });
});

describe('sumBacklogBytes', () => {
  it('sums bytesTotal across sessions not yet DONE', () => {
    const sessions = [
      entry({ sessionId: 'a', status: 'RECORDING', bytesTotal: 1000 }),
      entry({ sessionId: 'b', status: 'INTERRUPTED', bytesTotal: 2000 }),
      entry({ sessionId: 'c', status: 'DONE', bytesTotal: 5000 }),
    ];
    expect(sumBacklogBytes(sessions)).toBe(3000);
  });
});

describe('formatBytes', () => {
  it('formats GB above 1 GB and MB below', () => {
    expect(formatBytes(3.2 * 1024 ** 3)).toBe('3.2 GB');
    expect(formatBytes(500 * 1024 ** 2)).toBe('500 MB');
  });
});
