export interface ReadAllResult {
  blob: Blob;
  /** Indices whose file was never written (their `write()` failed). Reported as OPFS_ERROR by the caller. */
  missingIndices: number[];
}

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

  /**
   * Concatenates every chunk that made it to disk. A chunk whose write failed
   * (logged, not thrown, so the class kept recording — R12) leaves no file
   * behind; skip it and report the gap instead of throwing `NotFoundError` out
   * of the whole read, which would abort the caller's stop/finalize path.
   */
  async readAll(): Promise<ReadAllResult> {
    const dir = await this.getSessionDir();
    const parts: Blob[] = [];
    const missingIndices: number[] = [];
    for (let i = 0; i < this.nextIndex; i++) {
      const name = `chunk_${String(i).padStart(5, '0')}.webm`;
      try {
        const handle = await dir.getFileHandle(name);
        parts.push(await handle.getFile());
      } catch {
        missingIndices.push(i);
      }
    }
    return { blob: new Blob(parts, { type: 'video/webm' }), missingIndices };
  }
}
