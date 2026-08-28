export interface OpfsInspector {
  /**
   * Sizes (bytes) of a session's chunk files, probed sequentially by index.
   * Empty array if the session genuinely has no chunks yet (its directory
   * doesn't exist — e.g. crashed before the first chunk landed). `null` if
   * OPFS itself couldn't be inspected — the caller must NOT treat a `null`
   * the same as an empty session, or a transient inspection failure would
   * irreversibly wipe a session's real footprint from the ledger.
   */
  listChunkSizes(sessionId: string): Promise<number[] | null>;
}

export class RealOpfsInspector implements OpfsInspector {
  async listChunkSizes(sessionId: string): Promise<number[] | null> {
    let sessions: FileSystemDirectoryHandle;
    try {
      const root = await navigator.storage.getDirectory();
      sessions = await root.getDirectoryHandle('sessions');
    } catch {
      return null;
    }

    let dir: FileSystemDirectoryHandle;
    try {
      dir = await sessions.getDirectoryHandle(sessionId);
    } catch {
      return [];
    }

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
  }
}
