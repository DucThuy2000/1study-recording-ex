# Meet Recorder Extension — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local recording durable — a session's local footprint is tracked and enumerable (not just the single "current" session), starting a new class is refused before it can run the disk into the danger zone (R9/R10), an OPFS write failure degrades to a bounded in-memory buffer instead of losing chunks (R12), and a Chrome crash mid-class is detected and reconciled against what's actually on disk the next time Chrome starts (spec Task 1.4).

**Architecture:** Four additive layers on top of the Phase 0 recording pipeline, all pure/testable core logic plus thin `chrome.*`-touching wiring, following the same Adapter/Strategy split as Phase 0:
- `SessionLedger` (`src/core/session-ledger.ts`) — a durable, enumerable registry of every session's local footprint, replacing the single-slot `ActiveSessionInfo` as the source of truth for "what's on disk right now."
- `evaluateStorageGuard` (`src/core/storage-guard.ts`) — pure preflight/mid-session disk-space and backlog decision, wired into `handleStart()` (blocking) and an offscreen-side periodic check (warn-only, R12).
- `MemoryChunkBuffer` (`src/core/chunk-buffer.ts`) — the one documented exception to R1, a hard-capped RAM fallback `SessionRecorder` switches into once OPFS itself is judged broken (`InvalidStateError`).
- `reconcileSession` (`src/core/crash-recovery.ts`) + `RealOpfsInspector` (`src/adapters/opfs.ts`) — on `chrome.runtime.onStartup`, compares the ledger's belief about each unfinished session against what's actually in OPFS and corrects it.

**Tech Stack:** Same as Phase 0 — TypeScript `strict: true`, WXT, Vitest, npm. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-26-meet-recorder-extension-design.md` (PHASE 1, Tasks 1.1 through 1.4). Task 1.1's OPFS chunk-writing mechanics were already built in Phase 0 (`src/offscreen-logic/chunk-writer.ts`) — this plan finishes 1.1's other half, the metadata ledger, and builds 1.2–1.4 in full.

**Architecture doc:** `docs/superpowers/flowchart/v1.md` documents the Phase 0 system as built — read it for the existing message-routing model and file responsibilities before touching any entrypoint.

## Global Constraints

Everything in Phase 0's plan still applies (file naming by domain not by single export, test files live in a `test/` subfolder of the directory they test, `defineBackground`/`defineContentScript` need explicit imports because `imports: false`, `noUncheckedIndexedAccess`/`verbatimModuleSyntax` are on, strict TS/no `any`/constructor injection/no magic numbers/leveled logger only). This plan adds:

- **R9/R10 (disk):** `CONFIG.DISK_MIN_FREE_BYTES` (3GB) blocks a *new* recording at the preflight guard; `CONFIG.BACKLOG_MAX_BYTES` (5GB) blocks a new recording once un-cleaned local sessions exceed it. Both already exist in `src/shared/config.ts` from Phase 0 — no threshold changes needed (see the size-math note below).
- **R12 mid-session:** once a class is `RECORDING`, nothing built in this plan may stop it. Disk and OPFS-failure conditions are warn-only (banner + event) once recording has started; only the *preflight* guard in `handleStart()` may refuse to begin.
- **R1's documented exception:** `MemoryChunkBuffer` is the only place allowed to hold multiple chunks in RAM at once, and only after OPFS has already failed with `InvalidStateError` for this session — it is hard-capped at `CONFIG.MEMORY_BUFFER_MAX_BYTES` (200MB, already in config) and never re-attempts OPFS mid-session (one-way fallback, keeps the design simple).
- **Size math (informs why the existing thresholds need no change):** HIGH tier (1.8Mbps video + 64kbps audio) ≈ 14MB/min ≈ 840MB for a 60-minute class; MID ≈ 570MB; LOW ≈ 300MB. The sibling `1study-recording` server's ffmpeg step is a stream-copy remux (`-c:a copy -c:v copy`, no re-encoding) — the local recording's byte size *is* what ends up on S3, so Phase 1's disk math must not assume any later shrinkage.
- **Deviation from the spec's literal sketch:** spec 1.1 sketches session metadata as one object `sessions: { [sessionId]: {...} }` under a single storage key. This plan uses one storage key per session (`sessionLedger:<id>`) plus a separate index key (`sessionLedgerIndex: string[]`) instead, because Phase 0 already established that `chrome.storage` writes from two different contexts (background and offscreen) can land back-to-back — an index of independent keys means two sessions' records can never clobber each other on a shared read-modify-write, which a single big object would risk. Same reasoning as Phase 0's own documented deviation on folder structure: the behavior the spec wants is unchanged, only the storage shape differs.

---

## File Structure

```
1study-recording-ex/
  src/
    core/
      session-ledger.ts          NEW  SessionLedger, SessionLedgerEntry           [Task 1]
      test/session-ledger.test.ts NEW                                             [Task 1]
      storage-guard.ts           NEW  evaluateStorageGuard, sumBacklogBytes, formatBytes [Task 2]
      test/storage-guard.test.ts NEW                                              [Task 2]
      chunk-buffer.ts            NEW  MemoryChunkBuffer                           [Task 3]
      test/chunk-buffer.test.ts  NEW                                              [Task 3]
      crash-recovery.ts          NEW  reconcileSession, sessionsNeedingReconciliation [Task 4]
      test/crash-recovery.test.ts NEW                                             [Task 4]
    adapters/
      opfs.ts                    NEW  OpfsInspector, RealOpfsInspector            [Task 4]
    offscreen-logic/
      chunk-writer.ts            MODIFY  extract ChunkWriterLike interface        [Task 3]
      recorder.ts                MODIFY  onChunkWritten callback (Task 1), memory fallback (Task 3)
    shared/
      config.ts                  MODIFY  + DISK_CHECK_INTERVAL_MS                 [Task 2]
      messages.ts                MODIFY  + STORAGE_ALERT, + GuardFailureReason members [Task 2]
  entrypoints/
    background.ts                MODIFY  SessionLedger wiring (1), storage guard (2), onStartup recovery (4)
    offscreen/main.ts            MODIFY  SessionLedger wiring (1), periodic disk check (2), onStorageDegraded (3)
    content.ts                   MODIFY  STORAGE_ALERT banner                     [Task 2]
    popup/main.ts                MODIFY  STORAGE_ALERT no-op case, LOW_DISK/BACKLOG_HIGH copy [Task 2]
```

---

### Task 1: Session Ledger (spec Task 1.1's remaining half)

**Files:**
- Create: `src/core/session-ledger.ts`, `src/core/test/session-ledger.test.ts`
- Modify: `src/offscreen-logic/recorder.ts` (add `onChunkWritten` callback)
- Modify: `entrypoints/background.ts` (instantiate ledger, call `start()`/`setStatus()`)
- Modify: `entrypoints/offscreen/main.ts` (instantiate ledger, wire `onChunkWritten`)

**Interfaces:**
- Consumes: `KeyValueStore` (`src/adapters/storage.ts`, Phase 0) — works with both `ChromeStorageAdapter` (background) and `MessagingStorageAdapter` (offscreen) unchanged.
- Produces: `SessionLedger` with `start(entry)`, `recordChunk(sessionId, bytes)`, `setStatus(sessionId, status)`, `setChunkCount(sessionId, totalChunks, bytesTotal)`, `get(sessionId)`, `list()`. `SessionLedgerEntry`, `SessionLedgerStatus` types — used by Tasks 2 and 4.
- Produces (recorder.ts): `SessionRecorderCallbacks` interface with `onChunkWritten?: (index: number, bytes: number) => void` — Task 3 adds a second member to this same interface.

- [ ] **Step 1: Write the failing test**

Create `src/core/test/session-ledger.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SessionLedger } from '../session-ledger';
import { InMemoryStore } from '../../adapters/storage';

describe('SessionLedger', () => {
  it('starts a session with zeroed counters', async () => {
    const ledger = new SessionLedger(new InMemoryStore());
    await ledger.start({ sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 1000 });
    expect(await ledger.get('s1')).toEqual({
      sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 1000,
      status: 'RECORDING', totalChunks: 0, bytesTotal: 0,
    });
  });

  it('accumulates chunk counts and bytes', async () => {
    const ledger = new SessionLedger(new InMemoryStore());
    await ledger.start({ sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 0 });
    await ledger.recordChunk('s1', 1000);
    await ledger.recordChunk('s1', 2000);
    const entry = await ledger.get('s1');
    expect(entry?.totalChunks).toBe(2);
    expect(entry?.bytesTotal).toBe(3000);
  });

  it('recordChunk on an unknown session is a no-op', async () => {
    const ledger = new SessionLedger(new InMemoryStore());
    await expect(ledger.recordChunk('missing', 100)).resolves.toBeUndefined();
    expect(await ledger.get('missing')).toBeUndefined();
  });

  it('updates status without touching counters', async () => {
    const ledger = new SessionLedger(new InMemoryStore());
    await ledger.start({ sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 0 });
    await ledger.recordChunk('s1', 500);
    await ledger.setStatus('s1', 'DONE');
    const entry = await ledger.get('s1');
    expect(entry?.status).toBe('DONE');
    expect(entry?.bytesTotal).toBe(500);
  });

  it('lists every started session', async () => {
    const ledger = new SessionLedger(new InMemoryStore());
    await ledger.start({ sessionId: 's1', meetingCode: 'a', tabId: 1, startedAtMs: 0 });
    await ledger.start({ sessionId: 's2', meetingCode: 'b', tabId: 2, startedAtMs: 1 });
    const all = await ledger.list();
    expect(all.map((e) => e.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('setChunkCount overwrites totals directly (crash-recovery reconciliation)', async () => {
    const ledger = new SessionLedger(new InMemoryStore());
    await ledger.start({ sessionId: 's1', meetingCode: 'a', tabId: 1, startedAtMs: 0 });
    await ledger.recordChunk('s1', 500);
    await ledger.setChunkCount('s1', 3, 9000);
    const entry = await ledger.get('s1');
    expect(entry?.totalChunks).toBe(3);
    expect(entry?.bytesTotal).toBe(9000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/test/session-ledger.test.ts`
Expected: FAIL — `../session-ledger` has no exported member `SessionLedger`.

- [ ] **Step 3: Implement**

Create `src/core/session-ledger.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/test/session-ledger.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add the `onChunkWritten` callback to `SessionRecorder`**

In `src/offscreen-logic/recorder.ts`, add the callbacks interface and thread it through the constructor and `ondataavailable`:

```ts
export interface SessionRecorderCallbacks {
  onChunkWritten?: (index: number, bytes: number) => void;
}

export class SessionRecorder {
  private mediaRecorder: MediaRecorder | undefined;
  private readonly writer: ChunkWriter;
  private readonly pendingWrites: Promise<void>[] = [];

  constructor(
    private readonly sessionId: string,
    private readonly stream: MediaStream,
    private readonly tier: TierName,
    private readonly callbacks: SessionRecorderCallbacks = {},
  ) {
    this.writer = new ChunkWriter(sessionId);
  }

  start(): void {
    const tierConfig = CONFIG.TIERS[this.tier];
    const mimeType = pickMimeType(tierConfig.codecs);
    this.mediaRecorder = new MediaRecorder(this.stream, {
      mimeType,
      videoBitsPerSecond: tierConfig.bitrate,
      audioBitsPerSecond: CONFIG.AUDIO_BITRATE,
    });
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      const bytes = event.data.size;
      const write = this.writer.write(event.data).then(
        (index) => {
          this.callbacks.onChunkWritten?.(index, bytes);
        },
        (error: unknown) => {
          logger.error("chunk write failed", { error: String(error) });
        },
      );
      this.pendingWrites.push(write);
    };
    this.mediaRecorder.start(CONFIG.CHUNK_MS);
    logger.info("recording started", {
      sessionId: this.sessionId,
      mimeType,
      tier: this.tier,
    });
  }

  // stop() unchanged in this task — Task 3 modifies it.
}
```

(Leave `stop()` exactly as it is in the current file — Task 3 rewrites it.)

- [ ] **Step 6: Wire the ledger into `entrypoints/background.ts`**

Add the import and module-scope instance near the other adapters:

```ts
import { SessionLedger } from "@/src/core/session-ledger";
```

```ts
const sessionLedger = new SessionLedger(store);
```

In `handleStart()`, right where `writeActiveSession({...STARTING...})` is called (inside the `try` block, after `getMediaStreamId` succeeds), add a ledger entry. The meeting code is safe to non-null-assert here — `guard.allowed` above already proved `extractMeetingCode(tab.url ?? '')` is non-null:

```ts
    const sessionId = makeSessionId();
    try {
      const streamId = await tabCapture.getMediaStreamId(message.tabId);
      await writeActiveSession({
        sessionId,
        tabId: message.tabId,
        status: "STARTING",
        startedAtMs: Date.now(),
      });
      await sessionLedger.start({
        sessionId,
        meetingCode: extractMeetingCode(tab.url ?? "")!,
        tabId: message.tabId,
        startedAtMs: Date.now(),
      });
      await offscreen.ensureDocument(
        "/offscreen.html",
        ["USER_MEDIA"],
        "Recording the class session tab for teaching quality review.",
      );
      await broadcast({ type: "RECORDING_STARTED", sessionId, streamId });
      logger.info("start dispatched", { sessionId, tabId: message.tabId });
    } catch (error) {
      const detail = describeError(error);
      await writeActiveSession(null);
      await sessionLedger.setStatus(sessionId, "FAILED");
      await writeLastError(detail);
      logger.error("start failed", { sessionId, error: detail });
      await refuseStart("START_FAILED", detail);
    }
```

In `handleRecordingState()`, forward terminal states to the ledger. Add this right after the existing `if (message.state === "FAILED") { ... }` block's closing brace, before the trailing "FINALIZING and the rest are informational" comment:

```ts
  if (message.state === "FINALIZING" || message.state === "DONE") {
    await sessionLedger.setStatus(message.sessionId, message.state);
  }
```

(The existing `if (message.state === "FAILED")` block already exists above this — add `await sessionLedger.setStatus(message.sessionId, "FAILED");` as its first line, right after the `logger.error(...)` call.)

- [ ] **Step 7: Wire the ledger into `entrypoints/offscreen/main.ts`**

Add the import and module-scope instance:

```ts
import { SessionLedger } from "@/src/core/session-ledger";
```

```ts
const sessionLedger = new SessionLedger(new MessagingStorageAdapter());
```

In `startRecording()`, pass the callback when constructing the recorder:

```ts
    activeRecorder = new SessionRecorder(sessionId, mixedStream, tier, {
      onChunkWritten: (_index, bytes) => {
        void sessionLedger.recordChunk(sessionId, bytes);
      },
    });
    activeRecorder.start();
```

- [ ] **Step 8: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean, no errors.

- [ ] **Step 9: Commit**

```bash
git add src/core/session-ledger.ts src/core/test/session-ledger.test.ts \
        src/offscreen-logic/recorder.ts \
        entrypoints/background.ts entrypoints/offscreen/main.ts
git commit -m "feat: add SessionLedger tracking every session's local chunk footprint"
```

---

### Task 2: Disk & Backlog Guard (spec Task 1.2, R9/R10)

**Files:**
- Create: `src/core/storage-guard.ts`, `src/core/test/storage-guard.test.ts`
- Modify: `src/shared/config.ts` (+ `DISK_CHECK_INTERVAL_MS`)
- Modify: `src/shared/messages.ts` (+ `STORAGE_ALERT`, + `GuardFailureReason` members)
- Modify: `entrypoints/background.ts` (preflight block in `handleStart()`)
- Modify: `entrypoints/offscreen/main.ts` (periodic mid-session check)
- Modify: `entrypoints/content.ts` (banner)
- Modify: `entrypoints/popup/main.ts` (no-op case + copy)

**Interfaces:**
- Consumes: `SessionLedger.list()` (Task 1), `CONFIG.DISK_MIN_FREE_BYTES` / `CONFIG.BACKLOG_MAX_BYTES` (Phase 0, unchanged).
- Produces: `evaluateStorageGuard(freeBytes, backlogBytes): StorageGuardOutcome`, `sumBacklogBytes(entries): number`, `formatBytes(bytes): string` — used by both background (preflight) and offscreen (periodic check).

- [ ] **Step 1: Write the failing test**

Create `src/core/test/storage-guard.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/test/storage-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/core/storage-guard.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/test/storage-guard.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add config and message types**

In `src/shared/config.ts`, add to `CONFIG`:

```ts
  DISK_CHECK_INTERVAL_MS: 60_000,
```

In `src/shared/messages.ts`, add two members to `GuardFailureReason`:

```ts
export type GuardFailureReason =
  | 'NOT_MEET_TAB'
  | 'MEETING_CODE_MISMATCH'
  | 'ALREADY_RECORDING'
  | 'START_FAILED'
  | 'MIC_PERMISSION_DENIED'
  | 'MIC_PERMISSION_NEEDED'
  | 'LOW_DISK'
  | 'BACKLOG_HIGH';
```

Add a new message to the `Message` union (near `AUDIO_ALERT`/`VIDEO_STALLED`). `'OPFS_ERROR'` is pre-declared in the reason union now, unused until Task 3 — same precedent as Phase 0's `RecordingEvent` type pre-declaring event types before the task that produces them existed:

```ts
  // offscreen → background (the popup receives the same broadcast and renders it)
  | { type: 'STORAGE_ALERT'; low: boolean; reason?: 'LOW_DISK' | 'BACKLOG_HIGH' | 'OPFS_ERROR' }
```

- [ ] **Step 6: Wire the preflight guard into `entrypoints/background.ts`**

Add imports:

```ts
import { evaluateStorageGuard, sumBacklogBytes, formatBytes } from "@/src/core/storage-guard";
```

In `handleStart()`, insert this block right after the tab/meeting-code guard (`if (!guard.allowed) { ... return; }`) and before the mic-permission check:

```ts
  const { quota, usage } = await navigator.storage.estimate();
  const freeBytes = (quota ?? 0) - (usage ?? 0);
  const backlogBytes = sumBacklogBytes(await sessionLedger.list());
  const storageGuard = evaluateStorageGuard(freeBytes, backlogBytes);
  if (!storageGuard.allowed) {
    await refuseStart(
      storageGuard.reason,
      storageGuard.reason === "LOW_DISK"
        ? `Chỉ còn ${formatBytes(storageGuard.freeBytes)} trống — cần tối thiểu ${formatBytes(CONFIG.DISK_MIN_FREE_BYTES)} để bắt đầu ghi.`
        : `Bản ghi cũ tồn đọng ${formatBytes(storageGuard.backlogBytes)} chưa dọn — tạm dừng ghi mới cho tới khi được tải lên.`,
    );
    return;
  }
```

Add `STORAGE_ALERT` to the existing fan-out case bucket in the `onMessage` listener:

```ts
        case "AUDIO_ALERT":
        case "VIDEO_STALLED":
        case "VIDEO_RECOVERED":
        case "STORAGE_ALERT":
          run(fanOutToRecordedTab(message), "alert fan-out");
          return false;
```

- [ ] **Step 7: Wire the periodic mid-session check into `entrypoints/offscreen/main.ts`**

Add a module-scope handle next to the other per-session handles:

```ts
let storageCheckIntervalId: ReturnType<typeof setInterval> | undefined;
let storageAlerting = false;
```

Add the import:

```ts
import { evaluateStorageGuard, sumBacklogBytes } from "@/src/core/storage-guard";
```

In `startRecording()`, after the existing `micMonitor.start(); tabMonitor.start();` lines, start the periodic check. R12: this only ever notifies + reports, never stops recording:

```ts
    storageCheckIntervalId = setInterval(() => {
      void (async () => {
        const { quota, usage } = await navigator.storage.estimate();
        const freeBytes = (quota ?? 0) - (usage ?? 0);
        const backlogBytes = sumBacklogBytes(await sessionLedger.list());
        const outcome = evaluateStorageGuard(freeBytes, backlogBytes);
        const wasAlerting = storageAlerting;
        storageAlerting = !outcome.allowed;
        if (storageAlerting === wasAlerting) return;
        if (outcome.allowed) {
          await notify({ type: "STORAGE_ALERT", low: false });
          return;
        }
        await reportEvent(
          outcome.reason,
          outcome.reason === "LOW_DISK" ? { freeBytes: outcome.freeBytes } : { backlogBytes: outcome.backlogBytes },
        );
        await notify({ type: "STORAGE_ALERT", low: true, reason: outcome.reason });
      })();
    }, CONFIG.DISK_CHECK_INTERVAL_MS);
```

In `releaseSessionHandles()`, add cleanup next to the other `stop*`/interval cleanups:

```ts
  if (storageCheckIntervalId !== undefined) clearInterval(storageCheckIntervalId);
  storageCheckIntervalId = undefined;
  storageAlerting = false;
```

Add `STORAGE_ALERT` to the `onMessage` switch's "never received, offscreen only emits this" bucket (same bucket that already lists `AUDIO_ALERT`/`VIDEO_STALLED`/`VIDEO_RECOVERED`):

```ts
      case "AUDIO_ALERT":
      case "VIDEO_STALLED":
      case "VIDEO_RECOVERED":
      case "STORAGE_ALERT":
      case "RECORDING_ACTIVE":
      case "GUARD_RESULT":
        return false;
```

- [ ] **Step 8: Banner in `entrypoints/content.ts`**

Add a case to the message switch, alongside the existing `AUDIO_ALERT`/`VIDEO_STALLED` cases:

```ts
        case "STORAGE_ALERT":
          if (message.low) {
            showBanner(
              message.reason === "LOW_DISK"
                ? "⚠ Ổ đĩa sắp đầy — bản ghi có thể bị mất nếu không giải phóng dung lượng"
                : message.reason === "BACKLOG_HIGH"
                  ? "⚠ Dữ liệu cũ tồn đọng quá nhiều — hãy mở Chrome để tự động tải lên"
                  : "⚠ Lỗi lưu trữ — bản ghi đang chuyển sang bộ nhớ tạm",
            );
          } else {
            hideBanner();
          }
          return;
```

- [ ] **Step 9: Popup copy and exhaustiveness in `entrypoints/popup/main.ts`**

In `guardFailureText()`, add two cases before `case undefined:`:

```ts
    case "LOW_DISK":
      return "Ổ đĩa sắp đầy — cần giải phóng dung lượng trước khi ghi.";
    case "BACKLOG_HIGH":
      return "Bản ghi cũ tồn đọng quá nhiều, chưa được tải lên — mở Chrome để tự động tải lên rồi thử lại.";
```

In the `onMessage` switch's "addressed to others" bucket, add `STORAGE_ALERT`:

```ts
    case "AUDIO_ALERT":
    case "VIDEO_STALLED":
    case "VIDEO_RECOVERED":
    case "STORAGE_ALERT":
    case "RECORDING_ACTIVE":
      return;
```

- [ ] **Step 10: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/core/storage-guard.ts src/core/test/storage-guard.test.ts \
        src/shared/config.ts src/shared/messages.ts \
        entrypoints/background.ts entrypoints/offscreen/main.ts \
        entrypoints/content.ts entrypoints/popup/main.ts
git commit -m "feat: block new recordings on low disk/high backlog, warn mid-session (R9/R10/R12)"
```

- [ ] **Step 12: Manual test (chrome.storage.estimate can't be forced from Vitest)**

1. Temporarily lower `CONFIG.DISK_MIN_FREE_BYTES` to something above your machine's actual free space (or fill disk with scratch files) → click Start → popup should show the LOW_DISK message and refuse to start. Restore the constant afterward.
2. Start a recording normally, then confirm mid-session: recording keeps running even if you simulate the same low-disk condition (R12 — never stops an active recording, only bannered).
3. Confirm the banner clears (`STORAGE_ALERT low:false`) once conditions recover.

---

### Task 3: OPFS Failure Hardening + Memory Fallback (spec Task 1.3)

**Files:**
- Create: `src/core/chunk-buffer.ts`, `src/core/test/chunk-buffer.test.ts`
- Modify: `src/offscreen-logic/chunk-writer.ts` (extract `ChunkWriterLike` interface)
- Modify: `src/offscreen-logic/recorder.ts` (memory fallback, DI'd writer)
- Modify: `entrypoints/offscreen/main.ts` (wire `onStorageDegraded`)

**Interfaces:**
- Consumes: `SessionRecorderCallbacks` (Task 1) — this task adds a second member, `onStorageDegraded`.
- Consumes: `STORAGE_ALERT`'s `reason: 'OPFS_ERROR'` arm (Task 2, pre-declared, unused until now).
- Produces: `MemoryChunkBuffer` with `push(index, blob): boolean`, `getDroppedIndices(): readonly number[]`, `readAll(): readonly BufferedChunk[]`.
- Produces: `ChunkWriterLike` interface (`write`, `readAll`) — lets `SessionRecorder` accept a fake writer in tests.

- [ ] **Step 1: Write the failing test**

Create `src/core/test/chunk-buffer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MemoryChunkBuffer } from '../chunk-buffer';

function blob(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

describe('MemoryChunkBuffer', () => {
  it('accepts chunks under the cap', () => {
    const buf = new MemoryChunkBuffer(1000);
    expect(buf.push(0, blob(400))).toBe(true);
    expect(buf.push(1, blob(400))).toBe(true);
    expect(buf.readAll().map((c) => c.index)).toEqual([0, 1]);
  });

  it('drops chunks that would exceed the cap and records their index', () => {
    const buf = new MemoryChunkBuffer(1000);
    buf.push(0, blob(700));
    expect(buf.push(1, blob(700))).toBe(false);
    expect(buf.getDroppedIndices()).toEqual([1]);
    expect(buf.readAll().map((c) => c.index)).toEqual([0]);
  });

  it('keeps accepting later chunks that individually still fit after a drop', () => {
    const buf = new MemoryChunkBuffer(1000);
    buf.push(0, blob(700));
    buf.push(1, blob(700));
    expect(buf.push(2, blob(200))).toBe(true);
    expect(buf.readAll().map((c) => c.index)).toEqual([0, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/test/chunk-buffer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `MemoryChunkBuffer`**

Create `src/core/chunk-buffer.ts`:

```ts
export interface BufferedChunk {
  index: number;
  blob: Blob;
}

/**
 * Last-resort in-memory chunk holding pen for when OPFS itself has failed
 * mid-session (R12: the class keeps recording, it just stops trying to touch
 * a broken filesystem). Hard-capped — this is deliberately the one place in
 * the codebase allowed to hold multiple chunks in RAM (R1 exists to prevent
 * exactly this in the *normal* path; this is the documented exception for
 * the abnormal one).
 */
export class MemoryChunkBuffer {
  private readonly chunks: BufferedChunk[] = [];
  private bytesUsed = 0;
  private readonly droppedIndices: number[] = [];

  constructor(private readonly maxBytes: number) {}

  /** Returns false (and records the index as dropped) if the chunk would exceed the cap. */
  push(index: number, blob: Blob): boolean {
    if (this.bytesUsed + blob.size > this.maxBytes) {
      this.droppedIndices.push(index);
      return false;
    }
    this.chunks.push({ index, blob });
    this.bytesUsed += blob.size;
    return true;
  }

  getDroppedIndices(): readonly number[] {
    return this.droppedIndices;
  }

  readAll(): readonly BufferedChunk[] {
    return this.chunks;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/test/chunk-buffer.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Extract `ChunkWriterLike` from `src/offscreen-logic/chunk-writer.ts`**

Add the interface and have the class implement it — no behavior change:

```ts
export interface ChunkWriterLike {
  write(blob: Blob): Promise<number>;
  readAll(): Promise<ReadAllResult>;
}

export class ChunkWriter implements ChunkWriterLike {
  // body unchanged
}
```

- [ ] **Step 6: Rewrite `SessionRecorder` in `src/offscreen-logic/recorder.ts`** for DI + memory fallback

Full replacement of the file's class body (imports change too):

```ts
import { pickMimeType, CONFIG, type TierName } from "../shared/config";
import { ChunkWriter, type ChunkWriterLike } from "./chunk-writer";
import { MemoryChunkBuffer } from "../core/chunk-buffer";
import { createLogger } from "../core/logger";

const logger = createLogger("recorder");

export interface RecordingResult {
  blob: Blob;
  /** Chunks absent from `blob` entirely — either an OPFS write that failed for a reason other than InvalidStateError, or a chunk the memory-buffer cap had to drop. */
  missingChunkIndices: number[];
}

export interface SessionRecorderCallbacks {
  onChunkWritten?: (index: number, bytes: number) => void;
  /** Fired once, the moment OPFS is judged unrecoverable for the rest of this session. Never fired more than once — the fallback is one-way. */
  onStorageDegraded?: (error: unknown) => void;
}

export class SessionRecorder {
  private mediaRecorder: MediaRecorder | undefined;
  private readonly writer: ChunkWriterLike;
  private readonly pendingWrites: Promise<void>[] = [];
  private readonly memoryBuffer: MemoryChunkBuffer;
  private storageMode: "opfs" | "memory" = "opfs";

  constructor(
    private readonly sessionId: string,
    private readonly stream: MediaStream,
    private readonly tier: TierName,
    private readonly callbacks: SessionRecorderCallbacks = {},
    writer: ChunkWriterLike = new ChunkWriter(sessionId),
  ) {
    this.writer = writer;
    this.memoryBuffer = new MemoryChunkBuffer(CONFIG.MEMORY_BUFFER_MAX_BYTES);
  }

  start(): void {
    const tierConfig = CONFIG.TIERS[this.tier];
    const mimeType = pickMimeType(tierConfig.codecs);
    this.mediaRecorder = new MediaRecorder(this.stream, {
      mimeType,
      videoBitsPerSecond: tierConfig.bitrate,
      audioBitsPerSecond: CONFIG.AUDIO_BITRATE,
    });
    let nextIndex = 0;
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      const index = nextIndex++;
      const bytes = event.data.size;

      if (this.storageMode === "memory") {
        this.memoryBuffer.push(index, event.data);
        return;
      }

      const write = this.writer.write(event.data).then(
        () => {
          this.callbacks.onChunkWritten?.(index, bytes);
        },
        (error: unknown) => {
          logger.error("chunk write failed", { error: String(error) });
          // InvalidStateError: a documented, still-open Chromium bug near
          // zero free space. Retrying it every 5s for the rest of a
          // 60-minute class would just fail the same way each time — fall
          // back to the memory buffer instead, once, and stay there
          // (R12: keep recording, never stop for a storage failure).
          if (error instanceof DOMException && error.name === "InvalidStateError") {
            this.storageMode = "memory";
            this.callbacks.onStorageDegraded?.(error);
            this.memoryBuffer.push(index, event.data);
          }
        },
      );
      this.pendingWrites.push(write);
    };
    this.mediaRecorder.start(CONFIG.CHUNK_MS);
    logger.info("recording started", {
      sessionId: this.sessionId,
      mimeType,
      tier: this.tier,
    });
  }

  async stop(): Promise<RecordingResult> {
    const recorder = this.mediaRecorder;
    if (!recorder) throw new Error("recorder not started");
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    await Promise.all(this.pendingWrites);

    const { blob: opfsBlob, missingIndices } = await this.writer.readAll();
    const memoryChunks = this.memoryBuffer.readAll();
    // A chunk whose OPFS write triggered the fallback is *also* pushed into
    // the memory buffer (see the InvalidStateError branch above) — its bytes
    // did land in the final blob via that path, so it must not double-count
    // as missing just because OPFS itself has no file for it.
    const memoryIndices = new Set(memoryChunks.map((c) => c.index));
    const missingChunkIndices = [
      ...missingIndices.filter((i) => !memoryIndices.has(i)),
      ...this.memoryBuffer.getDroppedIndices(),
    ].sort((a, b) => a - b);

    if (missingChunkIndices.length > 0) {
      logger.error("chunks missing from the finished recording", {
        sessionId: this.sessionId,
        missingChunkIndices,
      });
    }

    const blob = new Blob([opfsBlob, ...memoryChunks.map((c) => c.blob)], { type: "video/webm" });
    return { blob, missingChunkIndices };
  }
}
```

- [ ] **Step 7: Wire `onStorageDegraded` in `entrypoints/offscreen/main.ts`**

In `startRecording()`, extend the callbacks object already passed to `SessionRecorder` (from Task 1):

```ts
    activeRecorder = new SessionRecorder(sessionId, mixedStream, tier, {
      onChunkWritten: (_index, bytes) => {
        void sessionLedger.recordChunk(sessionId, bytes);
      },
      onStorageDegraded: (error) => {
        void reportEvent("OPFS_ERROR", { sessionId, error: String(error) });
        void notify({ type: "STORAGE_ALERT", low: true, reason: "OPFS_ERROR" });
      },
    });
    activeRecorder.start();
```

- [ ] **Step 8: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 9: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass (existing Phase 0 suite + this task's new tests).

- [ ] **Step 10: Commit**

```bash
git add src/core/chunk-buffer.ts src/core/test/chunk-buffer.test.ts \
        src/offscreen-logic/chunk-writer.ts src/offscreen-logic/recorder.ts \
        entrypoints/offscreen/main.ts
git commit -m "feat: fall back to a capped in-memory chunk buffer when OPFS fails (R1 exception, R12)"
```

- [ ] **Step 11: Manual test (InvalidStateError can't be forced from Vitest)**

`InvalidStateError` from OPFS is hard to trigger naturally — mock it: temporarily edit `ChunkWriter.write()` to `throw new DOMException('forced', 'InvalidStateError')` after e.g. the 3rd call, run a real recording, confirm: (a) recording keeps running past that point (R12), (b) the in-tab banner shows the OPFS-error message, (c) the final downloaded file still has audio/video for the whole session (memory-buffered tail included), (d) revert the temporary edit afterward.

---

### Task 4: Crash Recovery + Integrity Reconciliation (spec Task 1.4)

**Files:**
- Create: `src/core/crash-recovery.ts`, `src/core/test/crash-recovery.test.ts`
- Create: `src/adapters/opfs.ts`
- Modify: `entrypoints/background.ts` (`chrome.runtime.onStartup` listener)

**Interfaces:**
- Consumes: `SessionLedger` (Task 1), `EventReporter`/`EventBus` (Phase 0).
- Produces: `reconcileSession(entry, actualSizes): ReconciliationAction`, `sessionsNeedingReconciliation(entries): SessionLedgerEntry[]`.
- Produces: `OpfsInspector` interface + `RealOpfsInspector` — `listChunkSizes(sessionId): Promise<number[]>`.

- [ ] **Step 1: Write the failing test**

Create `src/core/test/crash-recovery.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/test/crash-recovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/core/crash-recovery.ts`:

```ts
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
    markInterrupted: entry.status === 'RECORDING' || entry.status === 'FINALIZING',
    correctedTotalChunks: mismatch ? actualSizes.length : undefined,
    correctedBytesTotal: mismatch ? actualTotal : undefined,
    integrityMismatch: mismatch,
  };
}

/** Only sessions left mid-flight when Chrome died need a look — DONE/FAILED/INTERRUPTED were already settled before this restart. */
export function sessionsNeedingReconciliation(
  entries: readonly SessionLedgerEntry[],
): SessionLedgerEntry[] {
  return entries.filter((e) => e.status === 'RECORDING' || e.status === 'FINALIZING');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/test/crash-recovery.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Implement `OpfsInspector`**

Create `src/adapters/opfs.ts`. Deliberately avoids `for await...of` on `FileSystemDirectoryHandle.entries()` — this project's `lib` array (`.wxt/tsconfig.json`, generated) includes `DOM.Iterable` but not `DOM.AsyncIterable`, so async iteration wouldn't typecheck. Sequential probing by index instead, mirroring `ChunkWriter`'s own naming convention exactly — chunks are never sparse (no gaps mid-sequence), so the first missing index is genuinely the end of what's on disk:

```ts
export interface OpfsInspector {
  /** Sizes (bytes) of a session's chunk files in order, probed sequentially by index. Empty array if the session directory doesn't exist. */
  listChunkSizes(sessionId: string): Promise<number[]>;
}

export class RealOpfsInspector implements OpfsInspector {
  async listChunkSizes(sessionId: string): Promise<number[]> {
    try {
      const root = await navigator.storage.getDirectory();
      const sessions = await root.getDirectoryHandle('sessions');
      const dir = await sessions.getDirectoryHandle(sessionId);
      const sizes: number[] = [];
      for (let i = 0; ; i++) {
        const name = `chunk_${String(i).padStart(5, '0')}.webm`;
        try {
          const handle = await dir.getFileHandle(name);
          const file = await handle.getFile();
          sizes.push(file.size);
        } catch {
          break;
        }
      }
      return sizes;
    } catch {
      return [];
    }
  }
}
```

(No test file for this adapter — it touches real OPFS, same precedent as `ChunkWriter` itself in Phase 0, which also has no Vitest coverage. Covered by this task's manual test below instead.)

- [ ] **Step 6: Wire the `onStartup` listener into `entrypoints/background.ts`**

Add imports:

```ts
import { RealOpfsInspector } from "@/src/adapters/opfs";
import { reconcileSession, sessionsNeedingReconciliation } from "@/src/core/crash-recovery";
import { EventReporter } from "@/src/core/event-reporter";
import { EventBus } from "@/src/core/event-bus";
import type { RecordingEvent } from "@/src/core/event-reporter";
```

Add module-scope instances next to the existing `store`/`sessionLedger`:

```ts
const opfsInspector = new RealOpfsInspector();
const backgroundEventReporter = new EventReporter(store, new EventBus<{ event: RecordingEvent }>(), logger);
```

Add the reconciliation function and register it, inside `defineBackground(() => { ... })` alongside the other listener registrations:

```ts
async function reconcileAfterRestart(): Promise<void> {
  const stale = sessionsNeedingReconciliation(await sessionLedger.list());
  for (const entry of stale) {
    const sizes = (await opfsInspector.listChunkSizes(entry.sessionId)).filter((s) => s > 0);
    const action = reconcileSession(entry, sizes);
    if (action.integrityMismatch) {
      await sessionLedger.setChunkCount(
        entry.sessionId,
        action.correctedTotalChunks!,
        action.correctedBytesTotal!,
      );
      await backgroundEventReporter.report("OPFS_ERROR", {
        sessionId: entry.sessionId,
        reason: "ledger_mismatch_after_restart",
        ledgerChunks: entry.totalChunks,
        actualChunks: action.correctedTotalChunks,
      });
    }
    if (action.markInterrupted) {
      await sessionLedger.setStatus(entry.sessionId, "INTERRUPTED");
    }
    logger.warn("reconciled session after restart", { sessionId: entry.sessionId, ...action });
  }
  // A STARTING/RECORDING ActiveSessionInfo left over from before the crash
  // is definitely stale — nothing is listening on the other end any more.
  if (await readActiveSession()) {
    await writeActiveSession(null);
  }
}
```

```ts
  browser.runtime.onStartup.addListener(() => {
    run(reconcileAfterRestart(), "crash recovery");
  });
```

- [ ] **Step 7: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 8: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/core/crash-recovery.ts src/core/test/crash-recovery.test.ts \
        src/adapters/opfs.ts entrypoints/background.ts
git commit -m "feat: reconcile the session ledger against real OPFS contents on browser restart (spec Task 1.4)"
```

- [ ] **Step 10: Manual test**

`chrome.runtime.onStartup` only fires on a full browser relaunch, not an extension reload — this must be a real quit+reopen, matching the spec's own literal test:

1. Start a recording, let it run ~2 minutes (a few chunks land).
2. Fully quit Chrome (Cmd+Q on macOS, or kill it via Activity Monitor/Task Manager) — do not close just the tab or window.
3. Reopen Chrome. Do not open Meet or touch the extension.
4. Open the offscreen document's chunk directory (see `docs/superpowers/flowchart/v1.md` or ask for the DevTools OPFS-browsing steps) — confirm the chunk files from step 1 are still there, untouched.
5. Check `chrome://extensions` → service worker logs for `"reconciled session after restart"` — confirm the session was marked `INTERRUPTED`.
6. Confirm a fresh Start on a new Meet tab works normally afterward (the stale `ActiveSessionInfo` didn't brick anything).

---

## Phase Gate

Per the spec's own working rule ("Không chuyển phase khi chưa qua cổng phase"), Phase 2 does not start until all 4 tasks above are green — tsc clean, full Vitest suite passing, and every manual test in Tasks 2/3/4 actually run and confirmed. Phase 2's plan will be written once this gate passes.
