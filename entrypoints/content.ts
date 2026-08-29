import { defineContentScript } from "wxt/utils/define-content-script";
import { browser } from "wxt/browser";
import { createLogger } from "@/src/core/logger";
import { assertNever } from "@/src/core/assert";
import { StatusPill } from "@/src/content-logic/status-pill";
import { watchCallEnded } from "@/src/content-logic/call-end-watcher";
import type { Message, RecordingStateResponse } from "@/src/shared/messages";

const logger = createLogger("content");
const MUTE_BUTTON_SELECTOR = "button[data-is-muted]";

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

    watchCallEnded(() => {
      logger.info("Meet showed its post-call screen");
      void browser.runtime.sendMessage({
        type: "MEETING_LEFT",
      } satisfies Message);
    });

    watchMicMuteButton((muted) => {
      lastKnownMicMuted = muted;
      void browser.runtime.sendMessage({
        type: "MIC_MUTE_CHANGED",
        muted,
      } satisfies Message);
    });

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
            // Xác nhận rồi mới biến mất, thay vì lặng lẽ mất hút.
            pill.showStopped();
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
        // Cũng do script này gửi đi, không nhận.
        case "MEETING_LEFT":
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
