import { defineContentScript } from "wxt/utils/define-content-script";
import { browser } from "wxt/browser";
import { createLogger } from "@/src/core/logger";
import { assertNever } from "@/src/core/assert";
import { StatusPill } from "@/src/content-logic/status-pill";
import type { Message, RecordingStateResponse } from "@/src/shared/messages";

const logger = createLogger("content");

// Meet's own mic-mute button. `data-is-muted` is a functional state
// attribute, not display text, so unlike aria-label (which is translated —
// Meet renders "Bật micrô" / "Turn on microphone" depending on the teacher's
// account locale) it should hold regardless of language. Still exactly the
// kind of selector that breaks when Google ships a new Meet build — no
// different in kind from the layout-detection fragility already called out
// for Task 4.2, so the fallback is the same: never found means recording
// continues exactly as it does today, just without mute detection.
const MUTE_BUTTON_SELECTOR = "button[data-is-muted]";

/**
 * Watches Meet's mute button and calls `onChange` whenever its muted state
 * changes (immediately once found, then again on every real toggle).
 *
 * Re-queries the button fresh on every observed mutation rather than holding
 * onto one element reference — confirmed by testing against a live Meet call
 * that clicking the button logged the state exactly once and then nothing on
 * every later click, which is the signature of the button being a *new* DOM
 * node each time (an SPA re-render swapping the element) rather than the same
 * node's attribute changing in place. Watching document.body for `childList`
 * (node swapped) and `attributes`/`data-is-muted` (attribute changed in
 * place) together covers both, without needing to know which one Meet
 * actually does.
 */
function watchMicMuteButton(onChange: (muted: boolean) => void): void {
  let lastMuted: boolean | undefined;

  function checkAndReport(): void {
    const button = document.querySelector(MUTE_BUTTON_SELECTOR);
    if (!button) return;
    const muted = button.getAttribute("data-is-muted") === "true";
    if (muted === lastMuted) return;
    lastMuted = muted;
    onChange(muted);
  }

  checkAndReport();
  new MutationObserver(checkAndReport).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-is-muted"],
  });
}

export default defineContentScript({
  matches: ["*://meet.google.com/*"],
  main() {
    logger.info("content script loaded", { url: location.href });

    const pill = new StatusPill();
    let lastKnownMicMuted = false;

    watchMicMuteButton((muted) => {
      lastKnownMicMuted = muted;
      void browser.runtime.sendMessage({
        type: "MIC_MUTE_CHANGED",
        muted,
      } satisfies Message);
    });

    // Hỏi trạng thái ngay khi nạp, để reload tab giữa buổi không làm mất pill
    // và không làm đồng hồ đếm lại từ đầu.
    void (async () => {
      try {
        const response = await browser.runtime.sendMessage<
          Message,
          RecordingStateResponse | undefined
        >({
          type: "GET_RECORDING_STATE",
        });
        if (response?.activeForSenderTab && response.session) {
          pill.mount(response.session.startedAtMs);
        }
      } catch (error) {
        logger.debug("could not read recording state", {
          error: String(error),
        });
      }
    })();

    browser.runtime.onMessage.addListener((message: Message) => {
      switch (message.type) {
        case "RECORDING_ACTIVE":
          if (message.active && message.startedAtMs !== null) {
            pill.mount(message.startedAtMs);
            // The offscreen document's mic starts unmuted regardless of
            // Meet's actual state at that moment (teachers commonly mute
            // before ever touching Start) — sync it once, immediately.
            void browser.runtime.sendMessage({
              type: "MIC_MUTE_CHANGED",
              muted: lastKnownMicMuted,
            } satisfies Message);
          } else {
            pill.unmount();
          }
          return;
        case "AUDIO_ALERT":
          pill.setWarning(
            message.silent
              ? message.source === "mic"
                ? "⚠ Không nghe thấy giọng bạn — kiểm tra micro"
                : "⚠ Không nghe thấy học sinh — kiểm tra âm thanh tab"
              : null,
          );
          return;
        case "VIDEO_STALLED":
          pill.setWarning(
            "⚠ Hình ảnh lớp học có thể đang bị đóng băng — đoạn này có thể không được ghi hình",
          );
          return;
        case "VIDEO_RECOVERED":
          pill.setWarning(null);
          return;
        case "STORAGE_ALERT":
          pill.setWarning(
            !message.low
              ? null
              : message.reason === "LOW_DISK"
                ? "⚠ Ổ đĩa sắp đầy — bản ghi có thể bị mất nếu không giải phóng dung lượng"
                : message.reason === "BACKLOG_HIGH"
                  ? "⚠ Dữ liệu cũ tồn đọng quá nhiều — hãy mở Chrome để tự động tải lên"
                  : "⚠ Lỗi lưu trữ — bản ghi đang chuyển sang bộ nhớ tạm",
          );
          return;
        // Addressed to background, the popup or the offscreen document. Content
        // scripts only ever receive what background sends them with
        // tabs.sendMessage, but the switch stays exhaustive so a new message
        // type is a compile error here rather than a silent drop.
        case "START_RECORDING":
        case "STOP_RECORDING":
        case "GET_RECORDING_STATE":
        // This script sends MIC_MUTE_CHANGED rather than receiving it, and
        // never sees SET_MIC_MUTED at all (background → offscreen only).
        case "MIC_MUTE_CHANGED":
        case "SET_MIC_MUTED":
        case "RECORDING_STARTED":
        case "RECORDING_STOP":
        case "GET_MIC_PERMISSION_STATE":
        case "STORAGE_GET":
        case "STORAGE_SET":
        case "RECORDING_STATE":
        case "AUDIO_LEVEL":
        case "GUARD_RESULT":
          return;
        default:
          return assertNever(message);
      }
    });
  },
});
