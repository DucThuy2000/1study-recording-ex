import type { SessionState } from '../core/state-machine';

export type Message =
  | { type: 'START_RECORDING'; tabId: number }
  | { type: 'STOP_RECORDING'; sessionId: string }
  | { type: 'RECORDING_STARTED'; sessionId: string; streamId: string }
  | { type: 'RECORDING_STATE'; sessionId: string; state: SessionState; elapsedMs: number }
  | { type: 'AUDIO_ALERT'; source: 'mic' | 'tab'; silent: boolean }
  | { type: 'VIDEO_STALLED'; sessionId: string; gapMs: number; atMs: number }
  | { type: 'GUARD_RESULT'; allowed: boolean; reason?: string };

export type MessageOf<T extends Message['type']> = Extract<Message, { type: T }>;
