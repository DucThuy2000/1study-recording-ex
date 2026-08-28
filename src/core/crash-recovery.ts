import type { SessionLedgerEntry } from './session-ledger';

export interface ReconciliationAction {
  sessionId: string;
  markInterrupted: boolean;
  correctedTotalChunks?: number;
  correctedBytesTotal?: number;
  integrityMismatch: boolean;
}

/**
 * Pure decision logic for the onStartup scan. `actualSizes` is what's really
 * on disk for a session (from OpfsInspector, with zero-size/corrupt files
 * already excluded by the caller) — the ledger's own counters are what
 * background *believed* happened, and can lag or overshoot if Chrome died
 * mid-session before a write's STORAGE_SET message reached it.
 */
export function reconcileSession(
  entry: SessionLedgerEntry,
  actualSizes: readonly number[],
): ReconciliationAction {
  const actualTotal = actualSizes.reduce((sum, s) => sum + s, 0);
  const mismatch = actualSizes.length !== entry.totalChunks || actualTotal !== entry.bytesTotal;
  return {
    sessionId: entry.sessionId,
    markInterrupted: entry.status === 'RECORDING',
    correctedTotalChunks: mismatch ? actualSizes.length : undefined,
    correctedBytesTotal: mismatch ? actualTotal : undefined,
    integrityMismatch: mismatch,
  };
}

/**
 * Only sessions left mid-flight when Chrome died need a look — DONE, FAILED,
 * INTERRUPTED and STOPPED were already settled before this restart. STOPPED
 * in particular means the recorder finished cleanly and its download already
 * succeeded (locally complete) before Chrome ever went down; it just hasn't
 * been uploaded yet, which is a Phase 2 concern, not a reconciliation one.
 */
export function sessionsNeedingReconciliation(
  entries: readonly SessionLedgerEntry[],
): SessionLedgerEntry[] {
  return entries.filter((e) => e.status === 'RECORDING');
}
