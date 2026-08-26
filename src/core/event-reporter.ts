import { CONFIG } from '../shared/config';
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
    | 'VIDEO_STALLED'
    | 'VIDEO_RECOVERED';
  payload: Record<string, unknown>;
  ts: number;
}

const PENDING_EVENTS_KEY = 'pendingEvents';

export class EventReporter {
  /**
   * Serializes the queue's read-modify-write. Three independent producers can
   * report in the same tick (the mic monitor and the tab monitor share a poll
   * interval, and the frame monitor runs on its own), and two interleaved
   * `get` → `push` → `set` cycles would silently drop one event — precisely the
   * simultaneous-total-audio-failure case that most needs recording (R6).
   */
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: KeyValueStore,
    private readonly bus: EventBus<{ event: RecordingEvent }>,
    private readonly logger: Logger,
  ) {}

  report(type: RecordingEvent['type'], payload: Record<string, unknown>): Promise<void> {
    const next = this.tail.then(() => this.doReport(type, payload));
    // Keep a rejected report from poisoning every later one.
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async doReport(type: RecordingEvent['type'], payload: Record<string, unknown>): Promise<void> {
    const event: RecordingEvent = { type, payload, ts: Date.now() };
    this.logger.warn(`event: ${type}`, payload);
    const pending = (await this.store.get<RecordingEvent[]>(PENDING_EVENTS_KEY)) ?? [];
    pending.push(event);
    if (pending.length > CONFIG.EVENT_QUEUE_MAX_PENDING) pending.shift();
    await this.store.set(PENDING_EVENTS_KEY, pending);
    this.bus.emit('event', event);
  }
}
