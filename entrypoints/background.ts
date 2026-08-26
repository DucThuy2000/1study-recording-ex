import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import type { Message } from '@/src/shared/messages';
import { ChromeTabCaptureApi, ChromeOffscreenApi } from '@/src/adapters/chrome-api';
import { createLogger } from '@/src/core/logger';

const logger = createLogger('background');
const tabCapture = new ChromeTabCaptureApi();
const offscreen = new ChromeOffscreenApi();

function makeSessionId(): string {
  return crypto.randomUUID();
}

export default defineBackground(() => {
  logger.info('service worker started');

  browser.runtime.onMessage.addListener((message: Message) => {
    if (message.type === 'START_RECORDING') {
      void (async () => {
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
