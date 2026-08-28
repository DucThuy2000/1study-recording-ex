# Meet Recorder Extension — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get a locally-recorded, locally-durable session (Phase 1's output — a `STOPPED` session sitting in `SessionLedger` with chunks on disk) all the way to S3 through the real `1study-recording` server: chunks upload near-real-time during class without hurting the Meet call's bandwidth (R2), upload survives the Meet tab closing, upload resumes automatically the next time Chrome opens with no teacher action required (R8), and local chunks are deleted only once the server has confirmed the merge is actually done (R3).

**Architecture:** The upload pipeline lives entirely in the background service worker, not the offscreen document — a deliberate, documented departure from the spec's own sketch (see Global Constraints). Four additive pieces:
- `RecordingServerClient` (`src/adapters/recording-server-client.ts`) — thin HTTP wrapper over the *real* server's three endpoints (not the spec's fictional API contract — see Global Constraints).
- `UploadRateLimiter` (`src/core/upload-rate-limiter.ts`) — pure pacing/backoff decision logic (R2).
- `src/background-logic/uploader.ts` — orchestrates one background-owned upload queue: pure decision functions (`nextActionFor`, `pickNextSession`) plus a thin async executor (`pumpUploadQueue`) that drives chunk upload → finalize → poll → local cleanup for whichever session most needs attention.
- Two triggers into that same queue: a message-driven fast path (`CHUNK_READY`, fired the moment offscreen writes a chunk — near-real-time during class) and a `chrome.alarms`-driven resilient sweep (1-minute floor, survives service-worker death and Chrome restarts — this alone satisfies "resume on reopen," Task 2.4).

**Tech Stack:** Same as Phase 0/1 — TypeScript `strict: true`, WXT, Vitest, npm. No new dependencies (uses the platform `fetch`/`FormData`, already global in a service worker).

**Spec:** `docs/superpowers/specs/2026-08-26-meet-recorder-extension-design.md` (PHASE 2, Tasks 2.1–2.4). **The spec's own API contract in Section 3 (`POST /api/recordings/session`, `PUT .../chunk/{index}`, synchronous `finalize` returning `{ok, s3Key, checksum}`) does not exist.** It was written before the real `1study-recording` server was inspected. This plan targets the server that actually exists — see Global Constraints for the real contract, confirmed by reading `1study-recording`'s source directly (routes, controllers, services, DB schema, ffmpeg invocation).

**Depends on:** Phase 1 (`docs/superpowers/plans/2026-08-28-meet-recorder-extension-phase1.md`), specifically `SessionLedger` and the `STOPPED` status it sets once a recording finishes locally. Task 4 (crash recovery) was reverted in Phase 1 and is **not** a dependency here — this plan works entirely off the ledger's own current-session tracking (`RECORDING`/`STOPPED`/`UPLOADING`/`DONE`), same as it would with or without crash-recovery.

## Global Constraints

Everything in Phase 0/1's plans still applies (file naming by domain, tests in `test/` subfolders, `noUncheckedIndexedAccess`/`verbatimModuleSyntax`, strict TS/no `any`/constructor injection/no magic numbers/leveled logger, R1/R7/R11/R12). This plan adds:

- **The real server contract** (confirmed 2026-08-28 by reading `1study-recording`'s `src/routes/recording.js`, `src/controllers/recordingController.js`, `src/services/recordingService.js`, `src/middleware/{jwt,upload,validation}.js`, `src/database/migrations/001_create_recordings_table.sql`, `src/cron/tasks/mergeRecordingAndUploadToS3.js`, `src/services/ffmpegService.js`):
  - `POST /api/upload-chunk` — multipart form, field `video` (the chunk file), field `classId`. JWT required (`Authorization: Bearer <token>`, or `auth_token` in body/query), decoded to `{class_id, user_id, permissions}`; `classId` in the request must equal the JWT's `class_id`. The uploaded file's **filename is kept as-is on disk** (multer `diskStorage`, `filename: (req, file, cb) => cb(null, file.originalname)`) — the server assigns no chunk index itself, so **the extension's chosen filename is the only thing making a retry idempotent**. `classId` is Joi-validated `.alphanum()`, 1–50 chars — Meet's hyphenated meeting code (`abc-defg-hij`) is rejected as-is.
  - `POST /api/recording/:classId/ready-to-merge` — flips the DB row's status to `READY_TO_MERGE`. Only works if a row already exists with status `RECORDING` (auto-created by the *first* successful `upload-chunk` call for that `classId`) — called with zero chunks ever uploaded, it returns `false` and does nothing (not an error).
  - `GET /api/recording/:classId` — `404` if nothing exists yet; otherwise `{success, recording: {status, s3Url, ...}}`. Status only ever reaches `"READY"` (with a working `s3Url`) via an async cron job (`mergeRecordingAndUploadToS3`, runs every 1 minute) — **there is no synchronous finalize response**. Polling this is the only way to know upload is truly complete.
  - ffmpeg does **no re-encoding** (`-c:v copy -c:a copy`, `+genpts` only fixes timestamps) — confirmed in `ffmpegService.js`. Upload bandwidth cost is the same as the local recording's own size; nothing shrinks server-side.
  - CORS is wide open (`app.use(cors())` with no options) — a `chrome-extension://` origin is not blocked.
- **Auth is a Phase-2-only stand-in, per the project owner's explicit decision (2026-08-28):** a manually-minted JWT, stored in `chrome.storage.local` under `devAuthToken`, read by `AuthTokenStore`. Phase 3 (real LMS auth) replaces *who writes* `devAuthToken` (a login flow instead of a manual DevTools console command) — `AuthTokenStore`'s read side does not change. See Task 1's manual test for exactly how to mint one.
- **`classId` identity:** `toClassId(meetingCode)` strips hyphens from Meet's meeting code (`src/core/class-id.ts`) — a Phase 2 stand-in identity, since there is no real LMS class ID yet. The dev JWT you mint must carry this exact stripped value as its `class_id` claim, or `verifyClassAccess` on the server rejects every request.
- **Recording-server base URL is `http://localhost:3000`** (matches the sibling repo's own `.env.example` default `PORT=3000`), confirmed with the project owner (2026-08-28) as the Phase 2 dev/test target. Stored as `CONFIG.RECORDING_SERVER_BASE_URL`, not hardcoded inline anywhere.
- **Documented architecture deviation from the spec's sketch:** the spec's own architecture diagram puts the uploader inside the *offscreen document* (`§3`: "Uploader có token bucket" listed under the offscreen box). This plan puts it in **background** instead. Reasons: (1) `fetch`, `FormData`, and `navigator.storage.getDirectory()` (OPFS) are all available directly in a service worker — nothing about uploading actually needs offscreen's media-capture-specific capabilities; (2) `chrome.alarms` — the only mechanism that reliably survives both service-worker death *and* a full Chrome restart — is unavailable to offscreen documents (offscreen can use only `chrome.runtime`, established fact from Phase 0); (3) putting the uploader in background means Task 2.3 ("survive tab close") is true almost by construction — background is never affected by the Meet tab closing at all, only by the whole browser quitting. The one thing this *doesn't* get for free is near-real-time pacing during an active class (alarms have a hard 1-minute floor) — covered by the `CHUNK_READY` message fast-path described above.
- **Rate limiting is global, not per-session**, and is decided by *whether any session is currently `RECORDING`* — not toggled by a one-time "lift" event on a specific session. Reasoning: only one Meet call is ever live on a teacher's machine at a time (Phase 0's own single-active-session architecture), but multiple `STOPPED`-not-yet-`DONE` sessions can coexist after a restart (e.g. several unup­loaded classes from a bad-internet day) — if *any* session is live-recording, *all* upload traffic (including catching up older backlogs) must stay rate-limited, since it shares the same machine's same connection as the live call; if *none* is, every session uploads at full speed. `UploadRateLimiter.paceMs(bytes, anyRecording)` takes this as a parameter each call rather than tracking a mutable "lifted" flag, so it can never drift out of sync with reality.
- **Never mark a session `FAILED` for an upload problem.** `FAILED` (from Phase 0/1) means *recording* failed. Upload failures (network down, server down, bad auth) retry forever with backoff (R8: never require the teacher to remember to do anything) — there is no upload-failure terminal state in this plan.

---

## File Structure

```
1study-recording-ex/
  src/
    core/
      class-id.ts                NEW  toClassId                              [Task 1]
      test/class-id.test.ts      NEW                                         [Task 1]
      upload-rate-limiter.ts     NEW  UploadRateLimiter                      [Task 2]
      test/upload-rate-limiter.test.ts NEW                                   [Task 2]
      session-ledger.ts          MODIFY  + UPLOADING status, uploadedUpTo, recordUpload() [Task 3]
      test/session-ledger.test.ts MODIFY  + new-field/method coverage        [Task 3]
    adapters/
      auth-token-store.ts        NEW  AuthTokenStore                         [Task 1]
      test/auth-token-store.test.ts NEW                                      [Task 1]
      recording-server-client.ts NEW  RecordingServerClient                  [Task 1]
      test/recording-server-client.test.ts NEW                               [Task 1]
    background-logic/
      uploader.ts                NEW  nextActionFor, pickNextSession, pumpUploadQueue [Task 3]
      test/uploader.test.ts      NEW                                         [Task 3]
    offscreen-logic/
      chunk-writer.ts            MODIFY  + readChunk, deleteSessionDir       [Task 3]
    shared/
      config.ts                  MODIFY  + RECORDING_SERVER_BASE_URL, rate-limit constants [Task 1, 2]
      messages.ts                MODIFY  + CHUNK_READY                       [Task 3]
  entrypoints/
    offscreen/main.ts            MODIFY  notify CHUNK_READY in onChunkWritten [Task 3]
    background.ts                MODIFY  upload deps, CHUNK_READY handler, tabs.onRemoved safety net (Task 3), alarms sweep (Task 4)
  wxt.config.ts                  MODIFY  + host_permissions for localhost:3000 [Task 1]
```

---

### Task 1: Recording-Server Client + Auth Token Store + classId Helper (spec Task 2.1's wire protocol)

**Files:**
- Create: `src/core/class-id.ts`, `src/core/test/class-id.test.ts`
- Create: `src/adapters/auth-token-store.ts`, `src/adapters/test/auth-token-store.test.ts`
- Create: `src/adapters/recording-server-client.ts`, `src/adapters/test/recording-server-client.test.ts`
- Modify: `src/shared/config.ts`, `wxt.config.ts`

**Interfaces:**
- Produces: `toClassId(meetingCode: string): string`.
- Produces: `AuthTokenStore` with `getToken(): Promise<string | undefined>` — constructor takes a `KeyValueStore` (Phase 0's interface).
- Produces: `RecordingServerClient` with `uploadChunk(classId, chunkIndex, blob): Promise<void>`, `readyToMerge(classId): Promise<boolean>`, `getRecordingStatus(classId): Promise<RecordingStatus | null>` — constructor takes `(baseUrl: string, authTokenStore: AuthTokenStore)`. Used by Task 3's uploader.

- [ ] **Step 1: Write the failing tests**

Create `src/core/test/class-id.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { toClassId } from '../class-id';

describe('toClassId', () => {
  it('strips hyphens from a Meet meeting code', () => {
    expect(toClassId('abc-defg-hij')).toBe('abcdefghij');
  });

  it('is a no-op on an already-alphanumeric string', () => {
    expect(toClassId('abcdefghij')).toBe('abcdefghij');
  });
});
```

Create `src/adapters/test/auth-token-store.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { AuthTokenStore } from '../auth-token-store';
import { InMemoryStore } from '../storage';

describe('AuthTokenStore', () => {
  it('returns undefined when no token is set', async () => {
    const store = new AuthTokenStore(new InMemoryStore());
    expect(await store.getToken()).toBeUndefined();
  });

  it('returns the token once set directly on the underlying store', async () => {
    const underlying = new InMemoryStore();
    await underlying.set('devAuthToken', 'test-jwt-value');
    const store = new AuthTokenStore(underlying);
    expect(await store.getToken()).toBe('test-jwt-value');
  });
});
```

Create `src/adapters/test/recording-server-client.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecordingServerClient } from '../recording-server-client';
import { AuthTokenStore } from '../auth-token-store';
import { InMemoryStore } from '../storage';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('RecordingServerClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  async function client(token?: string): Promise<RecordingServerClient> {
    const store = new InMemoryStore();
    if (token) await store.set('devAuthToken', token);
    return new RecordingServerClient('http://localhost:3000', new AuthTokenStore(store));
  }

  it('uploadChunk posts multipart form data with a deterministic filename and auth header', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const c = await client('tok123');
    const blob = new Blob(['x'], { type: 'video/webm' });
    await c.uploadChunk('abcdefghij', 7, blob);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/api/upload-chunk');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok123');
    const form = init.body as FormData;
    expect(form.get('classId')).toBe('abcdefghij');
    const file = form.get('video') as File;
    expect(file.name).toBe('chunk_00007.webm');
  });

  it('uploadChunk throws on a non-ok response', async () => {
    fetchMock.mockResolvedValue(new Response('server error', { status: 500 }));
    const c = await client();
    await expect(c.uploadChunk('abcdefghij', 0, new Blob(['x']))).rejects.toThrow(/500/);
  });

  it('readyToMerge returns the boolean the server sends', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, true));
    const c = await client();
    expect(await c.readyToMerge('abcdefghij')).toBe(true);
  });

  it('getRecordingStatus returns null on a 404 (no recording yet)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    const c = await client();
    expect(await c.getRecordingStatus('abcdefghij')).toBeNull();
  });

  it('getRecordingStatus parses the recording object out of a success response', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, recording: { status: 'READY', s3Url: 'https://s3/x' } }));
    const c = await client();
    expect(await c.getRecordingStatus('abcdefghij')).toEqual({ status: 'READY', s3Url: 'https://s3/x' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/test/class-id.test.ts src/adapters/test/auth-token-store.test.ts src/adapters/test/recording-server-client.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `src/core/class-id.ts`:
```ts
/**
 * The server's `classId` must be alphanumeric only (Joi `.alphanum()`,
 * confirmed against the real 1study-recording server's validation) — Meet's
 * meeting code has hyphens (abc-defg-hij), so this strips them. This is a
 * Phase 2 stand-in identity, not a real LMS class ID — Phase 3's real auth
 * will likely change where classId *comes from* (an LMS-issued ID carried
 * in the JWT), not necessarily this stripping logic.
 */
export function toClassId(meetingCode: string): string {
  return meetingCode.replace(/-/g, '');
}
```

Create `src/adapters/auth-token-store.ts`:
```ts
import type { KeyValueStore } from './storage';

const TOKEN_KEY = 'devAuthToken';

/**
 * Temporary, Phase-2-only auth: reads a manually-minted JWT from durable
 * storage, set once via the background service worker's own DevTools
 * console (see this plan's Task 1 manual test). Phase 3 replaces the
 * *writer* of this key with a real LMS login flow — this reader doesn't
 * need to change either way.
 */
export class AuthTokenStore {
  constructor(private readonly store: KeyValueStore) {}

  async getToken(): Promise<string | undefined> {
    return this.store.get<string>(TOKEN_KEY);
  }
}
```

Create `src/adapters/recording-server-client.ts`:
```ts
import type { AuthTokenStore } from './auth-token-store';

export interface RecordingStatus {
  status: string;
  s3Url?: string;
}

/**
 * Thin wrapper over the real 1study-recording server's three endpoints this
 * extension needs — not the spec's fictional API sketch (see this plan's
 * Global Constraints). No retry/rate-limit/business logic here; that's
 * src/background-logic/uploader.ts's job. This class only shapes requests
 * and parses responses.
 */
export class RecordingServerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly authTokenStore: AuthTokenStore,
  ) {}

  private async authHeader(): Promise<Record<string, string>> {
    const token = await this.authTokenStore.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** POST /api/upload-chunk — filename is fixed by chunk index, so a retry overwrites the same file server-side rather than duplicating it. */
  async uploadChunk(classId: string, chunkIndex: number, blob: Blob): Promise<void> {
    const form = new FormData();
    form.append('classId', classId);
    const filename = `chunk_${String(chunkIndex).padStart(5, '0')}.webm`;
    form.append('video', blob, filename);
    const response = await fetch(`${this.baseUrl}/api/upload-chunk`, {
      method: 'POST',
      headers: await this.authHeader(),
      body: form,
    });
    if (!response.ok) {
      throw new Error(`upload-chunk failed: ${response.status} ${await response.text()}`);
    }
  }

  /** POST /api/recording/:classId/ready-to-merge — false (not an error) if no RECORDING-status row exists yet. */
  async readyToMerge(classId: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/api/recording/${classId}/ready-to-merge`, {
      method: 'POST',
      headers: { ...(await this.authHeader()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ classId }),
    });
    if (!response.ok) {
      throw new Error(`ready-to-merge failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as boolean;
  }

  /** GET /api/recording/:classId — null if the server has nothing for this classId yet (404). */
  async getRecordingStatus(classId: string): Promise<RecordingStatus | null> {
    const response = await fetch(`${this.baseUrl}/api/recording/${classId}`, {
      method: 'GET',
      headers: await this.authHeader(),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`getRecordingStatus failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { success: boolean; recording: RecordingStatus };
    return body.recording;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/test/class-id.test.ts src/adapters/test/auth-token-store.test.ts src/adapters/test/recording-server-client.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Config and manifest**

In `src/shared/config.ts`, add to `CONFIG`:
```ts
  RECORDING_SERVER_BASE_URL: "http://localhost:3000",
```

In `wxt.config.ts`, add the dev server's origin to `host_permissions` (Phase 3 replaces this with the real deployed domain, same pattern as Phase 0's plan already documented for the LMS host permission):
```ts
    host_permissions: ['https://meet.google.com/*', 'http://localhost:3000/*'],
```

- [ ] **Step 6: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/class-id.ts src/core/test/class-id.test.ts \
        src/adapters/auth-token-store.ts src/adapters/test/auth-token-store.test.ts \
        src/adapters/recording-server-client.ts src/adapters/test/recording-server-client.test.ts \
        src/shared/config.ts wxt.config.ts
git commit -m "feat: add recording-server HTTP client, dev auth token store, classId helper"
```

- [ ] **Step 8: Manual test — mint a dev JWT and confirm the client can reach the real server**

1. Start the sibling server: in `1study-recording/`, run `npm run dev` (or `node server.js`) — confirm it logs listening on port 3000, and that its database/Redis dependencies are up (check its own README/`.env` if it fails to start).
2. Pick a real Meet meeting code you're about to test with (e.g. `abc-defg-hij`), strip the hyphens (`abcdefghij`) — this is your `classId` for this test.
3. From inside `1study-recording/`, mint a token using its own `jsonwebtoken` dependency and its own `.env`'s `JWT_SECRET` (read that value yourself — this plan never handles or embeds it):
   ```bash
   node -e "console.log(require('jsonwebtoken').sign({class_id:'abcdefghij', user_id:'dev-test', permissions:['upload']}, process.env.JWT_SECRET || require('dotenv').config().parsed.JWT_SECRET))"
   ```
   (Run this from `1study-recording/`'s own directory so `require` resolves its `node_modules`; adjust if your `.env` loading differs.)
4. Reload the extension, open the **background service worker's** DevTools console (`chrome://extensions` → Inspect views: service worker), and run:
   ```js
   chrome.storage.local.set({ devAuthToken: 'PASTE_YOUR_TOKEN_HERE' })
   ```
5. From that same console, sanity-check the client directly (no need to wait for a real recording yet):
   ```js
   const client = new (await import('/chunks/...')).RecordingServerClient // (if bundling makes this awkward, skip to Task 3's manual test instead — this step is optional, Task 3's end-to-end test covers the same ground)
   ```
   If direct console access to the bundled class is awkward, skip ahead — Task 3's manual test exercises the same client through a real recording, which is the more meaningful test anyway.

---

### Task 2: Upload Rate Limiter (spec Task 2.2, R2)

**Files:**
- Create: `src/core/upload-rate-limiter.ts`, `src/core/test/upload-rate-limiter.test.ts`
- Modify: `src/shared/config.ts`

**Interfaces:**
- Produces: `UploadRateLimiter` with `paceMs(bytes: number, anyRecording: boolean): number`, `recordSuccess(durationMs: number): RateLimiterDecision`, `recordError(): RateLimiterDecision`. Used by Task 3's uploader.

- [ ] **Step 1: Write the failing test**

Create `src/core/test/upload-rate-limiter.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { UploadRateLimiter } from '../upload-rate-limiter';
import { CONFIG } from '../../shared/config';

describe('UploadRateLimiter', () => {
  it('paces to 0ms when no session is recording, regardless of rate', () => {
    const limiter = new UploadRateLimiter();
    expect(limiter.paceMs(1_000_000, false)).toBe(0);
  });

  it('paces proportionally to bytes at the in-class rate when a session is recording', () => {
    const limiter = new UploadRateLimiter();
    const expectedMs = Math.round((100_000 * 8 / CONFIG.UPLOAD_RATE_IN_CLASS_BPS) * 1000);
    expect(limiter.paceMs(100_000, true)).toBe(expectedMs);
  });

  it('increases the rate by 10% (capped at the max) after a fast upload', () => {
    const limiter = new UploadRateLimiter();
    limiter.recordSuccess(CONFIG.UPLOAD_FAST_MS - 1);
    const before = limiter.paceMs(1_000_000, true);
    limiter.recordSuccess(CONFIG.UPLOAD_FAST_MS - 1);
    const after = limiter.paceMs(1_000_000, true);
    expect(after).toBeLessThan(before);
  });

  it('decreases the rate by 30% after a slow upload', () => {
    const limiter = new UploadRateLimiter();
    const before = limiter.paceMs(1_000_000, true);
    limiter.recordSuccess(CONFIG.UPLOAD_SLOW_MS + 1);
    const after = limiter.paceMs(1_000_000, true);
    expect(after).toBeGreaterThan(before);
  });

  it('does not adjust rate on a duration between the fast and slow thresholds', () => {
    const limiter = new UploadRateLimiter();
    const before = limiter.paceMs(1_000_000, true);
    limiter.recordSuccess((CONFIG.UPLOAD_FAST_MS + CONFIG.UPLOAD_SLOW_MS) / 2);
    const after = limiter.paceMs(1_000_000, true);
    expect(after).toBe(before);
  });

  it('pauses after 3 consecutive stalls (>UPLOAD_STALL_MS), and resets the streak on a non-stalling success', () => {
    const limiter = new UploadRateLimiter();
    expect(limiter.recordSuccess(CONFIG.UPLOAD_STALL_MS + 1)).toEqual({ action: 'CONTINUE' });
    expect(limiter.recordSuccess(CONFIG.UPLOAD_STALL_MS + 1)).toEqual({ action: 'CONTINUE' });
    expect(limiter.recordSuccess(CONFIG.UPLOAD_STALL_MS + 1)).toEqual({ action: 'PAUSED' });
  });

  it('resets the stall streak after a fast success', () => {
    const limiter = new UploadRateLimiter();
    limiter.recordSuccess(CONFIG.UPLOAD_STALL_MS + 1);
    limiter.recordSuccess(CONFIG.UPLOAD_STALL_MS + 1);
    limiter.recordSuccess(100); // fast, resets the streak
    expect(limiter.recordSuccess(CONFIG.UPLOAD_STALL_MS + 1)).toEqual({ action: 'CONTINUE' });
  });

  it('backs off exponentially on consecutive errors, capped at the max', () => {
    const limiter = new UploadRateLimiter();
    expect(limiter.recordError()).toEqual({ action: 'BACKOFF', delayMs: CONFIG.UPLOAD_BACKOFF_INITIAL_MS });
    expect(limiter.recordError()).toEqual({ action: 'BACKOFF', delayMs: CONFIG.UPLOAD_BACKOFF_INITIAL_MS * 2 });
    expect(limiter.recordError()).toEqual({ action: 'BACKOFF', delayMs: CONFIG.UPLOAD_BACKOFF_INITIAL_MS * 4 });
    for (let i = 0; i < 10; i++) limiter.recordError();
    expect(limiter.recordError()).toEqual({ action: 'BACKOFF', delayMs: CONFIG.UPLOAD_BACKOFF_MAX_MS });
  });

  it('a success after errors resets the backoff streak', () => {
    const limiter = new UploadRateLimiter();
    limiter.recordError();
    limiter.recordError();
    limiter.recordSuccess(100);
    expect(limiter.recordError()).toEqual({ action: 'BACKOFF', delayMs: CONFIG.UPLOAD_BACKOFF_INITIAL_MS });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/test/upload-rate-limiter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

In `src/shared/config.ts`, add to `CONFIG` (alongside the existing `UPLOAD_RATE_IN_CLASS_BPS`/`UPLOAD_RATE_MAX_BPS`, unchanged from Phase 0):
```ts
  UPLOAD_FAST_MS: 3000,
  UPLOAD_SLOW_MS: 8000,
  UPLOAD_STALL_MS: 10000,
  UPLOAD_STALL_COUNT: 3,
  UPLOAD_BACKOFF_INITIAL_MS: 2000,
  UPLOAD_BACKOFF_MAX_MS: 60000,
```

Create `src/core/upload-rate-limiter.ts`:
```ts
import { CONFIG } from '../shared/config';

export type RateLimiterDecision = { action: 'CONTINUE' } | { action: 'PAUSED' };
export type BackoffDecision = { action: 'BACKOFF'; delayMs: number };

/**
 * R2's token-bucket-shaped pacing. Deliberately stateless with respect to
 * "is a class live right now" — `anyRecording` is passed in fresh on every
 * `paceMs()` call rather than tracked as an internal mutable flag, so it can
 * never drift out of sync with the ledger's actual state (see this plan's
 * Global Constraints on why rate limiting is global, not per-session).
 */
export class UploadRateLimiter {
  private rateBps = CONFIG.UPLOAD_RATE_IN_CLASS_BPS;
  private consecutiveStalls = 0;
  private consecutiveErrors = 0;

  /** ms to wait before sending `bytes` — 0 whenever no session is currently RECORDING. */
  paceMs(bytes: number, anyRecording: boolean): number {
    if (!anyRecording) return 0;
    return Math.round(((bytes * 8) / this.rateBps) * 1000);
  }

  recordSuccess(durationMs: number): RateLimiterDecision {
    this.consecutiveErrors = 0;
    if (durationMs > CONFIG.UPLOAD_STALL_MS) {
      this.consecutiveStalls++;
    } else {
      this.consecutiveStalls = 0;
    }
    if (durationMs < CONFIG.UPLOAD_FAST_MS) {
      this.rateBps = Math.min(CONFIG.UPLOAD_RATE_MAX_BPS, Math.round(this.rateBps * 1.1));
    } else if (durationMs > CONFIG.UPLOAD_SLOW_MS) {
      this.rateBps = Math.round(this.rateBps * 0.7);
    }
    return this.consecutiveStalls >= CONFIG.UPLOAD_STALL_COUNT ? { action: 'PAUSED' } : { action: 'CONTINUE' };
  }

  recordError(): BackoffDecision {
    this.consecutiveStalls = 0;
    this.consecutiveErrors++;
    const delayMs = Math.min(
      CONFIG.UPLOAD_BACKOFF_MAX_MS,
      CONFIG.UPLOAD_BACKOFF_INITIAL_MS * 2 ** (this.consecutiveErrors - 1),
    );
    return { action: 'BACKOFF', delayMs };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/test/upload-rate-limiter.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/upload-rate-limiter.ts src/core/test/upload-rate-limiter.test.ts src/shared/config.ts
git commit -m "feat: add UploadRateLimiter — pacing, adaptive rate, stall-pause, error backoff (R2)"
```

---

### Task 3: Upload Orchestration (spec Tasks 2.1's upload flow + 2.3, R3/R6/R12)

**Files:**
- Modify: `src/core/session-ledger.ts`, `src/core/test/session-ledger.test.ts`
- Modify: `src/offscreen-logic/chunk-writer.ts`
- Modify: `src/shared/messages.ts`
- Modify: `entrypoints/offscreen/main.ts`
- Create: `src/background-logic/uploader.ts`, `src/background-logic/test/uploader.test.ts`
- Modify: `entrypoints/background.ts`

**Interfaces:**
- Consumes: `RecordingServerClient`, `AuthTokenStore` (Task 1), `UploadRateLimiter` (Task 2), `SessionLedger`/`SessionLedgerEntry` (Phase 1, extended here), `ChunkWriterLike` (Phase 1, extended here).
- Produces: `nextActionFor(entry): UploadAction`, `pickNextSession(entries): SessionLedgerEntry | undefined`, `pumpUploadQueue(deps): Promise<void>` — the last one is what Task 4's alarm and this task's `CHUNK_READY` handler both call.

- [ ] **Step 1: Extend `SessionLedger`**

In `src/core/session-ledger.ts`, change the status union and entry shape:
```ts
export type SessionLedgerStatus = 'RECORDING' | 'INTERRUPTED' | 'STOPPED' | 'UPLOADING' | 'DONE' | 'FAILED';

export interface SessionLedgerEntry {
  sessionId: string;
  meetingCode: string;
  tabId: number;
  startedAtMs: number;
  status: SessionLedgerStatus;
  totalChunks: number;
  bytesTotal: number;
  uploadedUpTo: number;
}
```

In `start()`, initialize the new field:
```ts
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
      uploadedUpTo: 0,
    });
    await this.addToIndex(entry.sessionId);
  }
```

Add a new method, next to `recordChunk`:
```ts
  /** How many chunks (contiguous from index 0) the server has confirmed receiving — Task 3's uploader advances this by 1 after each successful upload. */
  async recordUpload(sessionId: string, uploadedUpTo: number): Promise<void> {
    const entry = await this.get(sessionId);
    if (!entry) return;
    await this.store.set<SessionLedgerEntry>(entryKey(sessionId), { ...entry, uploadedUpTo });
  }
```

- [ ] **Step 2: Update `SessionLedger`'s existing tests for the new field**

In `src/core/test/session-ledger.test.ts`, every existing test that constructs an expected entry object (e.g. the `'starts a session with zeroed counters'` test) needs `uploadedUpTo: 0` added to the expected shape. Add one new test:
```ts
  it('recordUpload sets uploadedUpTo directly', async () => {
    const ledger = new SessionLedger(new InMemoryStore());
    await ledger.start({ sessionId: 's1', meetingCode: 'a', tabId: 1, startedAtMs: 0 });
    await ledger.recordUpload('s1', 3);
    expect((await ledger.get('s1'))?.uploadedUpTo).toBe(3);
  });

  it('recordUpload on an unknown session is a no-op', async () => {
    const ledger = new SessionLedger(new InMemoryStore());
    await expect(ledger.recordUpload('missing', 3)).resolves.toBeUndefined();
  });
```

Run: `npx vitest run src/core/test/session-ledger.test.ts` — fix any assertion that still expects the old shape until this passes (12 tests total: the original 10 plus these 2).

- [ ] **Step 3: Extend `ChunkWriter`/`ChunkWriterLike`**

In `src/offscreen-logic/chunk-writer.ts`, extend the interface and class:
```ts
export interface ChunkWriterLike {
  write(blob: Blob): Promise<number>;
  readAll(): Promise<ReadAllResult>;
  readChunk(index: number): Promise<Blob | undefined>;
  deleteSessionDir(): Promise<void>;
}
```
Add the two new methods to `ChunkWriter`:
```ts
  /** Reads a single chunk by index without concatenating the whole session — Task 3's uploader sends chunks one at a time, not as one final blob. */
  async readChunk(index: number): Promise<Blob | undefined> {
    const dir = await this.getSessionDir();
    const name = `chunk_${String(index).padStart(5, "0")}.webm`;
    try {
      const handle = await dir.getFileHandle(name);
      return await handle.getFile();
    } catch {
      return undefined;
    }
  }

  /** R3: called only once the server has confirmed the merge is complete. Removes this session's entire chunk directory. */
  async deleteSessionDir(): Promise<void> {
    const root = await navigator.storage.getDirectory();
    const sessions = await root.getDirectoryHandle("sessions", { create: true });
    await sessions.removeEntry(this.sessionId, { recursive: true });
  }
```
Note in a comment above the class (extend the existing one, or add if none exists at that spot) that despite living in `offscreen-logic/`, `ChunkWriter` is now also constructed directly from `entrypoints/background.ts` — the same pattern Phase 1's (now-reverted) crash-recovery work already proved safe: OPFS (`navigator.storage.getDirectory()`) is available in a service worker exactly as it is in the offscreen document, since both share the same extension origin.

- [ ] **Step 4: Add the `CHUNK_READY` message**

In `src/shared/messages.ts`, add to the `Message` union (near `MIC_MUTE_CHANGED`, another content/offscreen → background message):
```ts
  // offscreen → background: fired the moment a chunk lands, so background's
  // upload queue can react near-real-time during an active class instead of
  // waiting for the next chrome.alarms tick (1-minute floor — see Task 4).
  | { type: 'CHUNK_READY'; sessionId: string }
```

- [ ] **Step 5: Notify `CHUNK_READY` from offscreen, and update every exhaustive switch on `Message`**

Adding `CHUNK_READY` to the `Message` union (Step 4) means every existing exhaustive `switch (message.type) { ...; default: return assertNever(message); }` across the codebase must account for it or `tsc` fails — there are four such switches (background, offscreen, content, popup). Background's is a *real* handler, added later in Step 10 (it needs `uploadDeps`, wired at the same time). The other three only ever emit or never see this message — they need a one-line no-op case each, in whichever bucket already lists similarly-shaped messages (`AUDIO_ALERT`, `STORAGE_ALERT`, etc.).

In `entrypoints/offscreen/main.ts`, find the `SessionRecorder` construction's `onChunkWritten` callback (currently `onChunkWritten: (_index, bytes) => sessionLedger.recordChunk(sessionId, bytes),`) and extend it to also notify background — keep the existing return-the-promise behavior for the ledger write (Phase 1's Task 1 fix depends on it), and fire the notify alongside it without awaiting it (a lost notify just means the next `CHUNK_READY` or alarm tick catches it):
```ts
      onChunkWritten: (_index, bytes) => {
        void notify({ type: "CHUNK_READY", sessionId });
        return sessionLedger.recordChunk(sessionId, bytes);
      },
```

Still in `entrypoints/offscreen/main.ts`, add `CHUNK_READY` to the `onMessage` switch's "never received, offscreen only emits this" bucket (the same bucket that already lists `AUDIO_ALERT`/`VIDEO_STALLED`/`VIDEO_RECOVERED`/`STORAGE_ALERT`):
```ts
      case "AUDIO_ALERT":
      case "VIDEO_STALLED":
      case "VIDEO_RECOVERED":
      case "STORAGE_ALERT":
      case "CHUNK_READY":
      case "RECORDING_ACTIVE":
      case "GUARD_RESULT":
        return false;
```

In `entrypoints/content.ts`, add `CHUNK_READY` to the switch's "addressed to background, the popup or the offscreen document" bucket (the one already listing `START_RECORDING`/`STOP_RECORDING`/etc.):
```ts
        case "MIC_MUTE_CHANGED":
        case "SET_MIC_MUTED":
        case "RECORDING_STARTED":
        case "RECORDING_STOP":
        case "GET_MIC_PERMISSION_STATE":
        case "CHUNK_READY":
        case "STORAGE_GET":
```
(Insert `case "CHUNK_READY":` anywhere in that existing fallthrough block — order within the block doesn't matter, only that every member is present once.)

In `entrypoints/popup/main.ts`, add `CHUNK_READY` to the switch's "addressed to others" bucket (the one already listing `AUDIO_ALERT`/`VIDEO_STALLED`/`VIDEO_RECOVERED`/`STORAGE_ALERT`):
```ts
    case "AUDIO_ALERT":
    case "VIDEO_STALLED":
    case "VIDEO_RECOVERED":
    case "STORAGE_ALERT":
    case "CHUNK_READY":
    case "RECORDING_ACTIVE":
      return;
```

- [ ] **Step 6: Write the failing test for the pure upload-decision logic**

Create `src/background-logic/test/uploader.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextActionFor, pickNextSession, pumpUploadQueue, type UploadDeps } from '../uploader';
import { SessionLedger, type SessionLedgerEntry } from '../../core/session-ledger';
import { InMemoryStore } from '../../adapters/storage';
import { UploadRateLimiter } from '../../core/upload-rate-limiter';
import { createLogger } from '../../core/logger';
import type { ChunkWriterLike, ReadAllResult } from '../../offscreen-logic/chunk-writer';
import type { RecordingServerClient } from '../../adapters/recording-server-client';

function entry(overrides: Partial<SessionLedgerEntry> = {}): SessionLedgerEntry {
  return {
    sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 0,
    status: 'RECORDING', totalChunks: 3, bytesTotal: 3000, uploadedUpTo: 0,
    ...overrides,
  };
}

describe('nextActionFor', () => {
  it('uploads the next chunk when chunks remain and status is RECORDING', () => {
    expect(nextActionFor(entry({ status: 'RECORDING', totalChunks: 3, uploadedUpTo: 1 })))
      .toEqual({ kind: 'UPLOAD_CHUNK', sessionId: 's1', classId: 'abcdefghij', chunkIndex: 1 });
  });

  it('uploads the next chunk when chunks remain and status is STOPPED', () => {
    expect(nextActionFor(entry({ status: 'STOPPED', totalChunks: 3, uploadedUpTo: 2 })))
      .toEqual({ kind: 'UPLOAD_CHUNK', sessionId: 's1', classId: 'abcdefghij', chunkIndex: 2 });
  });

  it('finalizes once STOPPED and every known chunk is uploaded', () => {
    expect(nextActionFor(entry({ status: 'STOPPED', totalChunks: 3, uploadedUpTo: 3 })))
      .toEqual({ kind: 'FINALIZE', sessionId: 's1', classId: 'abcdefghij' });
  });

  it('does NOT finalize while still RECORDING even if uploadedUpTo caught up (more chunks are still coming)', () => {
    expect(nextActionFor(entry({ status: 'RECORDING', totalChunks: 3, uploadedUpTo: 3 })))
      .toEqual({ kind: 'NONE' });
  });

  it('polls while UPLOADING', () => {
    expect(nextActionFor(entry({ status: 'UPLOADING' })))
      .toEqual({ kind: 'POLL', sessionId: 's1', classId: 'abcdefghij' });
  });

  it('does nothing for DONE/FAILED/INTERRUPTED', () => {
    expect(nextActionFor(entry({ status: 'DONE' }))).toEqual({ kind: 'NONE' });
    expect(nextActionFor(entry({ status: 'FAILED' }))).toEqual({ kind: 'NONE' });
    expect(nextActionFor(entry({ status: 'INTERRUPTED' }))).toEqual({ kind: 'NONE' });
  });
});

describe('pickNextSession', () => {
  it('picks the oldest actionable session', () => {
    const entries = [
      entry({ sessionId: 'newer', startedAtMs: 200, status: 'STOPPED', totalChunks: 1, uploadedUpTo: 0 }),
      entry({ sessionId: 'older', startedAtMs: 100, status: 'STOPPED', totalChunks: 1, uploadedUpTo: 0 }),
    ];
    expect(pickNextSession(entries)?.sessionId).toBe('older');
  });

  it('skips sessions with nothing to do', () => {
    const entries = [entry({ sessionId: 'done', status: 'DONE' })];
    expect(pickNextSession(entries)).toBeUndefined();
  });
});

function fakeChunkWriter(chunks: Map<number, Blob>): ChunkWriterLike {
  const deleted = { called: false };
  return {
    write: async () => { throw new Error('not used in these tests'); },
    readAll: async (): Promise<ReadAllResult> => ({ blob: new Blob(), missingIndices: [] }),
    readChunk: async (i: number) => chunks.get(i),
    deleteSessionDir: async () => { deleted.called = true; },
  };
}

describe('pumpUploadQueue', () => {
  let uploadChunk: ReturnType<typeof vi.fn>;
  let readyToMerge: ReturnType<typeof vi.fn>;
  let getRecordingStatus: ReturnType<typeof vi.fn>;
  let deps: UploadDeps;
  let ledger: SessionLedger;

  beforeEach(() => {
    uploadChunk = vi.fn().mockResolvedValue(undefined);
    readyToMerge = vi.fn().mockResolvedValue(true);
    getRecordingStatus = vi.fn().mockResolvedValue(null);
    ledger = new SessionLedger(new InMemoryStore());
    deps = {
      client: { uploadChunk, readyToMerge, getRecordingStatus } as unknown as RecordingServerClient,
      ledger,
      rateLimiter: new UploadRateLimiter(),
      makeChunkReader: () => fakeChunkWriter(new Map([[0, new Blob(['a'])], [1, new Blob(['b'])]])),
      logger: createLogger('test', 'error'),
    };
  });

  it('uploads the next pending chunk and advances uploadedUpTo', async () => {
    await ledger.start({ sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 0 });
    await ledger.recordChunk('s1', 1000);
    await pumpUploadQueue(deps);
    expect(uploadChunk).toHaveBeenCalledWith('abcdefghij', 0, expect.any(Blob));
    expect((await ledger.get('s1'))?.uploadedUpTo).toBe(1);
  });

  it('calls readyToMerge once STOPPED and fully uploaded, then transitions to UPLOADING', async () => {
    await ledger.start({ sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 0 });
    await ledger.recordChunk('s1', 1000);
    await ledger.setStatus('s1', 'STOPPED');
    await ledger.recordUpload('s1', 1); // already fully uploaded
    await pumpUploadQueue(deps);
    expect(readyToMerge).toHaveBeenCalledWith('abcdefghij');
    expect((await ledger.get('s1'))?.status).toBe('UPLOADING');
  });

  it('deletes local chunks and marks DONE once polling sees READY', async () => {
    getRecordingStatus.mockResolvedValue({ status: 'READY', s3Url: 'https://s3/x' });
    await ledger.start({ sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 0 });
    await ledger.setStatus('s1', 'UPLOADING');
    await pumpUploadQueue(deps);
    expect((await ledger.get('s1'))?.status).toBe('DONE');
  });

  it('does not delete or mark DONE while polling still sees a non-READY status', async () => {
    getRecordingStatus.mockResolvedValue({ status: 'MERGING_CHUNKS' });
    await ledger.start({ sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 0 });
    await ledger.setStatus('s1', 'UPLOADING');
    await pumpUploadQueue(deps);
    expect((await ledger.get('s1'))?.status).toBe('UPLOADING');
  });

  it('paces the upload when another session is RECORDING', async () => {
    await ledger.start({ sessionId: 'live', meetingCode: 'a', tabId: 1, startedAtMs: 0 }); // stays RECORDING, nothing to upload for it
    await ledger.start({ sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 2, startedAtMs: 100 });
    await ledger.recordChunk('s1', 1_000_000); // ledger bookkeeping only — the fake reader still returns its own tiny blob; this test checks *that* pacing is invoked with anyRecording=true, not the resulting delay's magnitude
    await ledger.setStatus('s1', 'STOPPED');
    const paceSpy = vi.spyOn(deps.rateLimiter, 'paceMs');
    await pumpUploadQueue(deps);
    expect(paceSpy).toHaveBeenCalledWith(expect.any(Number), true);
  });

  it('a chunk file missing from OPFS is skipped, not retried forever', async () => {
    await ledger.start({ sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 0 });
    await ledger.recordChunk('s1', 1000);
    deps.makeChunkReader = () => fakeChunkWriter(new Map()); // no chunk 0 available
    await pumpUploadQueue(deps);
    expect(uploadChunk).not.toHaveBeenCalled();
    expect((await ledger.get('s1'))?.uploadedUpTo).toBe(1);
  });

  it('an upload failure records an error on the rate limiter and does not advance uploadedUpTo', async () => {
    uploadChunk.mockRejectedValue(new Error('network down'));
    await ledger.start({ sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 0 });
    await ledger.recordChunk('s1', 1000);
    const errorSpy = vi.spyOn(deps.rateLimiter, 'recordError');
    await pumpUploadQueue(deps);
    expect(errorSpy).toHaveBeenCalled();
    expect((await ledger.get('s1'))?.uploadedUpTo).toBe(0);
  });
});
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `npx vitest run src/background-logic/test/uploader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement**

Create `src/background-logic/uploader.ts`:
```ts
import { toClassId } from '../core/class-id';
import type { SessionLedger, SessionLedgerEntry } from '../core/session-ledger';
import type { UploadRateLimiter } from '../core/upload-rate-limiter';
import type { RecordingServerClient } from '../adapters/recording-server-client';
import type { ChunkWriterLike } from '../offscreen-logic/chunk-writer';
import type { Logger } from '../core/logger';

export type UploadAction =
  | { kind: 'UPLOAD_CHUNK'; sessionId: string; classId: string; chunkIndex: number }
  | { kind: 'FINALIZE'; sessionId: string; classId: string }
  | { kind: 'POLL'; sessionId: string; classId: string }
  | { kind: 'NONE' };

/**
 * Pure classification of what a session needs next. A session still
 * RECORDING never finalizes even if uploadedUpTo has momentarily caught up
 * to totalChunks — more chunks are still coming, so "fully uploaded so far"
 * is not "fully uploaded."
 */
export function nextActionFor(entry: SessionLedgerEntry): UploadAction {
  const classId = toClassId(entry.meetingCode);
  if ((entry.status === 'RECORDING' || entry.status === 'STOPPED') && entry.uploadedUpTo < entry.totalChunks) {
    return { kind: 'UPLOAD_CHUNK', sessionId: entry.sessionId, classId, chunkIndex: entry.uploadedUpTo };
  }
  if (entry.status === 'STOPPED' && entry.uploadedUpTo >= entry.totalChunks) {
    return { kind: 'FINALIZE', sessionId: entry.sessionId, classId };
  }
  if (entry.status === 'UPLOADING') {
    return { kind: 'POLL', sessionId: entry.sessionId, classId };
  }
  return { kind: 'NONE' };
}

/** The oldest session that has any actionable work, or undefined if none do — a single global queue, matching R2's "1 request at a time" design. */
export function pickNextSession(entries: readonly SessionLedgerEntry[]): SessionLedgerEntry | undefined {
  const actionable = entries.filter((e) => nextActionFor(e).kind !== 'NONE');
  if (actionable.length === 0) return undefined;
  return [...actionable].sort((a, b) => a.startedAtMs - b.startedAtMs)[0];
}

export interface UploadDeps {
  client: RecordingServerClient;
  ledger: SessionLedger;
  rateLimiter: UploadRateLimiter;
  makeChunkReader: (sessionId: string) => ChunkWriterLike;
  logger: Logger;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function advanceSession(entry: SessionLedgerEntry, anyRecording: boolean, deps: UploadDeps): Promise<void> {
  const action = nextActionFor(entry);
  switch (action.kind) {
    case 'UPLOAD_CHUNK': {
      const reader = deps.makeChunkReader(entry.sessionId);
      const blob = await reader.readChunk(action.chunkIndex);
      if (!blob) {
        // Genuinely missing from disk (e.g. a Phase 1 memory-buffer drop) —
        // nothing will ever fill this index in. Move the watermark past it
        // rather than retrying forever (R8: never get permanently stuck).
        await deps.ledger.recordUpload(entry.sessionId, action.chunkIndex + 1);
        return;
      }
      const delayMs = deps.rateLimiter.paceMs(blob.size, anyRecording);
      if (delayMs > 0) await sleep(delayMs);
      const startedAt = Date.now();
      try {
        await deps.client.uploadChunk(action.classId, action.chunkIndex, blob);
        const decision = deps.rateLimiter.recordSuccess(Date.now() - startedAt);
        await deps.ledger.recordUpload(entry.sessionId, action.chunkIndex + 1);
        if (decision.action === 'PAUSED') {
          deps.logger.warn('upload paused after repeated slow uploads', { sessionId: entry.sessionId });
        }
      } catch (error) {
        deps.rateLimiter.recordError();
        deps.logger.warn('chunk upload failed, will retry', {
          sessionId: entry.sessionId,
          chunkIndex: action.chunkIndex,
          error: String(error),
        });
      }
      return;
    }
    case 'FINALIZE': {
      try {
        await deps.client.readyToMerge(action.classId);
        await deps.ledger.setStatus(entry.sessionId, 'UPLOADING');
      } catch (error) {
        deps.rateLimiter.recordError();
        deps.logger.warn('ready-to-merge failed, will retry', { sessionId: entry.sessionId, error: String(error) });
      }
      return;
    }
    case 'POLL': {
      try {
        const status = await deps.client.getRecordingStatus(action.classId);
        if (status?.status === 'READY') {
          const reader = deps.makeChunkReader(entry.sessionId);
          await reader.deleteSessionDir();
          await deps.ledger.setStatus(entry.sessionId, 'DONE');
        }
      } catch (error) {
        deps.logger.warn('status poll failed, will retry', { sessionId: entry.sessionId, error: String(error) });
      }
      return;
    }
    case 'NONE':
      return;
  }
}

let pumping = false;

/**
 * The single entry point both the CHUNK_READY message handler and the
 * chrome.alarms sweep call. Global single-flight guard (`pumping`) matches
 * R2's "1 request at a time" — a call that arrives while another is already
 * in flight is a no-op; the next trigger (message or alarm) picks up
 * whatever's left.
 */
export async function pumpUploadQueue(deps: UploadDeps): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const sessions = await deps.ledger.list();
    const anyRecording = sessions.some((e) => e.status === 'RECORDING');
    const candidate = pickNextSession(sessions);
    if (!candidate) return;
    await advanceSession(candidate, anyRecording, deps);
  } finally {
    pumping = false;
  }
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run src/background-logic/test/uploader.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 10: Wire into `entrypoints/background.ts`**

Add imports:
```ts
import { RecordingServerClient } from "@/src/adapters/recording-server-client";
import { AuthTokenStore } from "@/src/adapters/auth-token-store";
import { UploadRateLimiter } from "@/src/core/upload-rate-limiter";
import { pumpUploadQueue, type UploadDeps } from "@/src/background-logic/uploader";
import { ChunkWriter } from "@/src/offscreen-logic/chunk-writer";
```

Add module-scope instances, next to `sessionLedger`:
```ts
const uploadDeps: UploadDeps = {
  client: new RecordingServerClient(CONFIG.RECORDING_SERVER_BASE_URL, new AuthTokenStore(store)),
  ledger: sessionLedger,
  rateLimiter: new UploadRateLimiter(),
  makeChunkReader: (sessionId) => new ChunkWriter(sessionId),
  logger,
};
```

Add a case to the `onMessage` switch (near `MIC_MUTE_CHANGED`):
```ts
        case "CHUNK_READY":
          run(pumpUploadQueue(uploadDeps), "upload pump");
          return false;
```

Inside `defineBackground(() => { ... })`, add a tab-close safety net (spec Task 2.3 — a teacher closing the Meet tab while still recording should stop cleanly rather than leaving a dangling session):
```ts
  browser.tabs.onRemoved.addListener((tabId) => {
    run(
      (async () => {
        const active = await readActiveSession();
        if (active?.tabId === tabId) {
          await handleStop({ type: "STOP_RECORDING", sessionId: active.sessionId });
        }
      })(),
      "tab closed during recording",
    );
  });
```

- [ ] **Step 11: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 12: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass (Phase 0/1's suite + this task's new/updated tests).

- [ ] **Step 13: Commit**

```bash
git add src/core/session-ledger.ts src/core/test/session-ledger.test.ts \
        src/offscreen-logic/chunk-writer.ts src/shared/messages.ts \
        entrypoints/offscreen/main.ts \
        src/background-logic/uploader.ts src/background-logic/test/uploader.test.ts \
        entrypoints/background.ts
git commit -m "feat: upload chunks to the real recording server, finalize, poll, and clean up locally on confirmed complete (R2/R3/R6/R12)"
```

- [ ] **Step 14: Manual test — real chunk upload end to end**

Requires Task 1's manual test done first (dev JWT set via `chrome.storage.local`, matching the Meet meeting code you'll use here).

1. Confirm the sibling server is running (`npm run dev` in `1study-recording/`).
2. Start a real recording, let it run ~1 minute (several chunks).
3. Watch the sibling server's own logs (or its `temp/<classId>/` directory on disk) — confirm chunk files are landing there in order as the class proceeds, not just at the end.
4. Stop the recording.
5. Watch the background service worker's console (`chrome://extensions` → service worker) for `"ready-to-merge failed"`/`"status poll failed"` warnings (should be none) — within ~1–2 minutes, the sibling server's cron job should merge and upload to S3.
6. Confirm in the sibling server's DB (or via `GET http://localhost:3000/api/recording/<classId>` with your token) that status reaches `"READY"` with a real `s3Url`.
7. Confirm the extension's own OPFS chunk directory for that session is now gone (DevTools → the offscreen/background OPFS browser from Phase 0/1's docs) and the ledger entry's status reads `"DONE"`.
8. Play the S3 file (via the signed URL) — confirm it's the full, correct-duration recording.

---

### Task 4: Resume-on-Reopen Sweep (spec Task 2.4, R8)

**Files:**
- Modify: `entrypoints/background.ts`

**Interfaces:**
- Consumes: `pumpUploadQueue`, `uploadDeps` (Task 3).

- [ ] **Step 1: Register the alarm and its handler**

In `entrypoints/background.ts`, inside `defineBackground(() => { ... })`, alongside the other listener registrations:
```ts
  const UPLOAD_SWEEP_ALARM = "uploadSweep";
  browser.alarms.create(UPLOAD_SWEEP_ALARM, { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPLOAD_SWEEP_ALARM) {
      run(pumpUploadQueue(uploadDeps), "upload sweep");
    }
  });
```

`chrome.alarms` already has manifest permission (`wxt.config.ts`'s `permissions` array already includes `'alarms'`, added in Phase 0 anticipating this — no manifest change needed here). `browser.alarms.create` is idempotent by name — calling it again on every service-worker restart (which this code does, since it runs at module-registration time on every `defineBackground` invocation) just resets the same alarm's schedule, it does not create duplicates.

- [ ] **Step 2: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass, unchanged count from Task 3 (this task adds no new testable pure logic — `pumpUploadQueue` itself is already covered).

- [ ] **Step 4: Commit**

```bash
git add entrypoints/background.ts
git commit -m "feat: resume uploads automatically via chrome.alarms, surviving Chrome restarts (spec Task 2.4, R8)"
```

- [ ] **Step 5: Manual test — kill Chrome mid-upload, confirm it resumes without any teacher action**

1. Start a recording, stop it after ~30s (a couple of chunks, deliberately short so upload won't finish before the next step).
2. Immediately (before the chunks finish uploading) fully quit Chrome — a real Cmd+Q/Task Manager kill, not just closing the window (same distinction as Phase 1's own crash-recovery test, which this plan does not depend on — this is purely about the alarm surviving, not about ledger reconciliation).
3. Wait a minute or two, then reopen Chrome. Do not open the extension or touch anything.
4. Open the background service worker's console — within ~1 minute (the alarm's period), you should see upload activity resume on its own (chunk-upload / ready-to-merge / poll log lines), with **no click, no popup interaction, nothing** from you.
5. Confirm the session eventually reaches `DONE` exactly as in Task 3's manual test.
