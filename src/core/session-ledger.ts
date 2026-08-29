import type { KeyValueStore } from "../adapters/storage";

export type SessionLedgerStatus =
  | "RECORDING"
  | "INTERRUPTED"
  | "STOPPED"
  | "DONE"
  | "FAILED";

export interface SessionLedgerEntry {
  sessionId: string;
  meetingCode: string;
  tabId: number;
  startedAtMs: number;
  status: SessionLedgerStatus;
  totalChunks: number;
  bytesTotal: number;
}

const INDEX_KEY = "sessionLedgerIndex";

function entryKey(sessionId: string): string {
  return `sessionLedger:${sessionId}`;
}

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
      status: "RECORDING",
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

  async setStatus(
    sessionId: string,
    status: SessionLedgerStatus,
  ): Promise<void> {
    const entry = await this.get(sessionId);
    if (!entry) return;
    await this.store.set<SessionLedgerEntry>(entryKey(sessionId), {
      ...entry,
      status,
    });
  }

  /** Currently unused (was called by the now-reverted crash-recovery pass to overwrite the ledger's count with what's actually on disk after a crash). Kept for when that pass is reimplemented. */
  async setChunkCount(
    sessionId: string,
    totalChunks: number,
    bytesTotal: number,
  ): Promise<void> {
    const entry = await this.get(sessionId);
    if (!entry) return;
    await this.store.set<SessionLedgerEntry>(entryKey(sessionId), {
      ...entry,
      totalChunks,
      bytesTotal,
    });
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
