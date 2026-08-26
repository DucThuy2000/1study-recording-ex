import { pickMimeType, CONFIG, type TierName } from '../shared/config';
import { ChunkWriter } from './chunk-writer';
import { createLogger } from '../core/logger';

const logger = createLogger('recorder');

export class SessionRecorder {
  private mediaRecorder: MediaRecorder | undefined;
  private readonly writer: ChunkWriter;
  private readonly pendingWrites: Promise<void>[] = [];

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
      const write = this.writer.write(event.data).then(
        () => undefined,
        (error: unknown) => {
          logger.error('chunk write failed', { error: String(error) });
        },
      );
      this.pendingWrites.push(write);
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
    // MediaRecorder queues its final `dataavailable` and `onstop` as separate tasks —
    // nothing guarantees the last chunk's OPFS write (several real await hops) finishes
    // before onstop resolves. Wait for every write this session issued before reading
    // the files back, or readAll() can race a chunk that hasn't landed yet.
    await Promise.all(this.pendingWrites);
    return this.writer.readAll();
  }
}
