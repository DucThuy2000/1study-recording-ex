import type { KeyValueStore } from '../adapters/storage';

export type SessionLedgerStatus = 'RECORDING' | 'INTERRUPTED' | 'STOPPED' | 'DONE' | 'FAILED';

export interface SessionLedgerEntry {
  sessionId: string;
  meetingCode: string;
  tabId: number;
  startedAtMs: number;
  status: SessionLedgerStatus;
  totalChunks: number;
  bytesTotal: number;
}

const INDEX_KEY = 'sessionLedgerIndex';

function entryKey(sessionId: string): string {
  return `sessionLedger:${sessionId}`;
}

/**
 * Durable registry of every recording session's local footprint, independent
 * of ActiveSessionInfo (background's single-slot "what's recording right
 * now"). Task 2's disk-backlog math sums over this — every session with
 * local chunks still on disk, not just the current one. Also designed to
 * support a future crash-recovery reconciliation pass (enumerate sessions
 * left mid-flight after a browser restart, compare against real OPFS
 * contents) — that pass was implemented once and then deliberately reverted
 * pending a redesign; see git history around 2026-08-28 for the prior
 * attempt (`src/core/crash-recovery.ts`, `src/adapters/opfs.ts`, removed).
 *
 * One storage key per session plus a separate index array, not one big
 * `sessions: {...}` object (see this plan's Global Constraints) — this
 * prevents *different* sessions' writes from ever clobbering each other,
 * since each has its own key.
 *
 * It does NOT prevent a same-session race between offscreen's recordChunk()
 * and background's setStatus()/setChunkCount() on that one session's key —
 * that cross-process read-modify-write race is real and was explicitly
 * accepted rather than fixed (a `recordChunk()` racing a `setStatus()` can
 * revert a status change or undercount by one chunk's bytes). It was
 * expected to self-heal on the next full browser restart via a
 * crash-recovery reconciliation pass — with that pass currently reverted
 * (see above), nothing corrects this drift right now. Low practical
 * severity (worst case: one chunk's bytes/status stays stale until the
 * ledger entry is next touched), but worth remembering when crash-recovery
 * comes back.
 *
 * recordChunk() itself is called once per ~5s chunk from a single producer
 * (MediaRecorder's ondataavailable, strictly sequential by construction) —
 * unlike EventReporter's report(), there's no scenario where two
 * recordChunk() calls land in the same tick, so no promise-tail
 * serialization is needed for THAT specific concern.
 */
export class SessionLedger {
  constructor(private readonly store: KeyValueStore) {}

  private async readIndex(): Promise<string[]> {
    return (await this.store.get<string[]>(INDEX_KEY)) ?? [];
  }

  private async addToIndex(sessionId: string): Promise<void> {
    const index = await this.readIndex();
    if (!index.includes(sessionId)) {
      index.push(sessionId);
      await this.store.set(INDEX_KEY, index);
    }
  }

  async start(entry: {
    sessionId: string;
    meetingCode: string;
    tabId: number;
    startedAtMs: number;
  }): Promise<void> {
    await this.store.set<SessionLedgerEntry>(entryKey(entry.sessionId), {
      ...entry,
      status: 'RECORDING',
      totalChunks: 0,
      bytesTotal: 0,
    });
    await this.addToIndex(entry.sessionId);
  }

  async recordChunk(sessionId: string, chunkBytes: number): Promise<void> {
    const entry = await this.get(sessionId);
    if (!entry) return;
    await this.store.set<SessionLedgerEntry>(entryKey(sessionId), {
      ...entry,
      totalChunks: entry.totalChunks + 1,
      bytesTotal: entry.bytesTotal + chunkBytes,
    });
  }

  async setStatus(sessionId: string, status: SessionLedgerStatus): Promise<void> {
    const entry = await this.get(sessionId);
    if (!entry) return;
    await this.store.set<SessionLedgerEntry>(entryKey(sessionId), { ...entry, status });
  }

  /** Currently unused (was called by the now-reverted crash-recovery pass to overwrite the ledger's count with what's actually on disk after a crash). Kept for when that pass is reimplemented. */
  async setChunkCount(sessionId: string, totalChunks: number, bytesTotal: number): Promise<void> {
    const entry = await this.get(sessionId);
    if (!entry) return;
    await this.store.set<SessionLedgerEntry>(entryKey(sessionId), { ...entry, totalChunks, bytesTotal });
  }

  async get(sessionId: string): Promise<SessionLedgerEntry | undefined> {
    return this.store.get<SessionLedgerEntry>(entryKey(sessionId));
  }

  async list(): Promise<SessionLedgerEntry[]> {
    const index = await this.readIndex();
    const entries = await Promise.all(index.map((id) => this.get(id)));
    return entries.filter((e): e is SessionLedgerEntry => e !== undefined);
  }
}
