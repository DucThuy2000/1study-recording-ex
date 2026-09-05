import { defineContentScript } from "wxt/utils/define-content-script";
import { browser } from "wxt/browser";
import { createLogger } from "@/src/core/logger";
import { assertNever } from "@/src/core/assert";
import { StatusPill } from "@/src/content-logic/status-pill";
import {
  findLeaveButton,
  LeaveConfirmDialog,
} from "@/src/content-logic/detect-leave-action";
import type { Message, RecordingStateResponse } from "@/src/shared/messages";

const logger = createLogger("content");
const MUTE_BUTTON_SELECTOR = "button[data-is-muted]";
const CALL_ENDED_SELECTOR = '[data-call-ended="true"]';

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

function watchLeaveButton(
  onLeaveClick: (button: HTMLButtonElement) => boolean,
): void {
  let attached: HTMLButtonElement | undefined;

  function handleClick(event: MouseEvent): void {
    if (!attached) return;
    if (!onLeaveClick(attached)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function checkAndAttach(): void {
    const button = findLeaveButton(document);
    if (!button || button === attached) return;
    attached?.removeEventListener("click", handleClick, true);
    attached = button;
    button.addEventListener("click", handleClick, true);
  }

  checkAndAttach();
  new MutationObserver(checkAndAttach).observe(document.body, {
    subtree: true,
    childList: true,
  });
}

function watchCallEnded(onEnded: () => void): () => void {
  let reported = false;
  let observer: MutationObserver | undefined;

  function check(): void {
    if (reported) return;
    if (!document.querySelector(CALL_ENDED_SELECTOR)) return;
    reported = true;
    observer?.disconnect();
    onEnded();
  }

  check();
  if (reported) return () => undefined;

  observer = new MutationObserver(check);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-call-ended"],
  });
  return () => observer?.disconnect();
}

export default defineContentScript({
  matches: ["*://meet.google.com/*"],
  main() {
    logger.info("content script loaded", { url: location.href });

    const pill = new StatusPill();
    const leaveConfirmDialog = new LeaveConfirmDialog();
    let lastKnownMicMuted = false;
    let activeSession: { startedAtMs: number } | null = null;
    let suppressNextLeaveClick = false;

    watchLeaveButton((button) => {
      // on clicking confirm button -> let meet end the meeting
      if (suppressNextLeaveClick) {
        suppressNextLeaveClick = false;
        return false;
      }
      // no active session -> no check
      if (!activeSession) return false;

      const elapsedMs = Date.now() - activeSession.startedAtMs;
      void leaveConfirmDialog.show(elapsedMs).then(async (confirmed) => {
        if (!confirmed) return;

        leaveConfirmDialog.setLoading(true);

        try {
          await Promise.race([
            browser.runtime.sendMessage({
              type: "LMS_END_CLASS",
            } satisfies Message),
            new Promise((resolve) => setTimeout(resolve, 2500)),
          ]);
        } catch (err) {
          logger.warn("LMS_END_CLASS error or timeout", { error: String(err) });
        } finally {
          leaveConfirmDialog.unmount();
          suppressNextLeaveClick = true;
          button.click();
        }
      });
      return true;
    });

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
          activeSession = { startedAtMs: response.session.startedAtMs };
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
            activeSession = { startedAtMs: message.startedAtMs };
            pill.mount(message.startedAtMs);
            // The offscreen document's mic starts unmuted regardless of
            // Meet's actual state at that moment (teachers commonly mute
            // before ever touching Start) — sync it once, immediately.
            void browser.runtime.sendMessage({
              type: "MIC_MUTE_CHANGED",
              muted: lastKnownMicMuted,
            } satisfies Message);
          } else {
            activeSession = null;
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
        case "LMS_GET_CONTEXT":
        case "LMS_END_CLASS":
        // This script sends MIC_MUTE_CHANGED rather than receiving it, and
        // never sees SET_MIC_MUTED at all (background → offscreen only).
        case "MIC_MUTE_CHANGED":
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
