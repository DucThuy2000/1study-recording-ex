import { pickMimeType, CONFIG } from "../shared/config";
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
  onChunkWritten?: (index: number, bytes: number) => void | Promise<void>;
  /** Fired once, the moment OPFS is judged unrecoverable for the rest of this session. Never fired more than once — the fallback is one-way. */
  onStorageDegraded?: (error: unknown) => void;
  /** Fired once, the moment the memory-buffer fallback's byte cap is first exceeded and a chunk had to be dropped. Never fired more than once. */
  onMemoryBufferFull?: () => void;
}

export class SessionRecorder {
  private mediaRecorder: MediaRecorder | undefined;
  private readonly writer: ChunkWriterLike;
  private readonly pendingWrites: Promise<void>[] = [];
  private readonly memoryBuffer: MemoryChunkBuffer;
  private storageMode: "opfs" | "memory" = "opfs";
  private memoryBufferFullReported = false;

  constructor(
    private readonly sessionId: string,
    private readonly stream: MediaStream,
    private readonly callbacks: SessionRecorderCallbacks = {},
    writer: ChunkWriterLike = new ChunkWriter(sessionId),
  ) {
    this.writer = writer;
    this.memoryBuffer = new MemoryChunkBuffer(CONFIG.MEMORY_BUFFER_MAX_BYTES);
  }

  start(): void {
    const tierConfig = CONFIG.TIERS["LOW"];
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
        if (
          !this.memoryBuffer.push(index, event.data) &&
          !this.memoryBufferFullReported
        ) {
          this.memoryBufferFullReported = true;
          this.callbacks.onMemoryBufferFull?.();
        }
        return;
      }

      const write = this.writer.write(event.data).then(
        async () => {
          await this.callbacks.onChunkWritten?.(index, bytes);
        },
        (error: unknown) => {
          logger.error("chunk write failed", { error: String(error) });
          // InvalidStateError: a documented, still-open Chromium bug near
          // zero free space. Retrying it every 5s for the rest of a
          // 60-minute class would just fail the same way each time — fall
          // back to the memory buffer instead, once, and stay there
          // (R12: keep recording, never stop for a storage failure).
          if (
            error instanceof DOMException &&
            error.name === "InvalidStateError"
          ) {
            if (this.storageMode === "opfs") {
              this.storageMode = "memory";
              this.callbacks.onStorageDegraded?.(error);
            }
            if (
              !this.memoryBuffer.push(index, event.data) &&
              !this.memoryBufferFullReported
            ) {
              this.memoryBufferFullReported = true;
              this.callbacks.onMemoryBufferFull?.();
            }
          }
        },
      );
      this.pendingWrites.push(write);
    };
    this.mediaRecorder.start(CONFIG.CHUNK_MS);
    logger.info("recording started", {
      sessionId: this.sessionId,
      mimeType,
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

    const blob = new Blob([opfsBlob, ...memoryChunks.map((c) => c.blob)], {
      type: "video/webm",
    });
    return { blob, missingChunkIndices };
  }
}
