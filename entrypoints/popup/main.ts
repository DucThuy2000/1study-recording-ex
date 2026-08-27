import { browser } from "wxt/browser";
import type { Message, RecordingStateResponse } from "@/src/shared/messages";
import { getActiveTab } from "@/src/adapters/chrome-api";
import { createLogger } from "@/src/core/logger";
import { isMeetUrl, extractMeetingCode } from "@/src/core/meeting-code";
import { evaluateGuard } from "@/src/core/tab-guard";
import { assertNever } from "@/src/core/assert";

const logger = createLogger("popup");

const startBtn = document.querySelector<HTMLButtonElement>("#start")!;
const stopBtn = document.querySelector<HTMLButtonElement>("#stop")!;
const status = document.querySelector<HTMLDivElement>("#status")!;

/**
 * MV3 destroys the popup the instant it loses focus — which happens the moment
 * the teacher clicks back into the Meet tab being recorded. So the popup keeps
 * no durable state of its own: it asks background for the truth on every open.
 */
type PopupView =
  | { kind: "IDLE" }
  | { kind: "STARTING" }
  | { kind: "RECORDING"; sessionId: string }
  | { kind: "STOPPING"; sessionId: string };

let view: PopupView = { kind: "IDLE" };
let guardAllowed = false;
let guardMessage = "Checking this tab…";
let notice: string | null = null;

function render(): void {
  switch (view.kind) {
    case "IDLE":
      startBtn.disabled = !guardAllowed;
      stopBtn.disabled = true;
      status.textContent = notice ?? guardMessage;
      return;
    case "STARTING":
      startBtn.disabled = true;
      stopBtn.disabled = true;
      status.textContent = "Starting…";
      return;
    case "RECORDING":
      startBtn.disabled = true;
      stopBtn.disabled = false;
      status.textContent = `Recording session ${view.sessionId}`;
      return;
    case "STOPPING":
      startBtn.disabled = true;
      stopBtn.disabled = true;
      status.textContent = "Stopping…";
      return;
    default:
      return assertNever(view);
  }
}

/** Reads background's persisted active-session state instead of trusting a one-shot message. */
async function rehydrate(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage<
      Message,
      RecordingStateResponse | undefined
    >({
      type: "GET_RECORDING_STATE",
    });
    notice = response?.lastError ?? null;
    const session = response?.session ?? null;
    if (!session) {
      view = { kind: "IDLE" };
      return;
    }
    view =
      session.status === "RECORDING"
        ? { kind: "RECORDING", sessionId: session.sessionId }
        : { kind: "STARTING" };
  } catch (error) {
    logger.error("could not read recording state", { error: String(error) });
    view = { kind: "IDLE" };
  }
}

async function applyGuard(): Promise<void> {
  const tab = await getActiveTab();
  const guard = evaluateGuard(
    !!tab && isMeetUrl(tab.url),
    tab ? extractMeetingCode(tab.url) : null,
    undefined,
  );
  if (guard.allowed) {
    guardAllowed = true;
    guardMessage = "Ready to record this Meet tab.";
    return;
  }
  guardAllowed = false;
  guardMessage =
    guard.reason === "NOT_MEET_TAB"
      ? "Open a Google Meet class tab first, then click the extension icon again."
      : `This tab's meeting code doesn't match the scheduled class (${guard.actualCode}). Confirm before recording.`;
}

function guardFailureText(
  message: Extract<Message, { type: "GUARD_RESULT" }>,
): string {
  switch (message.reason) {
    case "ALREADY_RECORDING":
      return "A recording is already running. Use Stop to end it first.";
    case "NOT_MEET_TAB":
      return "Open a Google Meet class tab first, then click the extension icon again.";
    case "MEETING_CODE_MISMATCH":
      return "This tab's meeting code doesn't match the scheduled class.";
    case "START_FAILED":
      return `Could not start recording: ${message.detail ?? "unknown error"}`;
    case "MIC_PERMISSION_NEEDED":
      return "Grant microphone access in the tab that just opened, then click Start again.";
    case "MIC_PERMISSION_DENIED":
      return "Microphone access is blocked for this extension. Reset it under chrome://settings/content/microphone, then try again.";
    case undefined:
      return "Could not start recording.";
    default:
      return assertNever(message.reason);
  }
}

startBtn.addEventListener("click", () => {
  void (async () => {
    const tab = await getActiveTab();
    if (!tab) {
      notice = "No active tab found.";
      render();
      return;
    }
    notice = null;
    view = { kind: "STARTING" };
    render();
    await browser.runtime.sendMessage({
      type: "START_RECORDING",
      tabId: tab.id,
    });
  })();
});

stopBtn.addEventListener("click", () => {
  void (async () => {
    if (view.kind !== "RECORDING") return;
    const { sessionId } = view;
    view = { kind: "STOPPING", sessionId };
    render();
    // Goes to background only. Background is the single context that relays a
    // stop into the offscreen document, so there is no second delivery path.
    await browser.runtime.sendMessage({ type: "STOP_RECORDING", sessionId });
  })();
});

browser.runtime.onMessage.addListener((message: Message) => {
  switch (message.type) {
    case "RECORDING_STATE":
      if (message.state === "RECORDING") {
        notice = null;
        view = { kind: "RECORDING", sessionId: message.sessionId };
      } else if (message.state === "FAILED") {
        notice = message.error ?? "Recording failed.";
        view = { kind: "IDLE" };
      } else if (message.state === "FINALIZING") {
        notice = "Recording saved.";
        view = { kind: "IDLE" };
      }
      render();
      return;
    case "GUARD_RESULT":
      if (message.allowed) return;
      notice = guardFailureText(message);
      view = { kind: "IDLE" };
      render();
      if (message.reason === "ALREADY_RECORDING") {
        // Show the running session so Stop becomes reachable again.
        void rehydrate().then(render);
      }
      return;
    // Addressed to background, the offscreen document or a content script.
    case "START_RECORDING":
    case "STOP_RECORDING":
    case "GET_RECORDING_STATE":
    case "RECORDING_STARTED":
    case "RECORDING_STOP":
    case "GET_MIC_PERMISSION_STATE":
    case "MIC_MUTE_CHANGED":
    case "SET_MIC_MUTED":
    case "STORAGE_GET":
    case "STORAGE_SET":
    case "AUDIO_ALERT":
    case "VIDEO_STALLED":
    case "VIDEO_RECOVERED":
    case "RECORDING_ACTIVE":
      return;
    default:
      return assertNever(message);
  }
});

void (async () => {
  render();
  await rehydrate();
  await applyGuard();
  render();
})();
