import { createLogger } from '@/src/core/logger';

const logger = createLogger('permission');

/**
 * The offscreen document has no visible surface and can never show Chrome's
 * native microphone prompt itself (background.ts opens this page, as a real
 * tab, specifically because a tab — unlike the popup — isn't destroyed by
 * losing focus, so the prompt survives long enough to be answered). Once
 * granted, the extension origin's permission state is shared with every
 * other extension page, including the offscreen document that will actually
 * do the recording — this page's own stream is never used for anything.
 */
navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((stream) => {
    stream.getTracks().forEach((track) => track.stop());
    window.close();
  })
  .catch((error: unknown) => {
    logger.warn('microphone permission not granted', { error: String(error) });
    const status = document.querySelector<HTMLParagraphElement>('#status');
    if (status) {
      status.textContent =
        'Không cấp được quyền micro. Vui lòng thử lại, hoặc bật quyền thủ công trong Cài đặt Chrome > Quyền riêng tư và bảo mật > Cài đặt trang web > Micro.';
    }
  });
