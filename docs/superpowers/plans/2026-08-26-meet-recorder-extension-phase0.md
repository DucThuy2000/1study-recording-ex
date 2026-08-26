# Meet Recorder Extension — Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the four highest-risk feasibility questions for the Google Meet class-recording extension: can `tabCapture` capture the full Tiled camera grid, can teacher mic + student tab audio be mixed reliably, can a low-spec teacher machine sustain a 60-minute recording, and does the video stream survive a tab switch — all while keeping the code organized per the spec's Section 4 patterns (not throwaway).

**Architecture:** A WXT-built Manifest V3 extension with four contexts: a background service worker (tabCapture + offscreen lifecycle + tab guard), an offscreen document that owns all media (getUserMedia, AudioContext mixing, MediaRecorder, OPFS chunk writes, stall detection), a content script on `meet.google.com` (guard banners, visibility tracking), and a popup (Start/Stop UI). Pure decision/data logic (state machine, RMS math, codec/tier selection, guard rules, stall detection, event queueing) lives in `src/core/` and is unit-tested with Vitest; everything that touches `chrome.*`, `MediaRecorder`, `AudioContext`, or OPFS is manually tested per the spec's own test procedures, since those APIs don't run in Vitest's jsdom environment.

**Tech Stack:** TypeScript (`strict: true`), [WXT](https://wxt.dev) (Vite-based MV3 framework — chosen over `@crxjs/vite-plugin` because CRXJS has open, unresolved issues mixing its manifest-driven build with the extra `rollupOptions.input` an offscreen document requires; WXT has a first-party offscreen-document pattern via unlisted-page entrypoints), Vitest + `wxt/testing/vitest-plugin` (`WxtVitest()`) for unit tests, npm.

**Spec:** `docs/superpowers/specs/2026-08-26-meet-recorder-extension-design.md` (Phase 0 = Task 0.1 through Task 0.6; Phases 1-5 are out of scope for this plan and will get their own plans later).

## Global Constraints

- **File naming:** never name a file after the single function/export it holds (e.g. `assert-never.ts` for `assertNever`) — name it after the concept/domain it covers (`assert.ts`, `rms.ts`, `tab-guard.ts`). Files that already do this throughout the plan need no change; this only affected `assert.ts` in Task 1.
- **Test file location:** every test file lives in a `test/` subfolder of the directory it tests, not colocated next to its source file — `src/core/foo.ts` is tested by `src/core/test/foo.test.ts`, `src/adapters/bar.ts` by `src/adapters/test/bar.test.ts`. Every task below already reflects this; a test file one level deeper than its source needs one extra `../` in its relative imports (two extra `../` for an import that already climbed a directory, e.g. `src/core/test/x.test.ts` importing `src/adapters/y.ts` is `../../adapters/y`, not `../adapters/y`).
- **`defineBackground`/`defineContentScript` need explicit imports here.** WXT normally injects these as ambient globals, but this project's `wxt.config.ts` sets `imports: false` (to keep every dependency an explicit `import`, per the no-implicit-globals rule below) — and that also disables the ambient-global injection for WXT's own entrypoint helpers, not just the auto-import convention it was meant to turn off. Every `entrypoints/background.ts` listing imports `{ defineBackground } from 'wxt/utils/define-background'`; every `entrypoints/content.ts` listing imports `{ defineContentScript } from 'wxt/utils/define-content-script'`. Confirmed by a real `npm run build` + `tsc --noEmit` after a clean `.wxt`/`.output` regeneration.
- **`noUncheckedIndexedAccess` and `verbatimModuleSyntax` are on** (inherited from WXT's generated `.wxt/tsconfig.json`, confirmed by running `tsc --noEmit` against Task 1's actual output). Concretely: `arr[i]` and `arr?.[i]` are typed `T | undefined` — chain another `?.` before touching a property, or non-null-assert with `!` when you can prove by construction that the element exists (e.g. `stream.getVideoTracks()[0]!` right after requesting a stream with a video track). And: a symbol imported only for a type position must use `import type { X }` (or `import { type X, ... }`) — every code block in this plan already does this correctly; keep doing it in anything you write beyond what's shown.

- TypeScript `strict: true`; no `any` (use `unknown` + type guards). [spec 4.5]
- No singletons, no module-level mutable globals for anything stateful — use constructor injection so every class is testable without a real browser. [spec 4.5]
- All numeric/threshold constants live in `src/shared/config.ts`, no magic numbers scattered in logic. [spec 4.5]
- No raw `console.log` — use the leveled `Logger` from `src/core/logger.ts`. Never log media content or tokens. [spec 4.5]
- Manifest declares exactly these permissions and nothing else in Phase 0: `tabCapture`, `offscreen`, `storage`, `unlimitedStorage`, `alarms`; `host_permissions: ["https://meet.google.com/*"]`. The LMS host permission from the spec's manifest is added in Phase 3 (Task 3.1) when auth work begins — adding it now would be an unused permission, which Chrome Web Store review flags. [spec Section 3, Task 5.3]
- R1: never hold a growing chunk array in memory — every `ondataavailable` blob is written to OPFS and the reference dropped immediately.
- R4/R5: tab audio never contains the teacher's mic. Mic must be captured separately with `echoCancellation`, `noiseSuppression`, `autoGainControl` and mixed in; the tab audio must also be connected to `ctx.destination` or the teacher goes silent to themselves during capture.
- R6: no silent failures — every abnormal state (mic silent, tab audio silent, video stalled, etc.) surfaces an in-tab banner. The "send event to LMS" half of R6 is implemented as a local, durable, bounded queue (`EventReporter`) now; actually transmitting the queue happens in Phase 3 once the LMS event endpoint exists. This is a real, working, tested mechanism today — not a stub — it just has no network client yet.
- R7: no canvas frame processing. `tabCapture` + `MediaRecorder` do all compositing/encoding natively.
- R11: codec selection always goes through `pickMimeType`'s feature-detection fallback chain, tied to a device tier. No remote code (MV3 already forbids this).
- R12: nothing built in Phase 0 may block or interrupt an in-progress recording. Guard/blocking logic only runs before `START_RECORDING` is accepted.
- R13: no important logic in a content-script `setInterval` (backgrounded tabs get throttled to ~1/min). Polling/timing logic lives in the offscreen document, which is not a regular tab and is not subject to that throttling.

**Documented deviation from spec 4.4's literal folder tree:** the spec's flat `src/background|offscreen|content|popup` tree is replaced by WXT's required `entrypoints/` convention for anything Chrome loads directly (`entrypoints/background.ts`, `entrypoints/content.ts`, `entrypoints/popup/`, `entrypoints/offscreen/`), plus a `src/` tree for everything else (`core/`, `adapters/`, `offscreen-logic/`, `shared/`). Each `entrypoints/*` file is a thin wiring layer that imports its real logic from `src/offscreen-logic/*` or `src/core/*`. This keeps the Repository/Strategy/Adapter/EventBus patterns from spec 4.2 exactly as specified, just with the WXT-mandated top-level entrypoints directory. Reason: WXT owns manifest generation and needs entrypoints in a fixed location; nothing about the *design* changes, only where the wiring files live.

---

## File Structure

```
1study-recording-ex/
  wxt.config.ts
  vitest.config.ts
  package.json
  tsconfig.json
  entrypoints/
    background.ts              service worker: tab guard, tabCapture, offscreen lifecycle
    content.ts                 meet.google.com: banners, visibilitychange
    popup/
      index.html
      main.ts
    offscreen/
      index.html
      main.ts                  wires recorder + mixer + monitors + frame-monitor
  src/
    core/
      result.ts                Result<T,E>                              [Task 1]
      assert.ts                exhaustive-switch helper                 [Task 1]
      logger.ts                leveled logger                           [Task 1]
      state-machine.ts         SessionStateMachine                      [Task 1]
      event-bus.ts             typed pub/sub                            [Task 1]
      event-reporter.ts        R6 local event queue                     [Task 1]
      rms.ts                   RMS math                                 [Task 3]
      silence-tracker.ts       consecutive-silence state                [Task 3]
      device-tier.ts           hardwareConcurrency/deviceMemory → tier  [Task 4]
      meeting-code.ts          Meet URL → meetingCode                   [Task 5]
      tab-guard.ts             guard decision logic                     [Task 5]
      stall-detector.ts        frame-gap stall/recovery logic           [Task 6]
    adapters/
      storage.ts               KeyValueStore + ChromeStorageAdapter     [Task 1]
      chrome-api.ts             tabCapture/offscreen/tabs wrapper        [Task 2]
    offscreen-logic/
      chunk-writer.ts           OPFS per-chunk writer                    [Task 2]
      recorder.ts                MediaRecorder wrapper                   [Task 2]
      audio-mixer.ts               AudioContext tab+mic mixing             [Task 3]
      audio-monitor.ts              AnalyserNode + SilenceTracker wiring    [Task 3]
      frame-monitor.ts                requestVideoFrameCallback + StallDetector [Task 6]
    shared/
      config.ts                 CONFIG + pickMimeType + TierName          [Task 1]
      messages.ts                Message discriminated union               [Task 1, revised Task 4]
  public/
    icon/16.png, 32.png, 48.png, 128.png
  docs/
    superpowers/specs/2026-08-26-meet-recorder-extension-design.md  (already committed)
    superpowers/plans/2026-08-26-meet-recorder-extension-phase0.md  (this file)
    task-0.4-codec-findings.md      written during Task 4
    task-0.6-findings.md            written during Task 6
```

---

### Task 1: Project Scaffold + Core Foundations (spec Task 0.1)

**Files:**
- Create: `wxt.config.ts`, `vitest.config.ts`, `tsconfig.json` (edited after `wxt init`), `package.json` (via `wxt init`)
- Create: `src/core/result.ts`, `src/core/test/result.test.ts`
- Create: `src/core/assert.ts`, `src/core/test/assert.test.ts`
- Create: `src/core/logger.ts`, `src/core/test/logger.test.ts`
- Create: `src/adapters/storage.ts`, `src/adapters/test/storage.test.ts`
- Create: `src/core/event-bus.ts`, `src/core/test/event-bus.test.ts`
- Create: `src/core/state-machine.ts`, `src/core/test/state-machine.test.ts`
- Create: `src/core/event-reporter.ts`, `src/core/test/event-reporter.test.ts`
- Create: `src/shared/config.ts`, `src/shared/test/config.test.ts`
- Create: `src/shared/messages.ts`
- Create: `entrypoints/background.ts`, `entrypoints/content.ts`, `entrypoints/popup/index.html`, `entrypoints/popup/main.ts`

**Interfaces:**
- Produces: `Result<T,E>`, `ok()`, `err()`, `isOk()`, `isErr()` — used by every later I/O-returning function.
- Produces: `assertNever(x: never): never` — used by every exhaustive `switch` on `Message['type']` or `SessionState`.
- Produces: `Logger` interface + `createLogger(scope, minLevel?)` — used in every file that logs.
- Produces: `KeyValueStore` interface, `ChromeStorageAdapter`, `InMemoryStore` — used by `SessionStateMachine` and `EventReporter`.
- Produces: `EventBus<Events>` generic pub/sub — used by `EventReporter` (Task 1) and offscreen wiring (Tasks 3, 6).
- Produces: `SessionStateMachine` with `getState()` and `transition(to, reason): Promise<Result<SessionState, string>>` — used from Task 2 onward.
- Produces: `EventReporter` with `report(type, payload): Promise<void>` — used by Tasks 3 and 6.
- Produces: `CONFIG` object, `TierName`, `pickMimeType(codecs): string` — used by `recorder.ts` (Task 2) and `device-tier.ts` (Task 4).
- Produces: `Message` discriminated union, `MessageOf<T>` — used by every entrypoint from Task 2 onward.

- [ ] **Step 1: Scaffold the WXT project**

Run interactively:
```bash
npx wxt@latest init .
```
When prompted, choose: template **Vanilla**, language **TypeScript**, package manager **npm**. Let it install dependencies.

- [ ] **Step 2: Add the offscreen document permission and Phase-0 manifest**

Edit `wxt.config.ts`:

```ts
import { defineConfig } from 'wxt';

export default defineConfig({
  imports: false,
  manifest: {
    name: '1Study Class Recorder',
    version: '0.1.0',
    permissions: ['tabCapture', 'offscreen', 'storage', 'unlimitedStorage', 'alarms'],
    host_permissions: ['https://meet.google.com/*'],
  },
});
```

`imports: false` disables WXT's auto-import convention so every dependency stays an explicit `import` statement (spec 4.5 forbids implicit globals).

- [ ] **Step 3: Install test dependencies**

```bash
npm install -D vitest jsdom @webext-core/fake-browser
```

- [ ] **Step 4: Configure Vitest**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'jsdom',
  },
});
```

Add to `package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`.

- [ ] **Step 5: Turn on strict TypeScript checks**

Edit `tsconfig.json` (it extends WXT's generated `.wxt/tsconfig.json`) to add:

```json
{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true
  }
}
```

- [ ] **Step 6: `Result` type — write the failing test**

`src/core/test/result.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr } from '../result';

describe('Result', () => {
  it('ok() produces a value result recognized by isOk', () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (isOk(r)) expect(r.value).toBe(42);
  });

  it('err() produces an error result recognized by isErr', () => {
    const r = err('boom');
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
    if (isErr(r)) expect(r.error).toBe('boom');
  });
});
```

- [ ] **Step 7: Run it, confirm it fails**

Run: `npm test -- result.test.ts`
Expected: FAIL — `Cannot find module './result'`.

- [ ] **Step 8: Implement `Result`**

`src/core/result.ts`:

```ts
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}
```

- [ ] **Step 9: Run it, confirm it passes, commit**

Run: `npm test -- result.test.ts` → PASS

```bash
git add src/core/result.ts src/core/test/result.test.ts
git commit -m "feat: add Result<T,E> type"
```

- [ ] **Step 10: `assertNever` — write the failing test, implement, pass, commit**

`src/core/test/assert.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { assertNever } from '../assert';

describe('assertNever', () => {
  it('throws with the unhandled value in the message', () => {
    // @ts-expect-error: deliberately calling with a non-never value to test the runtime guard
    expect(() => assertNever({ type: 'UNEXPECTED' })).toThrow(/UNEXPECTED/);
  });
});
```

`src/core/assert.ts`:

```ts
export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
```

Run: `npm test -- assert.test.ts` → PASS, then:

```bash
git add src/core/assert.ts src/core/test/assert.test.ts
git commit -m "feat: add assertNever exhaustiveness helper"
```

- [ ] **Step 11: `Logger` — write the failing test**

`src/core/test/logger.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from '../logger';

describe('createLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prefixes messages with the scope', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger('test-scope', 'debug').info('hello');
    expect(spy).toHaveBeenCalledWith('[test-scope] hello', '');
  });

  it('filters out messages below the minimum level', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger('test-scope', 'warn').info('should not appear');
    expect(spy).not.toHaveBeenCalled();
  });

  it('routes error level to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger('test-scope', 'debug').error('bad thing', { code: 1 });
    expect(spy).toHaveBeenCalledWith('[test-scope] bad thing', { code: 1 });
  });
});
```

- [ ] **Step 12: Run it, confirm it fails**

Run: `npm test -- logger.test.ts`
Expected: FAIL — `Cannot find module './logger'`.

- [ ] **Step 13: Implement `Logger`**

`src/core/logger.ts`:

```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(scope: string, minLevel: LogLevel = 'info'): Logger {
  const log = (level: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const line = `[${scope}] ${msg}`;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(line, meta ?? '');
  };
  return {
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
  };
}
```

- [ ] **Step 14: Run it, confirm it passes, commit**

Run: `npm test -- logger.test.ts` → PASS

```bash
git add src/core/logger.ts src/core/test/logger.test.ts
git commit -m "feat: add leveled logger"
```

- [ ] **Step 15: `KeyValueStore` — write the failing test**

`src/adapters/test/storage.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ChromeStorageAdapter, InMemoryStore } from '../storage';

describe('InMemoryStore', () => {
  it('round-trips a value', async () => {
    const store = new InMemoryStore();
    await store.set('key', { a: 1 });
    expect(await store.get('key')).toEqual({ a: 1 });
  });

  it('returns undefined for a missing key', async () => {
    const store = new InMemoryStore();
    expect(await store.get('missing')).toBeUndefined();
  });
});

describe('ChromeStorageAdapter', () => {
  beforeEach(() => fakeBrowser.reset());

  it('round-trips a value through browser.storage.local', async () => {
    const store = new ChromeStorageAdapter();
    await store.set('key', { a: 1 });
    expect(await store.get('key')).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 16: Run it, confirm it fails**

Run: `npm test -- storage.test.ts`
Expected: FAIL — `Cannot find module './storage'`.

- [ ] **Step 17: Implement `KeyValueStore`**

`src/adapters/storage.ts`:

```ts
import { browser } from 'wxt/browser';

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export class ChromeStorageAdapter implements KeyValueStore {
  async get<T>(key: string): Promise<T | undefined> {
    const result = await browser.storage.local.get(key);
    return result[key] as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  }
}

export class InMemoryStore implements KeyValueStore {
  private readonly map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }
}
```

- [ ] **Step 18: Run it, confirm it passes, commit**

Run: `npm test -- storage.test.ts` → PASS

```bash
git add src/adapters/storage.ts src/adapters/test/storage.test.ts
git commit -m "feat: add KeyValueStore with Chrome and in-memory adapters"
```

- [ ] **Step 19: `EventBus` — write the failing test**

`src/core/test/event-bus.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../event-bus';

type Events = {
  ping: { count: number };
};

describe('EventBus', () => {
  it('delivers emitted payloads to subscribed listeners', () => {
    const bus = new EventBus<Events>();
    const listener = vi.fn();
    bus.on('ping', listener);
    bus.emit('ping', { count: 1 });
    expect(listener).toHaveBeenCalledWith({ count: 1 });
  });

  it('stops delivery after off()', () => {
    const bus = new EventBus<Events>();
    const listener = vi.fn();
    bus.on('ping', listener);
    bus.off('ping', listener);
    bus.emit('ping', { count: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('the unsubscribe function returned by on() also stops delivery', () => {
    const bus = new EventBus<Events>();
    const listener = vi.fn();
    const unsubscribe = bus.on('ping', listener);
    unsubscribe();
    bus.emit('ping', { count: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('supports multiple listeners for the same event', () => {
    const bus = new EventBus<Events>();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('ping', a);
    bus.on('ping', b);
    bus.emit('ping', { count: 1 });
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });
});
```

- [ ] **Step 20: Run it, confirm it fails**

Run: `npm test -- event-bus.test.ts`
Expected: FAIL — `Cannot find module './event-bus'`.

- [ ] **Step 21: Implement `EventBus`**

`src/core/event-bus.ts`:

```ts
type Listener<T> = (payload: T) => void;

export class EventBus<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<unknown>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener<unknown>>();
    set.add(listener as Listener<unknown>);
    this.listeners.set(event, set);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<unknown>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.listeners.get(event)?.forEach((listener) => listener(payload));
  }
}
```

- [ ] **Step 22: Run it, confirm it passes, commit**

Run: `npm test -- event-bus.test.ts` → PASS

```bash
git add src/core/event-bus.ts src/core/test/event-bus.test.ts
git commit -m "feat: add typed EventBus"
```

- [ ] **Step 23: `SessionStateMachine` — write the failing test**

`src/core/test/state-machine.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SessionStateMachine } from '../state-machine';
import { InMemoryStore } from '../../adapters/storage';
import { createLogger } from '../logger';

function makeMachine() {
  const store = new InMemoryStore();
  const logger = createLogger('test', 'error');
  return { machine: new SessionStateMachine('session-1', store, logger), store };
}

describe('SessionStateMachine', () => {
  it('starts in IDLE', () => {
    const { machine } = makeMachine();
    expect(machine.getState()).toBe('IDLE');
  });

  it('allows IDLE -> READY -> RECORDING and persists each transition', async () => {
    const { machine, store } = makeMachine();
    await machine.transition('READY', 'preflight ok');
    await machine.transition('RECORDING', 'start');
    expect(machine.getState()).toBe('RECORDING');
    expect(await store.get('session:session-1:state')).toBe('RECORDING');
  });

  it('allows RECORDING <-> DEGRADED without losing the recording', async () => {
    const { machine } = makeMachine();
    await machine.transition('READY', 'preflight ok');
    await machine.transition('RECORDING', 'start');
    const toDegraded = await machine.transition('DEGRADED', 'mic silent');
    expect(toDegraded.ok).toBe(true);
    const backToRecording = await machine.transition('RECORDING', 'mic recovered');
    expect(backToRecording.ok).toBe(true);
  });

  it('rejects an invalid transition and leaves the state unchanged', async () => {
    const { machine, store } = makeMachine();
    const result = await machine.transition('DONE', 'skip everything');
    expect(result.ok).toBe(false);
    expect(machine.getState()).toBe('IDLE');
    expect(await store.get('session:session-1:state')).toBeUndefined();
  });
});
```

- [ ] **Step 24: Run it, confirm it fails**

Run: `npm test -- state-machine.test.ts`
Expected: FAIL — `Cannot find module './state-machine'`.

- [ ] **Step 25: Implement `SessionStateMachine`**

`src/core/state-machine.ts`:

```ts
import type { KeyValueStore } from '../adapters/storage';
import type { Logger } from './logger';
import { ok, err, type Result } from './result';

export type SessionState =
  | 'IDLE'
  | 'READY'
  | 'RECORDING'
  | 'DEGRADED'
  | 'FINALIZING'
  | 'UPLOADING'
  | 'DONE'
  | 'FAILED';

const ALLOWED_TRANSITIONS: Record<SessionState, SessionState[]> = {
  IDLE: ['READY'],
  READY: ['RECORDING', 'IDLE'],
  RECORDING: ['FINALIZING', 'DEGRADED'],
  DEGRADED: ['RECORDING', 'FINALIZING'],
  FINALIZING: ['UPLOADING', 'FAILED'],
  UPLOADING: ['DONE', 'FAILED'],
  DONE: [],
  FAILED: [],
};

export interface TransitionRecord {
  from: SessionState;
  to: SessionState;
  reason: string;
  atMs: number;
}

export class SessionStateMachine {
  private state: SessionState = 'IDLE';

  constructor(
    private readonly sessionId: string,
    private readonly store: KeyValueStore,
    private readonly logger: Logger,
  ) {}

  getState(): SessionState {
    return this.state;
  }

  async transition(to: SessionState, reason: string): Promise<Result<SessionState, string>> {
    const allowed = ALLOWED_TRANSITIONS[this.state];
    if (!allowed.includes(to)) {
      const message = `Invalid transition ${this.state} -> ${to} (reason: ${reason})`;
      this.logger.error(message);
      return err(message);
    }
    const record: TransitionRecord = { from: this.state, to, reason, atMs: Date.now() };
    this.state = to;
    await this.store.set(`session:${this.sessionId}:state`, to);
    await this.store.set(`session:${this.sessionId}:lastTransition`, record);
    this.logger.info(`transition ${record.from} -> ${record.to}`, { reason });
    return ok(to);
  }
}
```

- [ ] **Step 26: Run it, confirm it passes, commit**

Run: `npm test -- state-machine.test.ts` → PASS

```bash
git add src/core/state-machine.ts src/core/test/state-machine.test.ts
git commit -m "feat: add SessionStateMachine"
```

- [ ] **Step 27: `EventReporter` — write the failing test**

`src/core/test/event-reporter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { EventReporter, type RecordingEvent } from '../event-reporter';
import { InMemoryStore } from '../../adapters/storage';
import { EventBus } from '../event-bus';
import { createLogger } from '../logger';

function makeReporter() {
  const store = new InMemoryStore();
  const bus = new EventBus<{ event: RecordingEvent }>();
  const reporter = new EventReporter(store, bus, createLogger('test', 'error'));
  return { store, bus, reporter };
}

describe('EventReporter', () => {
  it('persists a reported event to the pending-events queue', async () => {
    const { store, reporter } = makeReporter();
    await reporter.report('MIC_SILENT', { sessionId: 's1' });
    const pending = await store.get<RecordingEvent[]>('pendingEvents');
    expect(pending).toHaveLength(1);
    expect(pending?.[0]?.type).toBe('MIC_SILENT');
    expect(pending?.[0]?.payload).toEqual({ sessionId: 's1' });
  });

  it('emits the event on the bus', async () => {
    const { bus, reporter } = makeReporter();
    const received: RecordingEvent[] = [];
    bus.on('event', (e) => received.push(e));
    await reporter.report('TAB_AUDIO_SILENT', {});
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('TAB_AUDIO_SILENT');
  });

  it('caps the queue at 500 entries, dropping the oldest', async () => {
    const { store, reporter } = makeReporter();
    for (let i = 0; i < 501; i++) {
      await reporter.report('LOW_DISK', { i });
    }
    const pending = await store.get<RecordingEvent[]>('pendingEvents');
    expect(pending).toHaveLength(500);
    expect(pending?.[0]?.payload).toEqual({ i: 1 });
  });
});
```

- [ ] **Step 28: Run it, confirm it fails**

Run: `npm test -- event-reporter.test.ts`
Expected: FAIL — `Cannot find module './event-reporter'`.

- [ ] **Step 29: Implement `EventReporter`**

`src/core/event-reporter.ts`:

```ts
import type { KeyValueStore } from '../adapters/storage';
import type { EventBus } from './event-bus';
import type { Logger } from './logger';

export interface RecordingEvent {
  type:
    | 'MIC_SILENT'
    | 'TAB_AUDIO_SILENT'
    | 'LOW_DISK'
    | 'BACKLOG_HIGH'
    | 'OPFS_ERROR'
    | 'UPLOAD_STALLED'
    | 'QUALITY_DEGRADED'
    | 'LAYOUT_WRONG'
    | 'VIDEO_STALLED';
  payload: Record<string, unknown>;
  ts: number;
}

const PENDING_EVENTS_KEY = 'pendingEvents';
const MAX_PENDING = 500;

export class EventReporter {
  constructor(
    private readonly store: KeyValueStore,
    private readonly bus: EventBus<{ event: RecordingEvent }>,
    private readonly logger: Logger,
  ) {}

  async report(type: RecordingEvent['type'], payload: Record<string, unknown>): Promise<void> {
    const event: RecordingEvent = { type, payload, ts: Date.now() };
    this.logger.warn(`event: ${type}`, payload);
    const pending = (await this.store.get<RecordingEvent[]>(PENDING_EVENTS_KEY)) ?? [];
    pending.push(event);
    if (pending.length > MAX_PENDING) pending.shift();
    await this.store.set(PENDING_EVENTS_KEY, pending);
    this.bus.emit('event', event);
  }
}
```

This is the concrete, working half of R6 available in Phase 0: every abnormal state gets logged, queued durably, and broadcast locally. Phase 3 (Task 3.1+) adds the network client that flushes `pendingEvents` to `POST /api/recordings/event` — nothing here needs to change when that lands, it only needs a consumer.

- [ ] **Step 30: Run it, confirm it passes, commit**

Run: `npm test -- event-reporter.test.ts` → PASS

```bash
git add src/core/event-reporter.ts src/core/test/event-reporter.test.ts
git commit -m "feat: add EventReporter as the local half of R6"
```

- [ ] **Step 31: `CONFIG` + `pickMimeType` — write the failing test**

`src/shared/test/config.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CONFIG, pickMimeType } from '../config';

describe('CONFIG', () => {
  it('defines the three device tiers from the spec', () => {
    expect(CONFIG.TIERS.LOW.codecs).toEqual(['vp8']);
    expect(CONFIG.TIERS.MID.codecs).toEqual(['vp9', 'vp8']);
    expect(CONFIG.TIERS.HIGH.codecs).toEqual(['vp9', 'vp8']);
  });
});

describe('pickMimeType', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('picks the first supported codec in order', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: (t: string) => t === 'video/webm;codecs=vp8,opus',
    });
    expect(pickMimeType(['vp9', 'vp8'])).toBe('video/webm;codecs=vp8,opus');
  });

  it('falls back to plain video/webm when no codec-specific type is supported', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: (t: string) => t === 'video/webm',
    });
    expect(pickMimeType(['vp9', 'vp8'])).toBe('video/webm');
  });

  it('throws when nothing is supported', () => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => false });
    expect(() => pickMimeType(['vp9'])).toThrow();
  });
});
```

- [ ] **Step 32: Run it, confirm it fails**

Run: `npm test -- config.test.ts`
Expected: FAIL — `Cannot find module './config'`.

- [ ] **Step 33: Implement `CONFIG` and `pickMimeType`**

`src/shared/config.ts`:

```ts
export const CONFIG = {
  CHUNK_MS: 5000,
  UPLOAD_RATE_IN_CLASS_BPS: 900_000,
  UPLOAD_RATE_MAX_BPS: 1_500_000,
  DISK_MIN_FREE_BYTES: 3 * 1024 ** 3,
  BACKLOG_MAX_BYTES: 5 * 1024 ** 3,
  SILENCE_ALERT_SECONDS: 60,
  SILENCE_CHECK_INTERVAL_SECONDS: 10,
  HEARTBEAT_INTERVAL_MS: 30_000,
  MEMORY_BUFFER_MAX_BYTES: 200 * 1024 ** 2,
  AUDIO_BITRATE: 64_000,
  STALL_GAP_MS: 3000,
  TIERS: {
    LOW: { width: 854, height: 480, fps: 12, bitrate: 600_000, codecs: ['vp8'] },
    MID: { width: 1280, height: 720, fps: 15, bitrate: 1_200_000, codecs: ['vp9', 'vp8'] },
    HIGH: { width: 1280, height: 720, fps: 24, bitrate: 1_800_000, codecs: ['vp9', 'vp8'] },
  },
} as const;

export type TierName = keyof typeof CONFIG.TIERS;

export function pickMimeType(codecs: readonly string[]): string {
  const candidates = [...codecs.map((c) => `video/webm;codecs=${c},opus`), 'video/webm'];
  const found = candidates.find((t) => MediaRecorder.isTypeSupported(t));
  if (!found) throw new Error('No supported WebM codec found');
  return found;
}
```

`STALL_GAP_MS` and `SILENCE_CHECK_INTERVAL_SECONDS` are used starting Task 3/Task 6, but per spec 4.5 every constant belongs in this single file from the start, not introduced piecemeal.

- [ ] **Step 34: Run it, confirm it passes, commit**

Run: `npm test -- config.test.ts` → PASS

```bash
git add src/shared/config.ts src/shared/test/config.test.ts
git commit -m "feat: add CONFIG and pickMimeType codec fallback"
```

- [ ] **Step 35: Write the full `Message` contract (no test — type-only file, verified by `tsc`)**

`src/shared/messages.ts`:

```ts
import type { SessionState } from '../core/state-machine';
import type { TierName } from './config';

export type Message =
  | { type: 'START_RECORDING'; tabId: number }
  | { type: 'STOP_RECORDING'; sessionId: string }
  | { type: 'RECORDING_STARTED'; sessionId: string; streamId: string; tier: TierName }
  | { type: 'RECORDING_STATE'; sessionId: string; state: SessionState; elapsedMs: number }
  | { type: 'AUDIO_ALERT'; source: 'mic' | 'tab'; silent: boolean }
  | { type: 'VIDEO_STALLED'; sessionId: string; gapMs: number; atMs: number }
  | { type: 'GUARD_RESULT'; allowed: boolean; reason?: string };

export type MessageOf<T extends Message['type']> = Extract<Message, { type: T }>;
```

> Task 4 will revise this file: `tier` moves out of `RECORDING_STARTED` because the offscreen document ends up better positioned to read `navigator.deviceMemory` than the service worker. That revision is documented in Task 4, not here.

- [ ] **Step 36: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/shared/messages.ts
git commit -m "feat: declare the cross-context Message contract"
```

- [ ] **Step 37: Wire the (still-empty) entrypoints**

`entrypoints/background.ts`:

```ts
import { defineBackground } from 'wxt/utils/define-background';
import { createLogger } from '@/src/core/logger';

const logger = createLogger('background');

export default defineBackground(() => {
  logger.info('service worker started');
});
```

`entrypoints/content.ts`:

```ts
import { defineContentScript } from 'wxt/utils/define-content-script';
import { createLogger } from '@/src/core/logger';

const logger = createLogger('content');

export default defineContentScript({
  matches: ['*://meet.google.com/*'],
  main() {
    logger.info('content script loaded', { url: location.href });
  },
});
```

`entrypoints/popup/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>1Study Class Recorder</title>
  </head>
  <body>
    <div id="app">1Study Class Recorder</div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`entrypoints/popup/main.ts`:

```ts
import { createLogger } from '@/src/core/logger';

createLogger('popup').info('popup opened');
```

- [ ] **Step 38: Build and manually verify (spec Task 0.1 cases)**

Run: `npm run build`
Expected: a `.output/chrome-mv3/` directory is created (check the exact path printed by the build command).

Manual test:
1. Open `chrome://extensions`, enable Developer mode, click "Load unpacked", select `.output/chrome-mv3/`.
2. Confirm the extension loads with no errors.
3. Open `https://meet.google.com` in a tab, open DevTools console — confirm `[content] content script loaded` appears.
4. Open a non-Meet tab (e.g. `https://example.com`) — confirm no content-script log appears there.
5. On the extension's detail page in `chrome://extensions`, click "service worker" to open its console — confirm `[background] service worker started` appears.
6. Edit a comment in any file, rerun `npm run build`, click the reload icon on the extension card in `chrome://extensions` — confirm it reloads without needing to restart Chrome.

**Review checklist (spec Task 0.1):** no permission beyond the six declared · `tsconfig.json` has `strict: true` · no raw `console.log` calls exist outside `logger.ts` itself.

- [ ] **Step 39: Commit the entrypoints**

```bash
git add entrypoints/
git commit -m "feat: wire minimal background/content/popup entrypoints"
```

---

### Task 2: tabCapture → Offscreen → Local File (spec Task 0.2 ⭐)

**Files:**
- Create: `src/adapters/chrome-api.ts`, `src/adapters/test/chrome-api.test.ts`
- Create: `src/offscreen-logic/chunk-writer.ts` (manual-tested — OPFS is unavailable in Vitest's jsdom)
- Create: `src/offscreen-logic/recorder.ts` (manual-tested — `MediaRecorder` is unavailable in Vitest's jsdom)
- Create: `entrypoints/offscreen/index.html`, `entrypoints/offscreen/main.ts`
- Modify: `entrypoints/background.ts`
- Modify: `entrypoints/popup/index.html`, `entrypoints/popup/main.ts`

**Interfaces:**
- Consumes: `Message`, `MessageOf` (Task 1), `CONFIG`, `pickMimeType`, `TierName` (Task 1).
- Produces: `ChromeTabCaptureApi.getMediaStreamId(tabId): Promise<string>`, `ChromeOffscreenApi.ensureDocument(url, reasons, justification): Promise<void>`, `ChromeOffscreenApi.closeDocument(): Promise<void>`, `getActiveTab(): Promise<{id, url} | undefined>` — used by Task 5's guard wiring.
- Produces: `ChunkWriter` (`write(blob): Promise<number>`, `readAll(): Promise<Blob>`) — reused unchanged into Phase 1's OPFS writer task.
- Produces: `SessionRecorder` (`start(): void`, `stop(): Promise<Blob>`) — extended in Task 4 to take a computed tier instead of a hardcoded one.

- [ ] **Step 1: `ChromeTabCaptureApi` / `ChromeOffscreenApi` — write the failing tests**

`src/adapters/test/chrome-api.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChromeTabCaptureApi, ChromeOffscreenApi } from '../chrome-api';

describe('ChromeTabCaptureApi', () => {
  it('resolves the stream id returned by chrome.tabCapture.getMediaStreamId', async () => {
    const getMediaStreamId = vi.fn().mockResolvedValue('stream-123');
    vi.stubGlobal('chrome', { tabCapture: { getMediaStreamId } });

    const api = new ChromeTabCaptureApi();
    const result = await api.getMediaStreamId(42);

    expect(result).toBe('stream-123');
    expect(getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 42 });
  });
});

describe('ChromeOffscreenApi', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('creates a document only when none exists', async () => {
    const hasDocument = vi.fn().mockResolvedValue(false);
    const createDocument = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', { offscreen: { hasDocument, createDocument } });

    await new ChromeOffscreenApi().ensureDocument('/offscreen.html', ['USER_MEDIA'], 'test');

    expect(createDocument).toHaveBeenCalledWith({
      url: '/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'test',
    });
  });

  it('skips creation when a document already exists', async () => {
    const hasDocument = vi.fn().mockResolvedValue(true);
    const createDocument = vi.fn();
    vi.stubGlobal('chrome', { offscreen: { hasDocument, createDocument } });

    await new ChromeOffscreenApi().ensureDocument('/offscreen.html', ['USER_MEDIA'], 'test');

    expect(createDocument).not.toHaveBeenCalled();
  });

  it('closes an existing document', async () => {
    const hasDocument = vi.fn().mockResolvedValue(true);
    const closeDocument = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', { offscreen: { hasDocument, closeDocument } });

    await new ChromeOffscreenApi().closeDocument();

    expect(closeDocument).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npm test -- chrome-api.test.ts`
Expected: FAIL — `Cannot find module './chrome-api'`.

- [ ] **Step 3: Implement the adapter**

`src/adapters/chrome-api.ts`:

```ts
import { browser } from 'wxt/browser';

export interface TabCaptureApi {
  getMediaStreamId(tabId: number): Promise<string>;
}

export interface OffscreenApi {
  ensureDocument(url: string, reasons: chrome.offscreen.Reason[], justification: string): Promise<void>;
  closeDocument(): Promise<void>;
}

export class ChromeTabCaptureApi implements TabCaptureApi {
  async getMediaStreamId(tabId: number): Promise<string> {
    return chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  }
}

export class ChromeOffscreenApi implements OffscreenApi {
  async ensureDocument(
    url: string,
    reasons: chrome.offscreen.Reason[],
    justification: string,
  ): Promise<void> {
    const has = await chrome.offscreen.hasDocument();
    if (has) return;
    await chrome.offscreen.createDocument({ url, reasons, justification });
  }

  async closeDocument(): Promise<void> {
    const has = await chrome.offscreen.hasDocument();
    if (has) await chrome.offscreen.closeDocument();
  }
}

export async function getActiveTab(): Promise<{ id: number; url: string } | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return undefined;
  return { id: tab.id, url: tab.url };
}
```

- [ ] **Step 4: Run it, confirm it passes, commit**

Run: `npm test -- chrome-api.test.ts` → PASS

```bash
git add src/adapters/chrome-api.ts src/adapters/test/chrome-api.test.ts
git commit -m "feat: add ChromeApi adapter for tabCapture/offscreen/tabs"
```

- [ ] **Step 5: Implement `ChunkWriter` (no automated test — OPFS is a browser-only API; verified manually in Step 9)**

`src/offscreen-logic/chunk-writer.ts`:

```ts
export class ChunkWriter {
  private nextIndex = 0;

  constructor(private readonly sessionId: string) {}

  private async getSessionDir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    const sessions = await root.getDirectoryHandle('sessions', { create: true });
    return sessions.getDirectoryHandle(this.sessionId, { create: true });
  }

  /** Writes one chunk to its own file and returns its index. Caller must drop its Blob reference after this resolves (R1). */
  async write(blob: Blob): Promise<number> {
    const index = this.nextIndex++;
    const dir = await this.getSessionDir();
    const name = `chunk_${String(index).padStart(5, '0')}.webm`;
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return index;
  }

  async readAll(): Promise<Blob> {
    const dir = await this.getSessionDir();
    const parts: Blob[] = [];
    for (let i = 0; i < this.nextIndex; i++) {
      const name = `chunk_${String(i).padStart(5, '0')}.webm`;
      const handle = await dir.getFileHandle(name);
      parts.push(await handle.getFile());
    }
    return new Blob(parts, { type: 'video/webm' });
  }
}
```

- [ ] **Step 6: Implement `SessionRecorder` (no automated test — `MediaRecorder` is a browser-only API; verified manually in Step 9)**

`src/offscreen-logic/recorder.ts`:

```ts
import { pickMimeType, CONFIG, type TierName } from '../shared/config';
import { ChunkWriter } from './chunk-writer';
import { createLogger } from '../core/logger';

const logger = createLogger('recorder');

export class SessionRecorder {
  private mediaRecorder: MediaRecorder | undefined;
  private readonly writer: ChunkWriter;

  constructor(
    private readonly sessionId: string,
    private readonly stream: MediaStream,
    private readonly tier: TierName,
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
      void this.writer.write(event.data).catch((error) => {
        logger.error('chunk write failed', { error: String(error) });
      });
    };
    this.mediaRecorder.start(CONFIG.CHUNK_MS);
    logger.info('recording started', { sessionId: this.sessionId, mimeType, tier: this.tier });
  }

  async stop(): Promise<Blob> {
    const recorder = this.mediaRecorder;
    if (!recorder) throw new Error('recorder not started');
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    return this.writer.readAll();
  }
}
```

The `ondataavailable` handler never appends to an array — each blob is handed to `ChunkWriter.write()` and the local reference is dropped as soon as the handler returns (R1).

- [ ] **Step 7: Create the offscreen entrypoint**

`entrypoints/offscreen/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>1Study Recorder — Offscreen</title>
  </head>
  <body>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`entrypoints/offscreen/main.ts`:

```ts
import { browser } from 'wxt/browser';
import type { Message } from '@/src/shared/messages';
import { SessionRecorder } from '@/src/offscreen-logic/recorder';
import { createLogger } from '@/src/core/logger';

const logger = createLogger('offscreen');
let activeRecorder: SessionRecorder | undefined;
let activeSessionId: string | undefined;

async function openTabStream(streamId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  } as MediaStreamConstraints);
}

function playTabAudioLocally(stream: MediaStream): void {
  // Without this, tabCapture silently stops the tab's audio from reaching the
  // teacher's speakers — they'd be recording a class they can no longer hear (R4/R5).
  const ctx = new AudioContext();
  ctx.createMediaStreamSource(stream).connect(ctx.destination);
}

function triggerDownload(blob: Blob, sessionId: string): void {
  // Task-0.2 smoke-test aid only; replaced by OPFS-session + upload in Phase 1/2.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sessionId}.webm`;
  a.click();
  URL.revokeObjectURL(url);
}

browser.runtime.onMessage.addListener((message: Message) => {
  if (message.type === 'RECORDING_STARTED') {
    void (async () => {
      const stream = await openTabStream(message.streamId);
      playTabAudioLocally(stream);
      activeSessionId = message.sessionId;
      activeRecorder = new SessionRecorder(message.sessionId, stream, message.tier);
      activeRecorder.start();
      logger.info('offscreen recording started', { sessionId: message.sessionId });
    })();
  }
  if (message.type === 'STOP_RECORDING' && activeRecorder && activeSessionId === message.sessionId) {
    void (async () => {
      const blob = await activeRecorder!.stop();
      triggerDownload(blob, message.sessionId);
      activeRecorder = undefined;
      activeSessionId = undefined;
      logger.info('offscreen recording stopped, file downloaded', { sessionId: message.sessionId });
      await chrome.offscreen.closeDocument();
    })();
  }
});
```

- [ ] **Step 8: Wire background and popup**

`entrypoints/background.ts`:

```ts
import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import type { Message } from '@/src/shared/messages';
import { ChromeTabCaptureApi, ChromeOffscreenApi } from '@/src/adapters/chrome-api';
import { createLogger } from '@/src/core/logger';
import type { TierName } from '@/src/shared/config';

const logger = createLogger('background');
const tabCapture = new ChromeTabCaptureApi();
const offscreen = new ChromeOffscreenApi();

function makeSessionId(): string {
  return crypto.randomUUID();
}

export default defineBackground(() => {
  logger.info('service worker started');

  browser.runtime.onMessage.addListener((message: Message) => {
    if (message.type === 'START_RECORDING') {
      void (async () => {
        const streamId = await tabCapture.getMediaStreamId(message.tabId);
        await offscreen.ensureDocument(
          '/offscreen.html',
          ['USER_MEDIA'],
          'Recording the class session tab for teaching quality review.',
        );
        const sessionId = makeSessionId();
        const tier: TierName = 'MID';
        await browser.runtime.sendMessage({
          type: 'RECORDING_STARTED',
          sessionId,
          streamId,
          tier,
        } satisfies Message);
        logger.info('recording started', { sessionId, tabId: message.tabId });
      })();
    }
    if (message.type === 'STOP_RECORDING') {
      void browser.runtime.sendMessage(message);
    }
  });
});
```

`tier` is hardcoded to `'MID'` here as a placeholder for real device-tier detection, which Task 4 adds — noted there, not here.

`entrypoints/popup/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>1Study Class Recorder</title>
  </head>
  <body>
    <button id="start">Start</button>
    <button id="stop">Stop</button>
    <div id="status"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`entrypoints/popup/main.ts`:

```ts
import { browser } from 'wxt/browser';
import type { Message } from '@/src/shared/messages';
import { getActiveTab } from '@/src/adapters/chrome-api';
import { createLogger } from '@/src/core/logger';

const logger = createLogger('popup');
let currentSessionId: string | undefined;

const startBtn = document.querySelector<HTMLButtonElement>('#start')!;
const stopBtn = document.querySelector<HTMLButtonElement>('#stop')!;
const status = document.querySelector<HTMLDivElement>('#status')!;

startBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) {
    status.textContent = 'No active tab found.';
    return;
  }
  await browser.runtime.sendMessage({ type: 'START_RECORDING', tabId: tab.id } satisfies Message);
  status.textContent = 'Starting...';
});

stopBtn.addEventListener('click', async () => {
  if (!currentSessionId) return;
  await browser.runtime.sendMessage({ type: 'STOP_RECORDING', sessionId: currentSessionId } satisfies Message);
  status.textContent = 'Stopping...';
});

browser.runtime.onMessage.addListener((message: Message) => {
  if (message.type === 'RECORDING_STARTED') {
    currentSessionId = message.sessionId;
    status.textContent = `Recording session ${message.sessionId}`;
    logger.info('recording started in popup', { sessionId: message.sessionId });
  }
});
```

- [ ] **Step 9: Build and manually verify (spec Task 0.2 cases)**

Run: `npm run build`

Manual test (needs a real Google Meet room with at least 2 participants with cameras on):
1. Reload the unpacked extension in `chrome://extensions`.
2. Join the Meet room from two devices/accounts, both cameras on, layout set to **Tiled**.
3. On the teacher's tab, click the extension icon → click **Start**.
4. Wait 30 seconds, click **Stop**.
5. Open the downloaded `.webm` file.

Cases:
- [ ] The video shows the **full camera grid** (both participants), not just the active speaker.
- [ ] Student audio is present in the file.
- [ ] The teacher could still hear the student live during recording (confirms `playTabAudioLocally` is wired correctly).
- [ ] Switching Meet to Speaker view mid-recording changes what the next recording captures (confirms it's really recording the rendered tab view, not something else).

**Review checklist (spec Task 0.2):** no chunk array held in memory (R1 — confirmed by reading `recorder.ts`) · no canvas usage anywhere (R7) · offscreen document is closed after Stop (confirmed by the `chrome.offscreen.closeDocument()` call and by `chrome://extensions` showing no lingering offscreen document).

- [ ] **Step 10: Commit**

```bash
git add src/offscreen-logic/chunk-writer.ts src/offscreen-logic/recorder.ts entrypoints/
git commit -m "feat: capture tab via offscreen document and download a local WebM"
```

---

### Task 3: Mic Mixing + Audio Monitoring (spec Task 0.3 ⭐⭐)

**Files:**
- Create: `src/core/rms.ts`, `src/core/test/rms.test.ts`
- Create: `src/core/silence-tracker.ts`, `src/core/test/silence-tracker.test.ts`
- Create: `src/offscreen-logic/audio-mixer.ts` (manual-tested — `AudioContext`/`getUserMedia`)
- Create: `src/offscreen-logic/audio-monitor.ts` (manual-tested — `AnalyserNode`)
- Modify: `entrypoints/offscreen/main.ts`
- Modify: `entrypoints/content.ts`

**Interfaces:**
- Produces: `computeRms(samples: Float32Array): number`, `isSilent(rms): boolean`, `SILENCE_RMS_THRESHOLD`.
- Produces: `SilenceTracker.observe(silent: boolean): 'ALERT' | 'RECOVERED' | 'NONE'` — reused by Task 6's stall detector pattern (not the same class, but the same "consecutive-observation" shape).
- Produces: `mixTabAndMic(tabStream): Promise<MixResult>` where `MixResult = { mixedStream, ctx, tabSource, micSource }`.
- Produces: `AudioLevelMonitor` — `start()`/`stop()`, takes an `onEvent: (event) => void` callback.
- Consumes: `EventReporter.report()` and `EventBus` from Task 1.

- [ ] **Step 1: `computeRms`/`isSilent` — write the failing test**

`src/core/test/rms.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeRms, isSilent, SILENCE_RMS_THRESHOLD } from '../rms';

describe('computeRms', () => {
  it('is zero for silence', () => {
    expect(computeRms(new Float32Array([0, 0, 0, 0]))).toBe(0);
  });

  it('computes the root-mean-square of the samples', () => {
    const samples = new Float32Array([1, -1, 1, -1]);
    expect(computeRms(samples)).toBeCloseTo(1, 5);
  });

  it('returns 0 for an empty buffer instead of NaN', () => {
    expect(computeRms(new Float32Array([]))).toBe(0);
  });
});

describe('isSilent', () => {
  it('is true below the threshold', () => {
    expect(isSilent(SILENCE_RMS_THRESHOLD / 2)).toBe(true);
  });

  it('is false at or above the threshold', () => {
    expect(isSilent(SILENCE_RMS_THRESHOLD)).toBe(false);
    expect(isSilent(SILENCE_RMS_THRESHOLD * 2)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npm test -- rms.test.ts`
Expected: FAIL — `Cannot find module './rms'`.

- [ ] **Step 3: Implement `rms.ts`**

`src/core/rms.ts`:

```ts
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / samples.length);
}

export const SILENCE_RMS_THRESHOLD = 0.01;

export function isSilent(rms: number): boolean {
  return rms < SILENCE_RMS_THRESHOLD;
}
```

- [ ] **Step 4: Run it, confirm it passes, commit**

Run: `npm test -- rms.test.ts` → PASS

```bash
git add src/core/rms.ts src/core/test/rms.test.ts
git commit -m "feat: add RMS audio-level math"
```

- [ ] **Step 5: `SilenceTracker` — write the failing test**

`src/core/test/silence-tracker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SilenceTracker } from './silence-tracker';

describe('SilenceTracker', () => {
  it('does not alert before the threshold is reached', () => {
    const tracker = new SilenceTracker(60, 10);
    for (let i = 0; i < 5; i++) {
      expect(tracker.observe(true)).toBe('NONE');
    }
  });

  it('alerts exactly once when consecutive silence crosses the threshold', () => {
    const tracker = new SilenceTracker(60, 10);
    for (let i = 0; i < 5; i++) tracker.observe(true);
    expect(tracker.observe(true)).toBe('ALERT');
    expect(tracker.observe(true)).toBe('NONE');
  });

  it('reports RECOVERED the first time sound returns after an alert', () => {
    const tracker = new SilenceTracker(60, 10);
    for (let i = 0; i < 6; i++) tracker.observe(true);
    expect(tracker.observe(false)).toBe('RECOVERED');
    expect(tracker.observe(false)).toBe('NONE');
  });

  it('resets the counter on any non-silent observation before the threshold', () => {
    const tracker = new SilenceTracker(60, 10);
    tracker.observe(true);
    tracker.observe(true);
    tracker.observe(false);
    for (let i = 0; i < 5; i++) {
      expect(tracker.observe(true)).toBe('NONE');
    }
  });
});
```

- [ ] **Step 6: Run it, confirm it fails**

Run: `npm test -- silence-tracker.test.ts`
Expected: FAIL — `Cannot find module './silence-tracker'`.

- [ ] **Step 7: Implement `SilenceTracker`**

`src/core/silence-tracker.ts`:

```ts
export type SilenceEvent = 'ALERT' | 'RECOVERED' | 'NONE';

export class SilenceTracker {
  private silentSeconds = 0;
  private alerting = false;

  constructor(
    private readonly alertAfterSeconds: number,
    private readonly windowSeconds: number,
  ) {}

  observe(silent: boolean): SilenceEvent {
    if (silent) {
      this.silentSeconds += this.windowSeconds;
      if (!this.alerting && this.silentSeconds >= this.alertAfterSeconds) {
        this.alerting = true;
        return 'ALERT';
      }
      return 'NONE';
    }
    this.silentSeconds = 0;
    if (this.alerting) {
      this.alerting = false;
      return 'RECOVERED';
    }
    return 'NONE';
  }
}
```

- [ ] **Step 8: Run it, confirm it passes, commit**

Run: `npm test -- silence-tracker.test.ts` → PASS

```bash
git add src/core/silence-tracker.ts src/core/test/silence-tracker.test.ts
git commit -m "feat: add SilenceTracker for consecutive-silence alerting"
```

- [ ] **Step 9: Implement `audio-mixer.ts` (no automated test — `AudioContext`/`getUserMedia` are browser-only; verified manually in Step 12)**

`src/offscreen-logic/audio-mixer.ts`:

```ts
export interface MixResult {
  mixedStream: MediaStream;
  ctx: AudioContext;
  tabSource: MediaStreamAudioSourceNode;
  micSource: MediaStreamAudioSourceNode;
}

export async function mixTabAndMic(tabStream: MediaStream): Promise<MixResult> {
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const tabSource = ctx.createMediaStreamSource(tabStream);
  const micSource = ctx.createMediaStreamSource(micStream);

  const tabGain = ctx.createGain();
  tabGain.gain.value = 1.0;
  const micGain = ctx.createGain();
  micGain.gain.value = 1.0;

  tabSource.connect(tabGain).connect(dest);
  micSource.connect(micGain).connect(dest);
  tabSource.connect(ctx.destination); // required so the teacher still hears students (R4/R5)

  const mixedStream = new MediaStream([tabStream.getVideoTracks()[0]!, dest.stream.getAudioTracks()[0]!]);

  return { mixedStream, ctx, tabSource, micSource };
}
```

This replaces Task 2's `playTabAudioLocally` helper — that helper is removed in Step 11 below since `mixTabAndMic` already reconnects tab audio to `ctx.destination`.

- [ ] **Step 10: Implement `audio-monitor.ts` (no automated test — `AnalyserNode` is browser-only; verified manually in Step 12)**

`src/offscreen-logic/audio-monitor.ts`:

```ts
import { computeRms, isSilent } from '../core/rms';
import { SilenceTracker, type SilenceEvent } from '../core/silence-tracker';
import { CONFIG } from '../shared/config';

export class AudioLevelMonitor {
  private readonly analyser: AnalyserNode;
  private readonly buffer: Float32Array;
  private readonly tracker: SilenceTracker;
  private intervalId: ReturnType<typeof setInterval> | undefined;

  constructor(
    ctx: AudioContext,
    source: MediaStreamAudioSourceNode,
    private readonly onEvent: (event: SilenceEvent) => void,
  ) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buffer = new Float32Array(this.analyser.fftSize);
    source.connect(this.analyser);
    this.tracker = new SilenceTracker(CONFIG.SILENCE_ALERT_SECONDS, CONFIG.SILENCE_CHECK_INTERVAL_SECONDS);
  }

  start(): void {
    this.intervalId = setInterval(() => {
      this.analyser.getFloatTimeDomainData(this.buffer);
      const rms = computeRms(this.buffer);
      const event = this.tracker.observe(isSilent(rms));
      if (event !== 'NONE') this.onEvent(event);
    }, CONFIG.SILENCE_CHECK_INTERVAL_SECONDS * 1000);
  }

  stop(): void {
    if (this.intervalId !== undefined) clearInterval(this.intervalId);
  }
}
```

The buffer is allocated once in the constructor and reused every tick — no per-loop garbage (review note from spec Task 0.3).

- [ ] **Step 11: Wire mixing and monitoring into the offscreen entrypoint, and add banners to content.ts**

Replace the body of `entrypoints/offscreen/main.ts`'s `RECORDING_STARTED` handler and remove `playTabAudioLocally`:

```ts
import { browser } from 'wxt/browser';
import type { Message } from '@/src/shared/messages';
import { SessionRecorder } from '@/src/offscreen-logic/recorder';
import { mixTabAndMic } from '@/src/offscreen-logic/audio-mixer';
import { AudioLevelMonitor } from '@/src/offscreen-logic/audio-monitor';
import { EventReporter } from '@/src/core/event-reporter';
import { EventBus } from '@/src/core/event-bus';
import { ChromeStorageAdapter } from '@/src/adapters/storage';
import { createLogger } from '@/src/core/logger';
import type { RecordingEvent } from '@/src/core/event-reporter';

const logger = createLogger('offscreen');
const bus = new EventBus<{ event: RecordingEvent }>();
const eventReporter = new EventReporter(new ChromeStorageAdapter(), bus, logger);

let activeRecorder: SessionRecorder | undefined;
let activeSessionId: string | undefined;
let micMonitor: AudioLevelMonitor | undefined;
let tabMonitor: AudioLevelMonitor | undefined;

async function openTabStream(streamId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  } as MediaStreamConstraints);
}

function triggerDownload(blob: Blob, sessionId: string): void {
  // Task-0.2 smoke-test aid only; replaced by OPFS-session + upload in Phase 1/2.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sessionId}.webm`;
  a.click();
  URL.revokeObjectURL(url);
}

browser.runtime.onMessage.addListener((message: Message) => {
  if (message.type === 'RECORDING_STARTED') {
    void (async () => {
      const tabStream = await openTabStream(message.streamId);
      const { mixedStream, ctx, tabSource, micSource } = await mixTabAndMic(tabStream);

      activeSessionId = message.sessionId;
      activeRecorder = new SessionRecorder(message.sessionId, mixedStream, message.tier);
      activeRecorder.start();

      micMonitor = new AudioLevelMonitor(ctx, micSource, (event) => {
        void eventReporter.report('MIC_SILENT', { sessionId: message.sessionId });
        void browser.runtime.sendMessage({
          type: 'AUDIO_ALERT',
          source: 'mic',
          silent: event === 'ALERT',
        } satisfies Message);
      });
      tabMonitor = new AudioLevelMonitor(ctx, tabSource, (event) => {
        void eventReporter.report('TAB_AUDIO_SILENT', { sessionId: message.sessionId });
        void browser.runtime.sendMessage({
          type: 'AUDIO_ALERT',
          source: 'tab',
          silent: event === 'ALERT',
        } satisfies Message);
      });
      micMonitor.start();
      tabMonitor.start();

      logger.info('offscreen recording started', { sessionId: message.sessionId });
    })();
  }
  if (message.type === 'STOP_RECORDING' && activeRecorder && activeSessionId === message.sessionId) {
    void (async () => {
      micMonitor?.stop();
      tabMonitor?.stop();
      const blob = await activeRecorder!.stop();
      triggerDownload(blob, message.sessionId);
      activeRecorder = undefined;
      activeSessionId = undefined;
      logger.info('offscreen recording stopped, file downloaded', { sessionId: message.sessionId });
      await chrome.offscreen.closeDocument();
    })();
  }
});
```

`entrypoints/content.ts` — add a non-blocking banner that reacts to `AUDIO_ALERT`:

```ts
import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { createLogger } from '@/src/core/logger';
import type { Message } from '@/src/shared/messages';

const logger = createLogger('content');

let banner: HTMLDivElement | undefined;

function showBanner(text: string): void {
  if (!banner) {
    banner = document.createElement('div');
    banner.style.cssText =
      'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'background:#b91c1c;color:#fff;padding:8px 16px;border-radius:6px;font:14px sans-serif;';
    document.body.appendChild(banner);
  }
  banner.textContent = text;
  banner.style.display = 'block';
}

function hideBanner(): void {
  if (banner) banner.style.display = 'none';
}

export default defineContentScript({
  matches: ['*://meet.google.com/*'],
  main() {
    logger.info('content script loaded', { url: location.href });

    browser.runtime.onMessage.addListener((message: Message) => {
      if (message.type === 'AUDIO_ALERT') {
        if (message.silent) {
          showBanner(
            message.source === 'mic'
              ? '⚠ Không nghe thấy giọng bạn — kiểm tra micro'
              : '⚠ Không nghe thấy học sinh — kiểm tra âm thanh tab',
          );
        } else {
          hideBanner();
        }
      }
    });
  },
});
```

- [ ] **Step 12: Build and manually verify (spec Task 0.3 cases)**

Run: `npm run build`, reload the unpacked extension.

Manual test (needs a second person on the call, and ideally a headset):
1. Teacher speaks, student silent → recording clearly captures the teacher.
2. Student speaks, teacher silent → recording clearly captures the student.
3. Both speak at once → no distortion, no doubled/echoed audio.
4. Unplug the teacher's mic mid-recording → the "check your mic" banner appears within ≤70 seconds.
5. Switch from headset to external speakers → check for audible echo/feedback.
6. Turn on a fan/AC near the mic → compare recorded noise with `noiseSuppression` on vs. (temporarily) off.

Cases:
- [ ] Teacher's voice is present in the recording (R4).
- [ ] Student's voice is not duplicated.
- [ ] Mic-silent banner appears and disappears correctly (R6).
- [ ] Tab-audio-silent banner appears and disappears correctly.
- [ ] AGC doesn't audibly pump up background noise during silence.

**Review checklist (spec Task 0.3):** mic constraints always include `echoCancellation`/`noiseSuppression`/`autoGainControl` (R5) · `AnalyserNode` reuses one `Float32Array`, no per-tick allocation · `AudioLevelMonitor.stop()` always called before recorder teardown, no leaked interval.

- [ ] **Step 13: Commit**

```bash
git add src/core/rms.ts src/core/test/rms.test.ts src/core/silence-tracker.ts src/core/test/silence-tracker.test.ts \
        src/offscreen-logic/audio-mixer.ts src/offscreen-logic/audio-monitor.ts entrypoints/
git commit -m "feat: mix mic with tab audio and alert on sustained silence"
```

---

### Task 4: Device Tier + Codec Selection + 60-Minute Soak (spec Task 0.4 ⭐)

**Files:**
- Create: `src/core/device-tier.ts`, `src/core/test/device-tier.test.ts`
- Modify: `src/shared/messages.ts` (remove `tier` from `RECORDING_STARTED`)
- Modify: `entrypoints/background.ts` (stop sending a hardcoded tier)
- Modify: `entrypoints/offscreen/main.ts` (self-detect tier via `pickDeviceTier`)
- Create: `docs/task-0.4-codec-findings.md` (filled in during manual testing)

**Interfaces:**
- Produces: `pickDeviceTier(hints: DeviceHints): TierName` where `DeviceHints = { hardwareConcurrency: number; deviceMemoryGb: number | undefined }`.

- [ ] **Step 1: `pickDeviceTier` — write the failing test**

`src/core/test/device-tier.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pickDeviceTier } from './device-tier';

describe('pickDeviceTier', () => {
  it('is LOW when concurrency is at or below 4', () => {
    expect(pickDeviceTier({ hardwareConcurrency: 4, deviceMemoryGb: 8 })).toBe('LOW');
  });

  it('is LOW when memory is at or below 4GB even with many cores', () => {
    expect(pickDeviceTier({ hardwareConcurrency: 16, deviceMemoryGb: 4 })).toBe('LOW');
  });

  it('is HIGH only when both concurrency >= 8 and memory >= 8', () => {
    expect(pickDeviceTier({ hardwareConcurrency: 8, deviceMemoryGb: 8 })).toBe('HIGH');
  });

  it('is MID when it is neither the LOW nor the HIGH case', () => {
    expect(pickDeviceTier({ hardwareConcurrency: 6, deviceMemoryGb: 8 })).toBe('MID');
    expect(pickDeviceTier({ hardwareConcurrency: 8, deviceMemoryGb: 6 })).toBe('MID');
  });

  it('treats missing deviceMemory as 4GB, not as automatically LOW', () => {
    expect(pickDeviceTier({ hardwareConcurrency: 6, deviceMemoryGb: undefined })).toBe('MID');
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npm test -- device-tier.test.ts`
Expected: FAIL — `Cannot find module './device-tier'`.

- [ ] **Step 3: Implement `pickDeviceTier`**

`src/core/device-tier.ts`:

```ts
import type { TierName } from '../shared/config';

export interface DeviceHints {
  hardwareConcurrency: number;
  deviceMemoryGb: number | undefined;
}

export function pickDeviceTier(hints: DeviceHints): TierName {
  const memory = hints.deviceMemoryGb ?? 4; // navigator.deviceMemory is unsupported in some browsers
  if (hints.hardwareConcurrency <= 4 || memory <= 4) return 'LOW';
  if (hints.hardwareConcurrency >= 8 && memory >= 8) return 'HIGH';
  return 'MID';
}
```

- [ ] **Step 4: Run it, confirm it passes, commit**

Run: `npm test -- device-tier.test.ts` → PASS

```bash
git add src/core/device-tier.ts src/core/test/device-tier.test.ts
git commit -m "feat: add device-tier selection from hardwareConcurrency/deviceMemory"
```

- [ ] **Step 5: Move tier selection from background to offscreen**

`navigator.deviceMemory` reads more reliably from a full document context than from the service worker, so the offscreen document determines its own tier instead of being told one. Edit `src/shared/messages.ts`:

```ts
export type Message =
  | { type: 'START_RECORDING'; tabId: number }
  | { type: 'STOP_RECORDING'; sessionId: string }
  | { type: 'RECORDING_STARTED'; sessionId: string; streamId: string }
  | { type: 'RECORDING_STATE'; sessionId: string; state: SessionState; elapsedMs: number }
  | { type: 'AUDIO_ALERT'; source: 'mic' | 'tab'; silent: boolean }
  | { type: 'VIDEO_STALLED'; sessionId: string; gapMs: number; atMs: number }
  | { type: 'GUARD_RESULT'; allowed: boolean; reason?: string };
```

(`TierName` import is no longer needed in this file — remove it.)

Edit `entrypoints/background.ts` — remove the `tier` local and the `TierName` import, and stop including `tier` in the sent message:

```ts
await browser.runtime.sendMessage({
  type: 'RECORDING_STARTED',
  sessionId,
  streamId,
} satisfies Message);
```

Edit `entrypoints/offscreen/main.ts` — compute the tier locally when a session starts:

```ts
import { pickDeviceTier } from '@/src/core/device-tier';

// ...inside the RECORDING_STARTED handler, before constructing SessionRecorder:
const tier = pickDeviceTier({
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
});
activeRecorder = new SessionRecorder(message.sessionId, mixedStream, tier);
```

- [ ] **Step 6: Type-check and build**

Run: `npx tsc --noEmit` then `npm run build` — expect no errors.

```bash
git add src/shared/messages.ts entrypoints/background.ts entrypoints/offscreen/main.ts
git commit -m "refactor: offscreen self-detects device tier instead of background guessing MID"
```

- [ ] **Step 7: 60-minute soak test on the lowest-spec teacher machine**

Manual test:
1. On the lowest-spec machine available (target: i3/4GB), join a real Meet room and record continuously for 60 minutes via the popup Start button.
2. Every 10 minutes, record Chrome Task Manager (Shift+Esc) numbers for the offscreen document's memory and Chrome's total CPU, plus the OS Task Manager's system-wide CPU.
3. At the end, Stop and open the downloaded file.

Cases:
- [ ] No crash across the full 60 minutes.
- [ ] Offscreen document memory is **stable** across the 10-minute samples, not trending upward (a steady climb means R1 is being violated somewhere — check that nothing is buffering blobs).
- [ ] Chrome's total CPU increase versus Meet-only baseline is under 25%.
- [ ] The other participant reports no noticeable call-quality drop.
- [ ] The final file opens and is not corrupted.
- [ ] The file's duration matches the actual recording time.

- [ ] **Step 8: VP9 vs VP8 codec experiment (mandatory, spec Task 0.4)**

On the **same low-tier machine**, record 20 minutes at `CONFIG.TIERS.MID`'s resolution/fps with VP9 forced, then 20 minutes with VP8 forced (temporarily hardcode the codec list passed to `pickMimeType` for this experiment; revert after).

Fill in `docs/task-0.4-codec-findings.md`:

```markdown
# Task 0.4 — VP9 vs VP8 codec findings

Machine: <spec>

| Metric | VP9 | VP8 |
|---|---|---|
| Average Chrome CPU | | |
| Dropped frames | | |
| Output file size | | |
| Other participant's call-quality score (1-5) | | |

Decision: <keep MID on VP9,VP8 fallback | change MID's codecs to ['vp8'] only>
```

If VP9 drops frames or degrades call quality on the low-tier machine, change `CONFIG.TIERS.MID.codecs` in `src/shared/config.ts` from `['vp9', 'vp8']` to `['vp8']` and update `src/shared/test/config.test.ts`'s corresponding assertion, then re-run `npm test`.

**Review checklist (spec Task 0.4):** `pickMimeType`'s fallback chain is feature-detected, not hardcoded (R11) · codec choice is tied to `TierName`, never hardcoded elsewhere · bitrate values are explicit in `CONFIG`, no inline magic numbers · tier selection is based on `hardwareConcurrency`/`deviceMemory`, not a fixed default · `pickDeviceTier` is a standalone Strategy-style function, not embedded in `recorder.ts`.

- [ ] **Step 9: Commit findings**

```bash
git add docs/task-0.4-codec-findings.md src/shared/config.ts src/shared/test/config.test.ts
git commit -m "docs: record VP9 vs VP8 findings and adjust MID tier codec if needed"
```

---

### Task 5: Tab Guard (spec Task 0.5)

**Files:**
- Create: `src/core/meeting-code.ts`, `src/core/test/meeting-code.test.ts`
- Create: `src/core/tab-guard.ts`, `src/core/test/tab-guard.test.ts`
- Modify: `entrypoints/background.ts` (re-validate the guard server-side of the extension, and enable/disable the action icon per tab)
- Modify: `entrypoints/popup/main.ts` (run the guard on popup open, disable Start + explain when blocked)

**Interfaces:**
- Produces: `extractMeetingCode(url): string | null`, `isMeetUrl(url): boolean`.
- Produces: `evaluateGuard(isMeet, actualCode, scheduledCode): GuardResult` where `GuardResult = { allowed: true } | { allowed: false; reason: 'NOT_MEET_TAB' } | { allowed: false; reason: 'MEETING_CODE_MISMATCH'; actualCode: string }`.

Phase 0 has no LMS schedule yet, so `scheduledCode` is always `undefined` in the wiring below — the mismatch branch is proven correct by its unit tests now, ready for Phase 3 (Task 3.3) to supply a real scheduled code.

- [ ] **Step 1: `meeting-code.ts` — write the failing test**

`src/core/test/meeting-code.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractMeetingCode, isMeetUrl } from '../meeting-code';

describe('extractMeetingCode', () => {
  it('extracts the code from a plain Meet URL', () => {
    expect(extractMeetingCode('https://meet.google.com/abc-defg-hij')).toBe('abc-defg-hij');
  });

  it('extracts the code when the URL has a query string or hash', () => {
    expect(extractMeetingCode('https://meet.google.com/abc-defg-hij?authuser=0')).toBe('abc-defg-hij');
    expect(extractMeetingCode('https://meet.google.com/abc-defg-hij#foo')).toBe('abc-defg-hij');
  });

  it('normalizes the code to lowercase', () => {
    expect(extractMeetingCode('https://meet.google.com/ABC-DEFG-HIJ')).toBe('abc-defg-hij');
  });

  it('returns null for a non-Meet URL', () => {
    expect(extractMeetingCode('https://youtube.com/watch?v=abc')).toBeNull();
  });

  it('returns null for the Meet landing page with no room code', () => {
    expect(extractMeetingCode('https://meet.google.com/')).toBeNull();
    expect(extractMeetingCode('https://meet.google.com/landing')).toBeNull();
  });
});

describe('isMeetUrl', () => {
  it('is true for any meet.google.com URL', () => {
    expect(isMeetUrl('https://meet.google.com/abc-defg-hij')).toBe(true);
  });

  it('is false for other domains', () => {
    expect(isMeetUrl('https://youtube.com/')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npm test -- meeting-code.test.ts`
Expected: FAIL — `Cannot find module './meeting-code'`.

- [ ] **Step 3: Implement `meeting-code.ts`**

`src/core/meeting-code.ts`:

```ts
const MEET_URL_PATTERN = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#].*)?$/i;

export function extractMeetingCode(url: string): string | null {
  const match = MEET_URL_PATTERN.exec(url);
  return match ? match[1].toLowerCase() : null;
}

export function isMeetUrl(url: string): boolean {
  return url.startsWith('https://meet.google.com/');
}
```

- [ ] **Step 4: Run it, confirm it passes, commit**

Run: `npm test -- meeting-code.test.ts` → PASS

```bash
git add src/core/meeting-code.ts src/core/test/meeting-code.test.ts
git commit -m "feat: extract and validate Google Meet meeting codes from a URL"
```

- [ ] **Step 5: `tab-guard.ts` — write the failing test**

`src/core/test/tab-guard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { evaluateGuard } from '../tab-guard';

describe('evaluateGuard', () => {
  it('allows a Meet tab with a valid code when there is no scheduled code to check', () => {
    expect(evaluateGuard(true, 'abc-defg-hij', undefined)).toEqual({ allowed: true });
  });

  it('blocks a non-Meet tab', () => {
    expect(evaluateGuard(false, null, undefined)).toEqual({ allowed: false, reason: 'NOT_MEET_TAB' });
  });

  it('blocks a Meet URL with no extractable code', () => {
    expect(evaluateGuard(true, null, undefined)).toEqual({ allowed: false, reason: 'NOT_MEET_TAB' });
  });

  it('blocks when the actual code does not match the scheduled code', () => {
    expect(evaluateGuard(true, 'abc-defg-hij', 'xyz-wxyz-xyz')).toEqual({
      allowed: false,
      reason: 'MEETING_CODE_MISMATCH',
      actualCode: 'abc-defg-hij',
    });
  });

  it('allows when the actual code matches the scheduled code', () => {
    expect(evaluateGuard(true, 'abc-defg-hij', 'abc-defg-hij')).toEqual({ allowed: true });
  });
});
```

- [ ] **Step 6: Run it, confirm it fails**

Run: `npm test -- tab-guard.test.ts`
Expected: FAIL — `Cannot find module './tab-guard'`.

- [ ] **Step 7: Implement `tab-guard.ts`**

`src/core/tab-guard.ts`:

```ts
export type GuardResult =
  | { allowed: true }
  | { allowed: false; reason: 'NOT_MEET_TAB' }
  | { allowed: false; reason: 'MEETING_CODE_MISMATCH'; actualCode: string };

export function evaluateGuard(
  isMeet: boolean,
  actualCode: string | null,
  scheduledCode: string | undefined,
): GuardResult {
  if (!isMeet || !actualCode) return { allowed: false, reason: 'NOT_MEET_TAB' };
  if (scheduledCode && actualCode !== scheduledCode) {
    return { allowed: false, reason: 'MEETING_CODE_MISMATCH', actualCode };
  }
  return { allowed: true };
}
```

- [ ] **Step 8: Run it, confirm it passes, commit**

Run: `npm test -- tab-guard.test.ts` → PASS

```bash
git add src/core/tab-guard.ts src/core/test/tab-guard.test.ts
git commit -m "feat: add tab-guard decision logic"
```

- [ ] **Step 9: Wire the guard into background.ts (icon enable/disable + defense-in-depth re-check)**

Add to `entrypoints/background.ts` (inside `defineBackground`, alongside the existing message listener):

```ts
import { isMeetUrl, extractMeetingCode } from '@/src/core/meeting-code';
import { evaluateGuard } from '@/src/core/tab-guard';

async function refreshActionState(tabId: number, url: string | undefined): Promise<void> {
  if (url && isMeetUrl(url)) {
    await chrome.action.enable(tabId);
  } else {
    await chrome.action.disable(tabId);
  }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') void refreshActionState(tabId, tab.url);
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await browser.tabs.get(tabId);
  void refreshActionState(tabId, tab.url);
});
```

Change the `START_RECORDING` handler to re-validate the guard using the explicit `message.tabId` (never "whatever tab is currently active") before doing anything else:

```ts
if (message.type === 'START_RECORDING') {
  void (async () => {
    const tab = await browser.tabs.get(message.tabId);
    const guard = evaluateGuard(isMeetUrl(tab.url ?? ''), extractMeetingCode(tab.url ?? ''), undefined);
    if (!guard.allowed) {
      logger.warn('blocked start: guard failed', guard);
      await browser.runtime.sendMessage({ type: 'GUARD_RESULT', allowed: false, reason: guard.reason } satisfies Message);
      return;
    }
    const streamId = await tabCapture.getMediaStreamId(message.tabId);
    // ...unchanged from Task 2/4: ensureDocument, makeSessionId, send RECORDING_STARTED
  })();
}
```

This re-check exists because the popup's own guard check (Step 10) is UI-only and must not be trusted — the service worker enforces it independently (spec review note: "guard nằm ở cả popup lẫn service worker").

- [ ] **Step 10: Wire the guard into the popup**

Edit `entrypoints/popup/main.ts` — check the guard as soon as the popup opens, and disable Start with an explanation when blocked:

```ts
import { isMeetUrl, extractMeetingCode } from '@/src/core/meeting-code';
import { evaluateGuard } from '@/src/core/tab-guard';

async function applyGuard(): Promise<void> {
  const tab = await getActiveTab();
  const guard = evaluateGuard(!!tab && isMeetUrl(tab.url), tab ? extractMeetingCode(tab.url) : null, undefined);
  if (guard.allowed) {
    startBtn.disabled = false;
    status.textContent = 'Ready to record this Meet tab.';
    return;
  }
  startBtn.disabled = true;
  status.textContent =
    guard.reason === 'NOT_MEET_TAB'
      ? 'Open a Google Meet class tab first, then click the extension icon again.'
      : `This tab's meeting code doesn't match the scheduled class (${guard.actualCode}). Confirm before recording.`;
}

void applyGuard();
```

(`startBtn.disabled = false` should also be the default in `index.html`'s markup removed — leave the `<button id="start">Start</button>` as-is; `applyGuard()` sets the actual enabled state on load.)

- [ ] **Step 11: Build and manually verify (spec Task 0.5 cases)**

Run: `npm run build`, reload the unpacked extension.

Manual test:
1. On a YouTube tab, click the icon → confirm the icon is greyed out / Start is disabled with a clear message.
2. On a Meet tab with a room code, click the icon → confirm Start is enabled and recording works.
3. Open two different Meet rooms in two tabs → start recording from tab A → confirm the session stays bound to tab A's `tabId` even if tab B becomes active.
4. While recording from tab A, close tab A and open a new Meet tab (different room) → confirm the original session is not hijacked by the new tab.
5. Watch the action icon while switching between a Meet tab and a non-Meet tab → confirm it toggles enabled/disabled live via `onActivated`/`onUpdated`.

**Review checklist (spec Task 0.5):** `START_RECORDING` always carries an explicit `tabId` captured at click time, never an implicit "current active tab" re-query inside the offscreen/background async flow · the guard is enforced in both the popup (UX) and the background (source of truth) · disabling the icon never interrupts an already-running recording (R12) — only blocks starting a new one from an ineligible tab.

- [ ] **Step 12: Commit**

```bash
git add entrypoints/background.ts entrypoints/popup/main.ts entrypoints/popup/index.html
git commit -m "feat: guard recording start to the correct active Meet tab"
```

---

### Task 6: Tab-Switch Behavior + Stall Detection (spec Task 0.6 ⭐⭐, R13)

**Files:**
- Create: `src/core/stall-detector.ts`, `src/core/test/stall-detector.test.ts`
- Create: `src/offscreen-logic/frame-monitor.ts` (manual-tested — `<video>`/`requestVideoFrameCallback` are browser-only)
- Modify: `entrypoints/offscreen/main.ts` (wire the frame monitor, report `VIDEO_STALLED`)
- Modify: `entrypoints/content.ts` (add the `visibilitychange` "you were away" notice)
- Create: `docs/task-0.6-findings.md` (filled in during manual testing; drives the conditional step below)

**Interfaces:**
- Produces: `StallDetector` — `onFrame(): StallEvent | undefined`, `checkForStall(): StallEvent | undefined`, where `StallEvent = { type: 'STALLED'; gapMs: number; atMs: number } | { type: 'RECOVERED'; atMs: number }`. Constructor takes an injectable clock (`now: () => number`) so it's testable without real timers.
- Produces: `startFrameMonitor(stream, onEvent): () => void` (the returned function tears the monitor down).

- [ ] **Step 1: `StallDetector` — write the failing test**

`src/core/test/stall-detector.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { StallDetector } from './stall-detector';

function makeClock(startMs = 0) {
  let now = startMs;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('StallDetector', () => {
  it('reports no stall while frames keep arriving within the threshold', () => {
    const clock = makeClock();
    const detector = new StallDetector(3000, clock.now);
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      expect(detector.onFrame()).toBeUndefined();
    }
  });

  it('checkForStall reports STALLED once the gap exceeds the threshold', () => {
    const clock = makeClock();
    const detector = new StallDetector(3000, clock.now);
    detector.onFrame();
    clock.advance(3500);
    const event = detector.checkForStall();
    expect(event).toEqual({ type: 'STALLED', gapMs: 3500, atMs: 3500 });
  });

  it('does not re-report STALLED on a subsequent check while still stalled', () => {
    const clock = makeClock();
    const detector = new StallDetector(3000, clock.now);
    detector.onFrame();
    clock.advance(3500);
    detector.checkForStall();
    clock.advance(1000);
    expect(detector.checkForStall()).toBeUndefined();
  });

  it('onFrame reports RECOVERED the first time a frame arrives after a stall', () => {
    const clock = makeClock();
    const detector = new StallDetector(3000, clock.now);
    detector.onFrame();
    clock.advance(3500);
    detector.checkForStall();
    clock.advance(100);
    expect(detector.onFrame()).toEqual({ type: 'RECOVERED', atMs: 3600 });
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npm test -- stall-detector.test.ts`
Expected: FAIL — `Cannot find module './stall-detector'`.

- [ ] **Step 3: Implement `StallDetector`**

`src/core/stall-detector.ts`:

```ts
export type StallEvent = { type: 'STALLED'; gapMs: number; atMs: number } | { type: 'RECOVERED'; atMs: number };

export class StallDetector {
  private lastFrameAtMs: number;
  private stalled = false;

  constructor(
    private readonly stallThresholdMs: number,
    private readonly now: () => number,
  ) {
    this.lastFrameAtMs = now();
  }

  /** Call every time a real frame arrives (e.g. from requestVideoFrameCallback). */
  onFrame(): StallEvent | undefined {
    const at = this.now();
    this.lastFrameAtMs = at;
    if (this.stalled) {
      this.stalled = false;
      return { type: 'RECOVERED', atMs: at };
    }
    return undefined;
  }

  /** Call on a periodic tick independent of frame arrival, to catch a stall in progress. */
  checkForStall(): StallEvent | undefined {
    const at = this.now();
    const gapMs = at - this.lastFrameAtMs;
    if (!this.stalled && gapMs >= this.stallThresholdMs) {
      this.stalled = true;
      return { type: 'STALLED', gapMs, atMs: at };
    }
    return undefined;
  }
}
```

- [ ] **Step 4: Run it, confirm it passes, commit**

Run: `npm test -- stall-detector.test.ts` → PASS

```bash
git add src/core/stall-detector.ts src/core/test/stall-detector.test.ts
git commit -m "feat: add StallDetector for R13 frame-freeze detection"
```

- [ ] **Step 5: Implement `frame-monitor.ts` (no automated test — `<video>`/rVFC are browser-only; verified manually in Step 7)**

`src/offscreen-logic/frame-monitor.ts`:

```ts
import { StallDetector, type StallEvent } from '../core/stall-detector';
import { CONFIG } from '../shared/config';

export function startFrameMonitor(stream: MediaStream, onEvent: (event: StallEvent) => void): () => void {
  const video = document.createElement('video');
  video.srcObject = new MediaStream([stream.getVideoTracks()[0]!]);
  video.muted = true;
  void video.play();

  const detector = new StallDetector(CONFIG.STALL_GAP_MS, () => Date.now());

  const onFrameCallback = () => {
    const event = detector.onFrame();
    if (event) onEvent(event);
    video.requestVideoFrameCallback(onFrameCallback);
  };
  video.requestVideoFrameCallback(onFrameCallback);

  const intervalId = setInterval(() => {
    const event = detector.checkForStall();
    if (event) onEvent(event);
  }, 1000);

  return () => {
    clearInterval(intervalId);
    video.pause();
    video.srcObject = null;
  };
}
```

- [ ] **Step 6: Wire the frame monitor into offscreen, and add the visibility notice to content.ts**

Edit `entrypoints/offscreen/main.ts` — start the monitor alongside the recorder, report `VIDEO_STALLED`, and stop it on Stop:

```ts
import { startFrameMonitor } from '@/src/offscreen-logic/frame-monitor';

// module-level, alongside the other `let` declarations:
let stopFrameMonitor: (() => void) | undefined;

// inside the RECORDING_STARTED handler, after activeRecorder.start():
stopFrameMonitor = startFrameMonitor(mixedStream, (event) => {
  if (event.type === 'STALLED') {
    void eventReporter.report('VIDEO_STALLED', { sessionId: message.sessionId, gapMs: event.gapMs });
    void browser.runtime.sendMessage({
      type: 'VIDEO_STALLED',
      sessionId: message.sessionId,
      gapMs: event.gapMs,
      atMs: event.atMs,
    } satisfies Message);
  }
});

// inside the STOP_RECORDING handler, alongside micMonitor?.stop()/tabMonitor?.stop():
stopFrameMonitor?.();
```

Edit `entrypoints/content.ts` — add a `visibilitychange` listener that reuses `showBanner`:

```ts
let hiddenAtMs: number | undefined;

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAtMs = Date.now();
    return;
  }
  if (hiddenAtMs === undefined) return;
  const awayMinutes = Math.round((Date.now() - hiddenAtMs) / 60000);
  hiddenAtMs = undefined;
  if (awayMinutes >= 1) {
    showBanner(`Bạn đã rời tab lớp học ${awayMinutes} phút — đoạn đó có thể không được ghi hình.`);
  }
});
```

This notice is informational only (R12) — it never blocks anything, it just tells the teacher which window of time might be missing.

- [ ] **Step 7: Build and run the empirical tab-switch test matrix (spec Task 0.6)**

Run: `npm run build`, reload the unpacked extension.

Manual test — for each scenario below, start recording in a Meet room with ≥2 cameras on, perform the scenario for 2 minutes, return, record 1 more minute, stop, then cross-check the downloaded video against the offscreen console's `VIDEO_STALLED` logs:

1. Switch to a different tab in the same window for 2 minutes, do normal work there, switch back.
2. Repeat with the Meet tab moved to its own Chrome window, that window not focused.
3. Repeat with the entire Chrome window minimized.
4. Repeat while screen-sharing is active.
5. While doing (1), separately confirm in the offscreen console that the recorder/monitor/uploader kept running the whole time (independent of tab focus).

Fill in `docs/task-0.6-findings.md`:

```markdown
# Task 0.6 — Tab-switch freeze findings

| Scenario | Video froze? | Student (tab) audio lost? | Teacher (mic) audio lost? |
|---|---|---|---|
| Same-window tab switch, 2 min | | | |
| Dedicated unfocused window, 2 min | | | |
| Chrome minimized, 2 min | | | |
| Screen-sharing active | | | |

Offscreen/uploader kept running independent of tab focus: <yes/no>

Decision (per spec's table):
- [ ] No freeze in any scenario → detection-only is sufficient, no further change needed.
- [ ] Freezes on tab switch but NOT in a dedicated window → mandate dedicated-window recording (see Step 8).
- [ ] Freezes even in a dedicated window → STOP. This is a serious blocker — do not proceed past Phase 0. Report back with these findings before any further implementation.
```

- [ ] **Step 8 (conditional — only if the findings above say "freezes on tab switch but not in a dedicated window"):** change the popup's Start flow to open the Meet room in its own Chrome window via `chrome.windows.create` instead of operating on the current tab, and re-run the manual test to confirm the dedicated window doesn't freeze. If the findings say anything else, skip this step (mark it not-applicable in the findings doc and move on).

**Review checklist (spec Task 0.6):** stall detection is implemented and wired regardless of what the findings turned out to be · `visibilitychange` handling lives in `content.ts`, not tied to any `setInterval` for its core timing (it's an event listener, and the frame-monitor's own timing runs inside the offscreen document, not a content-script timer — satisfies R13's "no important logic in a content-script setInterval").

- [ ] **Step 9: Commit**

```bash
git add src/core/stall-detector.ts src/core/test/stall-detector.test.ts src/offscreen-logic/frame-monitor.ts \
        entrypoints/offscreen/main.ts entrypoints/content.ts docs/task-0.6-findings.md
git commit -m "feat: detect video stalls on tab switch and notify the teacher (R13)"
```

---

## Phase 0 Exit Gate

Per the spec's own working rules: do not consider Phase 0 done until all 6 tasks' case checklists are fully checked, and until a real 60-minute class recording has been captured showing the full student grid with both sides audible — using this organized code, not a throwaway spike. If Task 0.2 never produces the camera grid (only the active speaker), stop and report back immediately; everything after that task is moot until it's resolved.

Once the gate passes, next step is a walkthrough of loading the extension into a real Chrome profile for hands-on testing (`chrome://extensions` → Developer mode → Load unpacked, already exercised at the end of Task 1) and, later, the Chrome Web Store Unlisted publishing flow (spec Task 5.3) — the latter is out of scope until Phase 5.
