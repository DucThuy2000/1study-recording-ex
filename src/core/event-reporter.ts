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
