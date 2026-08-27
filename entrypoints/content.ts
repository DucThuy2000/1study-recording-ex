import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { createLogger } from '@/src/core/logger';
import { assertNever } from '@/src/core/assert';
import type { Message, RecordingStateResponse } from '@/src/shared/messages';

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

    // Whether *this* tab is the one being recorded. Pushed by background on
    // start/stop; also asked for on load, so a mid-session page reload doesn't
    // leave the script thinking nothing is being recorded.
    let recordingActive = false;
    let hiddenAtMs: number | undefined;

    void (async () => {
      try {
        const response = await browser.runtime.sendMessage<Message, RecordingStateResponse | undefined>({
          type: 'GET_RECORDING_STATE',
        });
        recordingActive = response?.activeForSenderTab ?? false;
      } catch (error) {
        logger.debug('could not read recording state', { error: String(error) });
      }
    })();

    browser.runtime.onMessage.addListener((message: Message) => {
      switch (message.type) {
        case 'RECORDING_ACTIVE':
          recordingActive = message.active;
          if (!message.active) {
            hiddenAtMs = undefined;
            hideBanner();
          }
          return;
        case 'AUDIO_ALERT':
          if (message.silent) {
            showBanner(
              message.source === 'mic'
                ? '⚠ Không nghe thấy giọng bạn — kiểm tra micro'
                : '⚠ Không nghe thấy học sinh — kiểm tra âm thanh tab',
            );
          } else {
            hideBanner();
          }
          return;
        case 'VIDEO_STALLED':
          showBanner('⚠ Hình ảnh lớp học có thể đang bị đóng băng — đoạn này có thể không được ghi hình.');
          return;
        case 'VIDEO_RECOVERED':
          hideBanner();
          return;
        // Addressed to background, the popup or the offscreen document. Content
        // scripts only ever receive what background sends them with
        // tabs.sendMessage, but the switch stays exhaustive so a new message
        // type is a compile error here rather than a silent drop.
        case 'START_RECORDING':
        case 'STOP_RECORDING':
        case 'GET_RECORDING_STATE':
        case 'RECORDING_STARTED':
        case 'RECORDING_STOP':
        case 'GET_MIC_PERMISSION_STATE':
        case 'RECORDING_STATE':
        case 'GUARD_RESULT':
          return;
        default:
          return assertNever(message);
      }
    });

    // R13/R12: informational-only notice — tab backgrounding may freeze the
    // captured video (still unconfirmed empirically, see docs/task-0.6-findings.md);
    // this never blocks anything, it just tells the teacher which window of
    // time might be missing. A plain event listener, not a setInterval, so it
    // isn't subject to backgrounded-tab timer throttling (R13). Gated on this
    // tab actually being recorded — firing on every ordinary Meet tab switch
    // would train the teacher to ignore the warning.
    document.addEventListener('visibilitychange', () => {
      if (!recordingActive) {
        hiddenAtMs = undefined;
        return;
      }
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
