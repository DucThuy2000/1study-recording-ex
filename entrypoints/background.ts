import { createLogger } from '@/src/core/logger';

const logger = createLogger('background');

export default defineBackground(() => {
  logger.info('service worker started');
});
