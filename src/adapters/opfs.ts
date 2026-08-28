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
