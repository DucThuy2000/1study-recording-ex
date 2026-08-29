import "./style.css";
import { browser } from "wxt/browser";
import type { Message, RecordingStateResponse } from "@/src/shared/messages";
import { getActiveTab } from "@/src/adapters/chrome-api";
import { createLogger } from "@/src/core/logger";
import { isMeetUrl, extractMeetingCode } from "@/src/core/meeting-code";
import { evaluateGuard } from "@/src/core/tab-guard";
import { formatClock } from "@/src/core/badge-format";
import { assertNever } from "@/src/core/assert";

const logger = createLogger("popup");

const el = {
  chip: document.querySelector<HTMLSpanElement>("#chip")!,
  clock: document.querySelector<HTMLDivElement>("#clock")!,
  room: document.querySelector<HTMLDivElement>("#room")!,
  roomCode: document.querySelector<HTMLSpanElement>("#room-code")!,
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
  const actualCode = tab ? extractMeetingCode(tab.url) : null;
  const guard = evaluateGuard(
    !!tab && isMeetUrl(tab.url),
    actualCode,
    undefined,
  );
  if (guard.allowed) {
    guardAllowed = true;
    // Chỉ lấy mã phòng của tab đang active khi KHÔNG có phiên nào chạy. Đang
    // ghi mà mở popup từ một tab Meet khác thì mã phòng phải là của phiên
    // đang ghi, không phải của tab đang nhìn.
    if (view.kind === "IDLE") roomCode = actualCode;
    guardMessage = "Sẵn sàng ghi tab Meet này.";
    return;
  }
  guardAllowed = false;
  guardMessage =
    guard.reason === "NOT_MEET_TAB"
      ? "Mở tab Google Meet của lớp rồi bấm lại vào biểu tượng extension."
      : `Mã phòng của tab này (${guard.actualCode}) không khớp lớp đã lên lịch. Xác nhận trước khi ghi.`;
}

function guardFailureText(
  message: Extract<Message, { type: "GUARD_RESULT" }>,
): string {
  switch (message.reason) {
    case "ALREADY_RECORDING":
      return "Đang có một phiên ghi chạy. Bấm Dừng ghi để kết thúc phiên đó trước.";
    case "NOT_MEET_TAB":
      return "Mở tab Google Meet của lớp rồi bấm lại vào biểu tượng extension.";
    case "MEETING_CODE_MISMATCH":
      return "Mã phòng của tab này không khớp lớp đã lên lịch.";
    case "START_FAILED":
      return `Không bắt đầu ghi được: ${message.detail ?? "lỗi không xác định"}`;
    case "MIC_PERMISSION_NEEDED":
      return "Cấp quyền micro ở tab vừa mở, rồi bấm Bắt đầu ghi lại.";
    case "MIC_PERMISSION_DENIED":
      return "Quyền micro đang bị chặn. Mở chrome://settings/content/microphone để bỏ chặn rồi thử lại.";
    case "LOW_DISK":
      return (
        message.detail ??
        "Ổ đĩa sắp đầy — cần giải phóng dung lượng trước khi ghi."
      );
    case "BACKLOG_HIGH":
      return (
        message.detail ??
        "Bản ghi cũ tồn đọng quá nhiều, chưa được tải lên — mở Chrome để tự động tải lên rồi thử lại."
      );
    case undefined:
      return "Không bắt đầu ghi được.";
    default:
      return assertNever(message.reason);
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
      notice = { text: guardFailureText(message), tone: "error" };
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
