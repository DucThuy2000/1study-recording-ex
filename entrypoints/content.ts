import { defineContentScript } from 'wxt/utils/define-content-script';
import { createLogger } from '@/src/core/logger';

const logger = createLogger('content');

export default defineContentScript({
  matches: ['*://meet.google.com/*'],
  main() {
    logger.info('content script loaded', { url: location.href });
  },
});
