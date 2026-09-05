import "./style.css";
import { browser } from "wxt/browser";
import type { Message, RecordingStateResponse } from "@/src/shared/messages";
import type { TeachingMaterial } from "@/src/adapters/lms/types";
import { getActiveTab } from "@/src/adapters/chrome-api";
import { createLogger } from "@/src/core/logger";
import { formatClock } from "@/src/core/time-format";
import { assertNever } from "@/src/core/assert";
import {
  getLoginUrl,
  getGuardFailureMessage,
  applyLmsGuard,
  type PopupState,
} from "@/src/popup-logic";

const logger = createLogger("popup");

const el = {
  chip: document.querySelector<HTMLSpanElement>("#chip")!,
  clock: document.querySelector<HTMLDivElement>("#clock")!,
  classInfo: document.querySelector<HTMLDivElement>("#class-info")!,
  className: document.querySelector<HTMLSpanElement>("#class-name")!,
  room: document.querySelector<HTMLDivElement>("#room")!,
  roomCode: document.querySelector<HTMLSpanElement>("#room-code")!,
  materials: document.querySelector<HTMLDivElement>("#materials")!,
  materialsList: document.querySelector<HTMLDivElement>("#materials-list")!,
  loginBtn: document.querySelector<HTMLButtonElement>("#login-btn")!,
  levels: document.querySelector<HTMLDivElement>("#levels")!,
  micBar: document.querySelector<HTMLDivElement>("#mic-bar")!,
  tabBar: document.querySelector<HTMLDivElement>("#tab-bar")!,
  message: document.querySelector<HTMLParagraphElement>("#message")!,
  start: document.querySelector<HTMLButtonElement>("#start")!,
  stop: document.querySelector<HTMLButtonElement>("#stop")!,
};

type PopupView =
  | { kind: "IDLE" }
  | { kind: "STARTING" }
  | { kind: "RECORDING"; sessionId: string; startedAtMs: number }
  | { kind: "STOPPING"; sessionId: string };

type Tone = "muted" | "error" | "ok";

let view: PopupView = { kind: "IDLE" };
let guardAllowed = false;
let guardMessage = "Đang kiểm tra tab này…";
let roomCode: string | null = null;
let currentClassName: string | null = null;
let currentMaterials: TeachingMaterial[] = [];
let showLoginBtn = false;
let notice: { text: string; tone: Tone } | null = null;
let degraded = false;
let clockIntervalId: ReturnType<typeof setInterval> | undefined;

function setMessage(text: string, tone: Tone): void {
  el.message.textContent = text;
  el.message.dataset.tone = tone;
}

/**
 * Đồng hồ chạy trong popup được, nhưng mốc bắt đầu thì không: nó tính từ
 * `startedAtMs` mà background persist, nên đóng rồi mở lại popup giữa buổi
 * vẫn ra đúng số chứ không đếm lại từ 0.
 */
function startClock(startedAtMs: number): void {
  stopClock();
  const tick = (): void => {
    el.clock.textContent = formatClock(Date.now() - startedAtMs);
  };
  tick();
  clockIntervalId = setInterval(tick, 1000);
}

function stopClock(): void {
  if (clockIntervalId !== undefined) clearInterval(clockIntervalId);
  clockIntervalId = undefined;
}

function render(): void {
  const recording = view.kind === "RECORDING";

  el.chip.hidden = !recording && view.kind !== "STARTING";
  el.chip.textContent = recording ? "ĐANG GHI" : "ĐANG BẮT ĐẦU";
  el.chip.dataset.degraded = String(degraded && recording);

  el.clock.hidden = !recording;
  el.levels.hidden = !recording;

  el.room.hidden = roomCode === null;
  if (roomCode) el.roomCode.textContent = roomCode;

  el.classInfo.hidden = !currentClassName;
  if (currentClassName) el.className.textContent = currentClassName;

  el.materials.hidden = currentMaterials.length === 0;

  el.loginBtn.hidden = !showLoginBtn || view.kind !== "IDLE";

  el.start.hidden = recording || view.kind === "STOPPING";
  el.stop.hidden = !el.start.hidden;

  switch (view.kind) {
    case "IDLE":
      el.start.disabled = !guardAllowed;
      el.start.textContent = "Bắt đầu ghi";
      setMessage(notice?.text ?? guardMessage, notice?.tone ?? "muted");
      return;
    case "STARTING":
      el.start.disabled = true;
      el.start.textContent = "Đang bắt đầu…";
      setMessage("Đang chuẩn bị ghi hình…", "muted");
      return;
    case "RECORDING":
      el.stop.disabled = false;
      el.stop.textContent = "Dừng ghi";
      setMessage(notice?.text ?? "", notice?.tone ?? "muted");
      return;
    case "STOPPING":
      el.stop.disabled = true;
      el.stop.textContent = "Đang dừng…";
      setMessage("Đang chốt file…", "muted");
      return;
    default:
      return assertNever(view);
  }
}

function enterView(next: PopupView): void {
  view = next;
  if (next.kind === "RECORDING") startClock(next.startedAtMs);
  else stopClock();
  render();
}

/** Đọc trạng thái phiên đã persist ở background thay vì tin vào một message một chiều. */
async function rehydrate(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage<
      Message,
      RecordingStateResponse | undefined
    >({
      type: "GET_RECORDING_STATE",
    });
    const lastError = response?.lastError ?? null;
    notice = lastError ? { text: lastError, tone: "error" } : null;
    const session = response?.session ?? null;
    if (!session) {
      enterView({ kind: "IDLE" });
      return;
    }
    roomCode = session.meetingCode ?? roomCode;
    enterView(
      session.status === "RECORDING"
        ? {
            kind: "RECORDING",
            sessionId: session.sessionId,
            startedAtMs: session.startedAtMs,
          }
        : { kind: "STARTING" },
    );
  } catch (error) {
    logger.error("could not read recording state", { error: String(error) });
    enterView({ kind: "IDLE" });
  }
}

async function applyGuard(): Promise<void> {
  const tab = await getActiveTab();
  const state: PopupState = {
    guardAllowed,
    guardMessage,
    roomCode,
    currentClassName,
    currentMaterials,
    showLoginBtn,
  };

  try {
    await applyLmsGuard(
      tab?.url,
      (msg) => browser.runtime.sendMessage(msg),
      state,
      {
        classInfo: el.classInfo,
        className: el.className,
        materials: el.materials,
        materialsList: el.materialsList,
        loginBtn: el.loginBtn,
      },
      view.kind === "IDLE",
    );
  } catch (error) {
    logger.error("could not check LMS context", { error: String(error) });
    state.guardAllowed = false;
    state.currentClassName = null;
    state.currentMaterials = [];
    state.showLoginBtn = false;
    el.classInfo.hidden = true;
    el.materials.hidden = true;
    el.loginBtn.hidden = true;
    state.guardMessage = getGuardFailureMessage("NETWORK_ERROR");
  } finally {
    guardAllowed = state.guardAllowed;
    guardMessage = state.guardMessage;
    roomCode = state.roomCode;
    currentClassName = state.currentClassName;
    currentMaterials = state.currentMaterials;
    showLoginBtn = state.showLoginBtn;
  }
}

el.start.addEventListener("click", () => {
  void (async () => {
    const tab = await getActiveTab();
    if (!tab) {
      notice = { text: "Không tìm thấy tab đang mở.", tone: "error" };
      render();
      return;
    }
    notice = null;
    enterView({ kind: "STARTING" });
    await browser.runtime.sendMessage({
      type: "START_RECORDING",
      tabId: tab.id,
    });
  })();
});

el.stop.addEventListener("click", () => {
  void (async () => {
    if (view.kind !== "RECORDING") return;
    const { sessionId } = view;
    enterView({ kind: "STOPPING", sessionId });
    await browser.runtime.sendMessage({ type: "STOP_RECORDING", sessionId });
  })();
});

el.loginBtn.addEventListener("click", () => {
  const url = getLoginUrl();
  void browser.tabs.create({ url });
});

browser.runtime.onMessage.addListener((message: Message) => {
  switch (message.type) {
    case "AUDIO_LEVEL":
      el.micBar.style.width = `${message.mic}%`;
      el.tabBar.style.width = `${message.tab}%`;
      return;
    case "AUDIO_ALERT":
      degraded = message.silent;
      notice = message.silent
        ? {
            text:
              message.source === "mic"
                ? "Không nghe thấy giọng bạn — kiểm tra micro."
                : "Không nghe thấy học sinh — kiểm tra âm thanh tab.",
            tone: "error",
          }
        : null;
      render();
      return;
    case "RECORDING_STATE":
      if (message.state === "RECORDING") {
        notice = null;
        void rehydrate();
      } else if (message.state === "FAILED") {
        notice = { text: message.error ?? "Ghi hình thất bại.", tone: "error" };
        degraded = false;
        enterView({ kind: "IDLE" });
      } else if (message.state === "FINALIZING") {
        notice = { text: "Đã lưu bản ghi.", tone: "ok" };
        degraded = false;
        enterView({ kind: "IDLE" });
      }
      return;
    case "GUARD_RESULT":
      if (message.allowed) return;
      notice = {
        text: getGuardFailureMessage(message.reason, message.detail),
        tone: "error",
      };
      showLoginBtn = message.reason === "NOT_LOGGED_IN";
      enterView({ kind: "IDLE" });
      if (message.reason === "ALREADY_RECORDING") {
        // Hiện lại phiên đang chạy để nút Dừng với tới được.
        void rehydrate();
      }
      return;
    // Gửi cho background, offscreen hoặc content script.
    case "START_RECORDING":
    case "STOP_RECORDING":
    case "GET_RECORDING_STATE":
    case "RECORDING_STARTED":
    case "RECORDING_STOP":
    case "GET_MIC_PERMISSION_STATE":
    case "MIC_MUTE_CHANGED":
    case "MEETING_LEFT":
    case "SET_MIC_MUTED":
    case "STORAGE_GET":
    case "STORAGE_SET":
    case "VIDEO_STALLED":
    case "VIDEO_RECOVERED":
    case "STORAGE_ALERT":
    case "RECORDING_ACTIVE":
    case "LMS_GET_CONTEXT":
    case "LMS_END_CLASS":
      return;
    default:
      return assertNever(message);
  }
});

// Popup đóng là bị huỷ hẳn, nhưng clear interval tường minh vẫn đúng và rẻ.
window.addEventListener("unload", stopClock);

void (async () => {
  render();
  await rehydrate();
  await applyGuard();
  render();
})();
