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
