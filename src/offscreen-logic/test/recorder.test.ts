import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionRecorder, type SessionRecorderCallbacks } from '../recorder';
import type { ChunkWriterLike, ReadAllResult } from '../chunk-writer';
import { CONFIG } from '../../shared/config';

/**
 * jsdom (this project's Vitest environment) does not implement
 * `MediaRecorder` at all — confirmed by probing `typeof MediaRecorder` inside
 * a real test run, which comes back `undefined`. `SessionRecorder.start()`
 * calls `new MediaRecorder(...)` and `MediaRecorder.isTypeSupported(...)`
 * directly against the global, so there is no way to drive its
 * `ondataavailable` handler — the actual seam this class's memory-fallback
 * logic hangs off — without a stand-in for that global. This is the (a)
 * option from Finding 4: a minimal fake implementing just the surface
 * `SessionRecorder` touches (`constructor`, `start(timeslice)`, `stop()`,
 * settable `ondataavailable`/`onstop`, and the static `isTypeSupported`
 * `pickMimeType` calls), installed as `globalThis.MediaRecorder` for the
 * duration of this file. Every instance is recorded in `instances` so a test
 * can reach in and fire `ondataavailable`/`stop()` exactly the way a real
 * `MediaRecorder` would drive `SessionRecorder`'s handler.
 */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(_type: string): boolean {
    return true;
  }

  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(
    public readonly stream: unknown,
    public readonly options: Record<string, unknown>,
  ) {
    FakeMediaRecorder.instances.push(this);
  }

  start(_timesliceMs?: number): void {}

  stop(): void {
    // A real MediaRecorder fires `onstop` asynchronously, never synchronously
    // within the call to stop() — mirror that instead of resolving immediately,
    // so SessionRecorder.stop()'s own await behaves the same way it would for
    // real.
    queueMicrotask(() => this.onstop?.());
  }
}

/** Waits out every pending microtask (and one macrotask) — enough for the write()-then-callback chains in SessionRecorder to fully settle. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function makeBlob(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

type ScriptedOutcome = 'ok' | Error;

/** A ChunkWriterLike whose write() outcomes (per call, in order) are scripted up front and resolve/reject immediately. */
class ScriptedChunkWriter implements ChunkWriterLike {
  readonly writeCalls: Blob[] = [];
  private nextIndex = 0;
  private readonly succeeded = new Map<number, Blob>();

  constructor(private readonly outcomes: ScriptedOutcome[]) {}

  async write(blob: Blob): Promise<number> {
    const index = this.nextIndex++;
    this.writeCalls.push(blob);
    const outcome = this.outcomes[index] ?? 'ok';
    if (outcome === 'ok') {
      this.succeeded.set(index, blob);
      return index;
    }
    throw outcome;
  }

  async readAll(): Promise<ReadAllResult> {
    const parts: Blob[] = [];
    const missingIndices: number[] = [];
    for (let i = 0; i < this.nextIndex; i++) {
      const blob = this.succeeded.get(i);
      if (blob) parts.push(blob);
      else missingIndices.push(i);
    }
    return { blob: new Blob(parts), missingIndices };
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A ChunkWriterLike whose write() calls stay pending until the test resolves/rejects them by hand — for exercising true "both in flight at once" races. */
class ManualChunkWriter implements ChunkWriterLike {
  readonly calls: Deferred<number>[] = [];
  private nextIndex = 0;

  write(_blob: Blob): Promise<number> {
    this.nextIndex++;
    const d = defer<number>();
    this.calls.push(d);
    return d.promise;
  }

  async readAll(): Promise<ReadAllResult> {
    return { blob: new Blob([]), missingIndices: [] };
  }
}

const invalidStateError = () => new DOMException('no space left', 'InvalidStateError');

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
});

afterEach(() => {
  delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
});

function startRecorder(
  writer: ChunkWriterLike,
  callbacks: SessionRecorderCallbacks = {},
): { recorder: SessionRecorder; mr: FakeMediaRecorder } {
  const recorder = new SessionRecorder('s1', {} as MediaStream, callbacks, writer);
  recorder.start();
  const mr = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1]!;
  return { recorder, mr };
}

describe('SessionRecorder memory-fallback logic', () => {
  it('writes a chunk via the injected writer and fires onChunkWritten with its index and byte size', async () => {
    const writer = new ScriptedChunkWriter(['ok']);
    const onChunkWritten = vi.fn();
    const { mr } = startRecorder(writer, { onChunkWritten });

    mr.ondataavailable?.({ data: makeBlob(123) });
    await flush();

    expect(writer.writeCalls).toHaveLength(1);
    expect(onChunkWritten).toHaveBeenCalledTimes(1);
    expect(onChunkWritten).toHaveBeenCalledWith(0, 123);
  });

  it('falls back to the memory buffer on InvalidStateError, firing onStorageDegraded once and never calling writer.write() again', async () => {
    const writer = new ScriptedChunkWriter(['ok', invalidStateError()]);
    const onStorageDegraded = vi.fn();
    const { mr } = startRecorder(writer, { onStorageDegraded });

    mr.ondataavailable?.({ data: makeBlob(100) }); // index 0: ok
    await flush();
    expect(onStorageDegraded).not.toHaveBeenCalled();

    mr.ondataavailable?.({ data: makeBlob(200) }); // index 1: InvalidStateError -> trips fallback
    await flush();
    expect(onStorageDegraded).toHaveBeenCalledTimes(1);
    expect(writer.writeCalls).toHaveLength(2);

    // Now in memory mode: further chunks must never reach writer.write() again.
    mr.ondataavailable?.({ data: makeBlob(300) }); // index 2
    mr.ondataavailable?.({ data: makeBlob(400) }); // index 3
    await flush();

    expect(writer.writeCalls).toHaveLength(2);
    expect(onStorageDegraded).toHaveBeenCalledTimes(1);
  });

  it('does not report the chunk that tripped the InvalidStateError fallback as missing, since its bytes landed via the memory buffer', async () => {
    const writer = new ScriptedChunkWriter(['ok', invalidStateError(), 'ok']);
    const { recorder, mr } = startRecorder(writer);

    mr.ondataavailable?.({ data: makeBlob(100) }); // index 0: ok (opfs)
    await flush();
    mr.ondataavailable?.({ data: makeBlob(200) }); // index 1: fails -> fallback, also lands in memory buffer
    await flush();
    mr.ondataavailable?.({ data: makeBlob(300) }); // index 2: memory mode, writer.write() never called for this one
    await flush();

    const result = await recorder.stop();

    expect(result.missingChunkIndices).toEqual([]);
    // Sanity: writer.readAll() on its own would have reported index 1 as
    // missing (its write() failed) — SessionRecorder.stop() is responsible
    // for reconciling that against the memory buffer.
    const rawReadAll = await writer.readAll();
    expect(rawReadAll.missingIndices).toEqual([1]);
  });

  it('fires onStorageDegraded exactly once when two writes are simultaneously in flight and both reject with InvalidStateError', async () => {
    const writer = new ManualChunkWriter();
    const onStorageDegraded = vi.fn();
    const { mr } = startRecorder(writer, { onStorageDegraded });

    // Both chunks dispatched before either write() has settled — genuinely
    // concurrent from SessionRecorder's point of view.
    mr.ondataavailable?.({ data: makeBlob(100) }); // index 0
    mr.ondataavailable?.({ data: makeBlob(100) }); // index 1
    expect(writer.calls).toHaveLength(2);

    const err = invalidStateError();
    // Reject both before letting the microtask queue drain — this is the
    // "neither has resolved yet" race the guard (storageMode checked
    // synchronously inside each rejection handler) has to survive.
    writer.calls[0]!.reject(err);
    writer.calls[1]!.reject(err);
    await flush();

    expect(onStorageDegraded).toHaveBeenCalledTimes(1);
  });

  it('fires onMemoryBufferFull exactly once when the memory buffer is active and its byte cap is first exceeded', async () => {
    const writer = new ScriptedChunkWriter([invalidStateError()]);
    const onMemoryBufferFull = vi.fn();
    const { mr } = startRecorder(writer, { onMemoryBufferFull });

    // Trip the OPFS fallback with a small chunk so storageMode flips to "memory".
    mr.ondataavailable?.({ data: makeBlob(10) }); // index 0
    await flush();
    expect(onMemoryBufferFull).not.toHaveBeenCalled();

    // A fake, cheaply-constructed "blob" whose declared `.size` alone exceeds
    // CONFIG.MEMORY_BUFFER_MAX_BYTES (200MB in production config) — real
    // MediaRecorder chunks are ~5s of video, nowhere near that on their own,
    // so this stands in for "the buffer has accumulated enough smaller chunks
    // to be near its cap" without actually allocating ~200MB in a unit test.
    // MemoryChunkBuffer.push() only ever reads `.size`, never the content, so
    // this is a faithful stand-in for the real overflow condition.
    const oversized = { size: CONFIG.MEMORY_BUFFER_MAX_BYTES + 1 } as unknown as Blob;
    mr.ondataavailable?.({ data: oversized }); // index 1: exceeds cap -> dropped
    await flush();

    expect(onMemoryBufferFull).toHaveBeenCalledTimes(1);

    // A further overflow must not double-report.
    mr.ondataavailable?.({ data: oversized }); // index 2: also dropped
    await flush();
    expect(onMemoryBufferFull).toHaveBeenCalledTimes(1);
  });
});
