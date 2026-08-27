import { defineContentScript } from "wxt/utils/define-content-script";
import { browser } from "wxt/browser";
import { createLogger } from "@/src/core/logger";
import { assertNever } from "@/src/core/assert";
import type { Message, RecordingStateResponse } from "@/src/shared/messages";

const logger = createLogger("content");

let banner: HTMLDivElement | undefined;

function showBanner(text: string): void {
  if (!banner) {
    banner = document.createElement("div");
    banner.style.cssText =
      "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
      "background:#b91c1c;color:#fff;padding:8px 16px;border-radius:6px;font:14px sans-serif;";
    document.body.appendChild(banner);
  }
  banner.textContent = text;
  banner.style.display = "block";
}

function hideBanner(): void {
  if (banner) banner.style.display = "none";
}

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

    // Whether *this* tab is the one being recorded. Pushed by background on
    // start/stop; also asked for on load, so a mid-session page reload doesn't
    // leave the script thinking nothing is being recorded.
    let recordingActive = false;
    let hiddenAtMs: number | undefined;
    let lastKnownMicMuted = false;

    watchMicMuteButton((muted) => {
      logger.info(`muted mic: ${muted}`);
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
        recordingActive = response?.activeForSenderTab ?? false;
      } catch (error) {
        logger.debug("could not read recording state", {
          error: String(error),
        });
      }
    })();

    browser.runtime.onMessage.addListener((message: Message) => {
      switch (message.type) {
        case "RECORDING_ACTIVE":
          recordingActive = message.active;
          if (message.active) {
            // The offscreen document's mic starts unmuted regardless of
            // Meet's actual state at that moment (teachers commonly mute
            // before ever touching Start) — sync it once, immediately.
            void browser.runtime.sendMessage({
              type: "MIC_MUTE_CHANGED",
              muted: lastKnownMicMuted,
            } satisfies Message);
          } else {
            hiddenAtMs = undefined;
            hideBanner();
          }
          return;
        case "AUDIO_ALERT":
          if (message.silent) {
            showBanner(
              message.source === "mic"
                ? "⚠ Không nghe thấy giọng bạn — kiểm tra micro"
                : "⚠ Không nghe thấy học sinh — kiểm tra âm thanh tab",
            );
          } else {
            hideBanner();
          }
          return;
        case "VIDEO_STALLED":
          showBanner(
            "⚠ Hình ảnh lớp học có thể đang bị đóng băng — đoạn này có thể không được ghi hình.",
          );
          return;
        case "VIDEO_RECOVERED":
          hideBanner();
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
        case "GUARD_RESULT":
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
    document.addEventListener("visibilitychange", () => {
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
        showBanner(
          `Bạn đã rời tab lớp học ${awayMinutes} phút — đoạn đó có thể không được ghi hình.`,
        );
      }
    });
  },
});
