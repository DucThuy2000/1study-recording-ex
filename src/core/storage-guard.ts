import { CONFIG } from '../shared/config';
import type { SessionLedgerEntry } from './session-ledger';

export type StorageGuardOutcome =
  | { allowed: true }
  | { allowed: false; reason: 'LOW_DISK'; freeBytes: number }
  | { allowed: false; reason: 'BACKLOG_HIGH'; backlogBytes: number };

/**
 * R10 first: a near-full disk risks a still-open Chromium bug wiping OPFS
 * outright (even with unlimitedStorage), which is worse than merely
 * blocking a new class — so free-space is checked ahead of the backlog cap.
 */
export function evaluateStorageGuard(freeBytes: number, backlogBytes: number): StorageGuardOutcome {
  if (freeBytes < CONFIG.DISK_MIN_FREE_BYTES) return { allowed: false, reason: 'LOW_DISK', freeBytes };
  if (backlogBytes > CONFIG.BACKLOG_MAX_BYTES) return { allowed: false, reason: 'BACKLOG_HIGH', backlogBytes };
  return { allowed: true };
}

/**
 * DONE means already uploaded and locally cleaned (Phase 2) — excluded so a
 * finished, cleaned-up session never counts against a future backlog check.
 * Every other status still has local chunks on disk.
 */
export function sumBacklogBytes(sessions: readonly SessionLedgerEntry[]): number {
  return sessions.filter((s) => s.status !== 'DONE').reduce((sum, s) => sum + s.bytesTotal, 0);
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(0)} MB`;
}
