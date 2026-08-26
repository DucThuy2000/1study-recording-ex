import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { createLogger } from '@/src/core/logger';
import type { Message } from '@/src/shared/messages';

const logger = createLogger('content');

let banner: HTMLDivElement | undefined;

function showBanner(text: string): void {
  if (!banner) {
    banner = document.createElement('div');
    banner.style.cssText =
      'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'background:#b91c1c;color:#fff;padding:8px 16px;border-radius:6px;font:14px sans-serif;';
    document.body.appendChild(banner);
  }
  banner.textContent = text;
  banner.style.display = 'block';
}

function hideBanner(): void {
  if (banner) banner.style.display = 'none';
}

export default defineContentScript({
  matches: ['*://meet.google.com/*'],
  main() {
    logger.info('content script loaded', { url: location.href });

    browser.runtime.onMessage.addListener((message: Message) => {
      if (message.type === 'AUDIO_ALERT') {
        if (message.silent) {
          showBanner(
            message.source === 'mic'
              ? '⚠ Không nghe thấy giọng bạn — kiểm tra micro'
              : '⚠ Không nghe thấy học sinh — kiểm tra âm thanh tab',
          );
        } else {
          hideBanner();
        }
      }
    });

    // R13/R12: informational-only notice — tab backgrounding may freeze the
    // captured video (still unconfirmed empirically, see docs/task-0.6-findings.md);
    // this never blocks anything, it just tells the teacher which window of
    // time might be missing. A plain event listener, not a setInterval, so it
    // isn't subject to backgrounded-tab timer throttling (R13).
    let hiddenAtMs: number | undefined;

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenAtMs = Date.now();
        return;
      }
      if (hiddenAtMs === undefined) return;
      const awayMinutes = Math.round((Date.now() - hiddenAtMs) / 60000);
      hiddenAtMs = undefined;
      if (awayMinutes >= 1) {
        showBanner(`Bạn đã rời tab lớp học ${awayMinutes} phút — đoạn đó có thể không được ghi hình.`);
      }
    });
  },
});
