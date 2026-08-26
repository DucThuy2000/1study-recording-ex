import type { SessionState } from '../core/state-machine';

/**
 * Why a start request was refused. The first two mirror `GuardResult`'s reasons
 * (`src/core/tab-guard.ts`); the last two are refusals only the background
 * service worker can decide, because only it owns active-session state.
 */
export type GuardFailureReason =
  | 'NOT_MEET_TAB'
  | 'MEETING_CODE_MISMATCH'
  | 'ALREADY_RECORDING'
  | 'START_FAILED';

/**
 * `STARTING` = background has dispatched the start command but the offscreen
 * document has not acked yet. `RECORDING` = offscreen confirmed via
 * `RECORDING_STATE`. The popup must never render `STARTING` as "recording".
 */
export type ActiveSessionStatus = 'STARTING' | 'RECORDING';

/**
 * The single source of truth for "is a session active, and which tab owns it".
 * Owned by `entrypoints/background.ts` and persisted to `chrome.storage.local`
 * so it survives service-worker death mid-session.
 */
export interface ActiveSessionInfo {
  sessionId: string;
  tabId: number;
  status: ActiveSessionStatus;
  startedAtMs: number;
}

/** Reply to `GET_RECORDING_STATE`, sent by background via `sendResponse`. */
export interface RecordingStateResponse {
  session: ActiveSessionInfo | null;
  /** Last start/stop failure, so a popup opened after the failure still shows it. */
  lastError: string | null;
  /** True when the asking context runs inside the tab currently being recorded. */
  activeForSenderTab: boolean;
}

/**
 * Every cross-context message. Routing model: the popup and the offscreen
 * document only ever talk to background; background is the sole router and the
 * sole owner of active-session state.
 *
 * Note that `browser.runtime.sendMessage` reaches *every* extension page
 * (background, popup and offscreen) but never a content script. That is why
 * background→offscreen commands use different type tags from the popup→background
 * control messages: a popup broadcast can then never be mistaken for a command
 * by the offscreen document, and content scripts are reached only via
 * `browser.tabs.sendMessage` from background.
 */
export type Message =
  // popup → background (control)
  | { type: 'START_RECORDING'; tabId: number }
  | { type: 'STOP_RECORDING'; sessionId: string }
  | { type: 'GET_RECORDING_STATE' }
  // background → offscreen (commands)
  | { type: 'RECORDING_STARTED'; sessionId: string; streamId: string }
  | { type: 'RECORDING_STOP'; sessionId: string }
  // offscreen → background (the popup receives the same broadcast and renders it)
  | { type: 'RECORDING_STATE'; sessionId: string; state: SessionState; elapsedMs: number; error?: string }
  | { type: 'AUDIO_ALERT'; source: 'mic' | 'tab'; silent: boolean }
  | { type: 'VIDEO_STALLED'; sessionId: string; gapMs: number; atMs: number }
  | { type: 'VIDEO_RECOVERED'; sessionId: string; atMs: number }
  // background → content script (via browser.tabs.sendMessage)
  | { type: 'RECORDING_ACTIVE'; active: boolean; sessionId: string | null }
  // background → popup
  | { type: 'GUARD_RESULT'; allowed: boolean; reason?: GuardFailureReason; detail?: string };

export type MessageOf<T extends Message['type']> = Extract<Message, { type: T }>;
