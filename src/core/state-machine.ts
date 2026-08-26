import type { KeyValueStore } from '../adapters/storage';
import type { Logger } from './logger';
import { ok, err, type Result } from './result';

export type SessionState =
  | 'IDLE'
  | 'READY'
  | 'RECORDING'
  | 'DEGRADED'
  | 'FINALIZING'
  | 'UPLOADING'
  | 'DONE'
  | 'FAILED';

const ALLOWED_TRANSITIONS: Record<SessionState, SessionState[]> = {
  IDLE: ['READY'],
  READY: ['RECORDING', 'IDLE'],
  RECORDING: ['FINALIZING', 'DEGRADED'],
  DEGRADED: ['RECORDING', 'FINALIZING'],
  FINALIZING: ['UPLOADING', 'FAILED'],
  UPLOADING: ['DONE', 'FAILED'],
  DONE: [],
  FAILED: [],
};

export interface TransitionRecord {
  from: SessionState;
  to: SessionState;
  reason: string;
  atMs: number;
}

export class SessionStateMachine {
  private state: SessionState = 'IDLE';

  constructor(
    private readonly sessionId: string,
    private readonly store: KeyValueStore,
    private readonly logger: Logger,
  ) {}

  getState(): SessionState {
    return this.state;
  }

  async transition(to: SessionState, reason: string): Promise<Result<SessionState, string>> {
    const allowed = ALLOWED_TRANSITIONS[this.state];
    if (!allowed.includes(to)) {
      const message = `Invalid transition ${this.state} -> ${to} (reason: ${reason})`;
      this.logger.error(message);
      return err(message);
    }
    const record: TransitionRecord = { from: this.state, to, reason, atMs: Date.now() };
    this.state = to;
    await this.store.set(`session:${this.sessionId}:state`, to);
    await this.store.set(`session:${this.sessionId}:lastTransition`, record);
    this.logger.info(`transition ${record.from} -> ${record.to}`, { reason });
    return ok(to);
  }
}
