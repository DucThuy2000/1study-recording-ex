import { defineBackground } from 'wxt/utils/define-background';
import { browser, type Browser } from 'wxt/browser';
import type { ActiveSessionInfo, Message, MessageOf, RecordingStateResponse } from '@/src/shared/messages';
import { ChromeTabCaptureApi, ChromeOffscreenApi } from '@/src/adapters/chrome-api';
import { ChromeStorageAdapter } from '@/src/adapters/storage';
import { createLogger } from '@/src/core/logger';
import { isMeetUrl, extractMeetingCode } from '@/src/core/meeting-code';
import { evaluateGuard } from '@/src/core/tab-guard';
import { assertNever } from '@/src/core/assert';

const logger = createLogger('background');
const tabCapture = new ChromeTabCaptureApi();
const offscreen = new ChromeOffscreenApi();
const store = new ChromeStorageAdapter();

/**
 * Active-session ownership lives here and nowhere else, persisted rather than
 * held in a module variable because Chrome kills the service worker at will —
 * mid-session included. Every other context (popup, content script) asks for
 * this state instead of remembering its own copy.
 */
const ACTIVE_SESSION_KEY = 'activeSession';
const LAST_ERROR_KEY = 'lastSessionError';

function makeSessionId(): string {
  return crypto.randomUUID();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readActiveSession(): Promise<ActiveSessionInfo | null> {
  return (await store.get<ActiveSessionInfo | null>(ACTIVE_SESSION_KEY)) ?? null;
}

async function writeActiveSession(session: ActiveSessionInfo | null): Promise<void> {
  await store.set(ACTIVE_SESSION_KEY, session);
}

async function readLastError(): Promise<string | null> {
  return (await store.get<string | null>(LAST_ERROR_KEY)) ?? null;
}

async function writeLastError(error: string | null): Promise<void> {
  await store.set(LAST_ERROR_KEY, error);
}

/** Broadcast to extension pages (popup, offscreen). Best-effort: nobody may be listening. */
async function broadcast(message: Message): Promise<void> {
  try {
    await browser.runtime.sendMessage(message);
  } catch (error) {
    logger.debug('no extension page received message', { type: message.type, error: describeError(error) });
  }
}

/**
 * The only way to reach a content script — `runtime.sendMessage` never does.
 * The tab may have been closed mid-session, so this must not throw.
 */
async function sendToTab(tabId: number, message: Message): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, message);
  } catch (error) {
    logger.debug('content script unreachable', { tabId, type: message.type, error: describeError(error) });
  }
}

async function refreshActionState(tabId: number, url: string | undefined): Promise<void> {
  if (url && isMeetUrl(url)) {
    await chrome.action.enable(tabId);
  } else {
    await chrome.action.disable(tabId);
  }
}

async function refuseStart(reason: MessageOf<'GUARD_RESULT'>['reason'], detail?: string): Promise<void> {
  logger.warn('start refused', { reason, detail });
  await broadcast({ type: 'GUARD_RESULT', allowed: false, reason, detail });
}

async function handleStart(message: MessageOf<'START_RECORDING'>): Promise<void> {
  const existing = await readActiveSession();
  if (existing) {
    // The natural recovery path once the popup can rehydrate: the teacher
    // reopens it, sees a stuck-looking UI and clicks Start again. Minting a
    // second session here would orphan the first one's recorder.
    await refuseStart('ALREADY_RECORDING', `Session ${existing.sessionId} is already recording.`);
    return;
  }

  const tab = await browser.tabs.get(message.tabId);
  const guard = evaluateGuard(isMeetUrl(tab.url ?? ''), extractMeetingCode(tab.url ?? ''), undefined);
  if (!guard.allowed) {
    await refuseStart(guard.reason);
    return;
  }

  const sessionId = makeSessionId();
  try {
    const streamId = await tabCapture.getMediaStreamId(message.tabId);
    // Tentative until the offscreen document acks with RECORDING_STATE, which
    // is why status is STARTING and not RECORDING — the popup renders the
    // difference rather than claiming a recording that may still fail.
    await writeLastError(null);
    await writeActiveSession({
      sessionId,
      tabId: message.tabId,
      status: 'STARTING',
      startedAtMs: Date.now(),
    });
    await offscreen.ensureDocument(
      '/offscreen.html',
      ['USER_MEDIA'],
      'Recording the class session tab for teaching quality review.',
    );
    await broadcast({ type: 'RECORDING_STARTED', sessionId, streamId });
    logger.info('start dispatched', { sessionId, tabId: message.tabId });
  } catch (error) {
    const detail = describeError(error);
    await writeActiveSession(null);
    await writeLastError(detail);
    logger.error('start failed', { sessionId, error: detail });
    await refuseStart('START_FAILED', detail);
  }
}

async function handleStop(message: MessageOf<'STOP_RECORDING'>): Promise<void> {
  const active = await readActiveSession();
  if (!active || active.sessionId !== message.sessionId) {
    logger.warn('stop requested for a session this worker does not own', {
      requested: message.sessionId,
      active: active?.sessionId ?? null,
    });
  }

  // Release ownership first: even if the offscreen document is already gone,
  // the teacher must be able to start a new session afterwards.
  await writeActiveSession(null);
  if (active) await sendToTab(active.tabId, { type: 'RECORDING_ACTIVE', active: false, sessionId: null });
  // The single relay into the offscreen document, from the single place that
  // ever relays it.
  await broadcast({ type: 'RECORDING_STOP', sessionId: message.sessionId });
}

async function handleRecordingState(message: MessageOf<'RECORDING_STATE'>): Promise<void> {
  const active = await readActiveSession();

  if (message.state === 'RECORDING') {
    if (!active || active.sessionId !== message.sessionId) {
      logger.warn('ack for a session this worker does not own', { sessionId: message.sessionId });
      return;
    }
    await writeActiveSession({ ...active, status: 'RECORDING' });
    await sendToTab(active.tabId, { type: 'RECORDING_ACTIVE', active: true, sessionId: message.sessionId });
    logger.info('recording confirmed', { sessionId: message.sessionId, tabId: active.tabId });
    return;
  }

  if (message.state === 'FAILED') {
    const detail = message.error ?? 'Recording failed.';
    logger.error('recording failed', { sessionId: message.sessionId, error: detail });
    await writeLastError(detail);
    if (active?.sessionId === message.sessionId) {
      await writeActiveSession(null);
      await sendToTab(active.tabId, { type: 'RECORDING_ACTIVE', active: false, sessionId: null });
    }
    return;
  }

  // FINALIZING and the rest are informational; ownership was already released
  // by handleStop.
  logger.info('session state', { sessionId: message.sessionId, state: message.state });
}

/** Fans an offscreen alert out to the tab being recorded — the only way it reaches a content script. */
async function fanOutToRecordedTab(message: Message): Promise<void> {
  const active = await readActiveSession();
  if (!active) return;
  await sendToTab(active.tabId, message);
}

async function buildStateResponse(senderTabId: number | undefined): Promise<RecordingStateResponse> {
  const session = await readActiveSession();
  return {
    session,
    lastError: await readLastError(),
    activeForSenderTab:
      senderTabId !== undefined && session?.tabId === senderTabId && session.status === 'RECORDING',
  };
}

/** Runs a handler's async body without letting a rejection escape as an unhandled promise. */
function run(task: Promise<void>, label: string): void {
  void task.catch((error: unknown) => logger.error(`${label} failed`, { error: describeError(error) }));
}

export default defineBackground(() => {
  logger.info('service worker started');

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') void refreshActionState(tabId, tab.url);
  });

  browser.tabs.onActivated.addListener(async ({ tabId }) => {
    const tab = await browser.tabs.get(tabId);
    void refreshActionState(tabId, tab.url);
  });

  browser.runtime.onMessage.addListener(
    (message: Message, sender: Browser.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
      switch (message.type) {
        case 'START_RECORDING':
          run(handleStart(message), 'start');
          return false;
        case 'STOP_RECORDING':
          run(handleStop(message), 'stop');
          return false;
        case 'GET_RECORDING_STATE':
          // Async response, so the channel has to be held open with `return true`.
          run(
            buildStateResponse(sender.tab?.id).then((response) => sendResponse(response)),
            'state query',
          );
          return true;
        case 'RECORDING_STATE':
          run(handleRecordingState(message), 'state update');
          return false;
        case 'AUDIO_ALERT':
        case 'VIDEO_STALLED':
        case 'VIDEO_RECOVERED':
          run(fanOutToRecordedTab(message), 'alert fan-out');
          return false;
        // Messages this worker emits rather than consumes.
        case 'RECORDING_STARTED':
        case 'RECORDING_STOP':
        case 'RECORDING_ACTIVE':
        case 'GUARD_RESULT':
          return false;
        default:
          return assertNever(message);
      }
    },
  );
});
