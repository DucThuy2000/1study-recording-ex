import type { KeyValueStore } from '../adapters/storage';

export type SessionLedgerStatus = 'RECORDING' | 'INTERRUPTED' | 'FINALIZING' | 'DONE' | 'FAILED';

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
 * now"). Task 2's disk-backlog math sums over this, and Task 4's
 * crash-recovery scan enumerates it on startup — both need every session
 * with local chunks still on disk, not just the current one.
 *
 * One storage key per session plus a separate index array, not one big
 * `sessions: {...}` object (see this plan's Global Constraints) — so a
 * write from background and a write from offscreen can never race on the
 * same key.
 *
 * recordChunk() is called once per ~5s chunk from a single producer
 * (MediaRecorder's ondataavailable, strictly sequential by construction) —
 * unlike EventReporter's report(), there's no scenario where two calls land
 * in the same tick, so no promise-tail serialization is needed here.
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

  /** Task 4 uses this to overwrite the ledger's count with what's actually on disk after a crash. */
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
