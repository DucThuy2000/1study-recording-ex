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
