import { describe, it, expect } from 'vitest';
import { reconcileSession, sessionsNeedingReconciliation } from '../crash-recovery';
import type { SessionLedgerEntry } from '../session-ledger';

function entry(overrides: Partial<SessionLedgerEntry> = {}): SessionLedgerEntry {
  return {
    sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 0,
    status: 'RECORDING', totalChunks: 3, bytesTotal: 3000,
    ...overrides,
  };
}

describe('sessionsNeedingReconciliation', () => {
  it('picks only RECORDING and FINALIZING sessions', () => {
    const entries = [
      entry({ sessionId: 'a', status: 'RECORDING' }),
      entry({ sessionId: 'b', status: 'FINALIZING' }),
      entry({ sessionId: 'c', status: 'DONE' }),
      entry({ sessionId: 'd', status: 'FAILED' }),
      entry({ sessionId: 'e', status: 'INTERRUPTED' }),
    ];
    expect(sessionsNeedingReconciliation(entries).map((e) => e.sessionId)).toEqual(['a', 'b']);
  });
});

describe('reconcileSession', () => {
  it('marks a RECORDING session interrupted when counts match', () => {
    const action = reconcileSession(entry({ totalChunks: 2, bytesTotal: 2000 }), [1000, 1000]);
    expect(action).toEqual({
      sessionId: 's1', markInterrupted: true,
      correctedTotalChunks: undefined, correctedBytesTotal: undefined,
      integrityMismatch: false,
    });
  });

  it('flags a mismatch and reports the real numbers when disk disagrees with the ledger', () => {
    const action = reconcileSession(entry({ totalChunks: 5, bytesTotal: 5000 }), [1000, 1000, 1000]);
    expect(action.integrityMismatch).toBe(true);
    expect(action.correctedTotalChunks).toBe(3);
    expect(action.correctedBytesTotal).toBe(3000);
  });

  it('marks a FINALIZING session interrupted too (crashed mid-stop)', () => {
    const action = reconcileSession(entry({ status: 'FINALIZING' }), [1000, 1000, 1000]);
    expect(action.markInterrupted).toBe(true);
  });
});
