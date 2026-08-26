import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import type { Message } from '@/src/shared/messages';
import { ChromeTabCaptureApi, ChromeOffscreenApi } from '@/src/adapters/chrome-api';
import { createLogger } from '@/src/core/logger';
import { isMeetUrl, extractMeetingCode } from '@/src/core/meeting-code';
import { evaluateGuard } from '@/src/core/tab-guard';

const logger = createLogger('background');
const tabCapture = new ChromeTabCaptureApi();
const offscreen = new ChromeOffscreenApi();

function makeSessionId(): string {
  return crypto.randomUUID();
}

async function refreshActionState(tabId: number, url: string | undefined): Promise<void> {
  if (url && isMeetUrl(url)) {
    await chrome.action.enable(tabId);
  } else {
    await chrome.action.disable(tabId);
  }
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

  browser.runtime.onMessage.addListener((message: Message) => {
    if (message.type === 'START_RECORDING') {
      void (async () => {
        const tab = await browser.tabs.get(message.tabId);
        const guard = evaluateGuard(isMeetUrl(tab.url ?? ''), extractMeetingCode(tab.url ?? ''), undefined);
        if (!guard.allowed) {
          logger.warn('blocked start: guard failed', guard);
          await browser.runtime.sendMessage({
            type: 'GUARD_RESULT',
            allowed: false,
            reason: guard.reason,
          } satisfies Message);
          return;
        }
        const streamId = await tabCapture.getMediaStreamId(message.tabId);
        await offscreen.ensureDocument(
          '/offscreen.html',
          ['USER_MEDIA'],
          'Recording the class session tab for teaching quality review.',
        );
        const sessionId = makeSessionId();
        await browser.runtime.sendMessage({
          type: 'RECORDING_STARTED',
          sessionId,
          streamId,
        } satisfies Message);
        logger.info('recording started', { sessionId, tabId: message.tabId });
      })();
    }
    if (message.type === 'STOP_RECORDING') {
      void browser.runtime.sendMessage(message);
    }
  });
});
