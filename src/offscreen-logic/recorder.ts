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
