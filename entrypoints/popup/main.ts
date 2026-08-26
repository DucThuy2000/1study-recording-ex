import { browser } from 'wxt/browser';
import type { Message } from '@/src/shared/messages';
import { getActiveTab } from '@/src/adapters/chrome-api';
import { createLogger } from '@/src/core/logger';

const logger = createLogger('popup');
let currentSessionId: string | undefined;

const startBtn = document.querySelector<HTMLButtonElement>('#start')!;
const stopBtn = document.querySelector<HTMLButtonElement>('#stop')!;
const status = document.querySelector<HTMLDivElement>('#status')!;

startBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) {
    status.textContent = 'No active tab found.';
    return;
  }
  await browser.runtime.sendMessage({ type: 'START_RECORDING', tabId: tab.id } satisfies Message);
  status.textContent = 'Starting...';
});

stopBtn.addEventListener('click', async () => {
  if (!currentSessionId) return;
  await browser.runtime.sendMessage({ type: 'STOP_RECORDING', sessionId: currentSessionId } satisfies Message);
  status.textContent = 'Stopping...';
});

browser.runtime.onMessage.addListener((message: Message) => {
  if (message.type === 'RECORDING_STARTED') {
    currentSessionId = message.sessionId;
    status.textContent = `Recording session ${message.sessionId}`;
    logger.info('recording started in popup', { sessionId: message.sessionId });
  }
});
