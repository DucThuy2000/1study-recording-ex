import { defineBackground } from "wxt/utils/define-background";
import { browser, type Browser } from "wxt/browser";
import type {
  ActiveSessionInfo,
  Message,
  MessageOf,
  MicPermissionStateResponse,
  RecordingStateResponse,
  StorageGetResponse,
} from "@/src/shared/messages";
import {
  ChromeTabCaptureApi,
  ChromeOffscreenApi,
} from "@/src/adapters/chrome-api";
import { ChromeStorageAdapter } from "@/src/adapters/storage";
import { CONFIG } from "@/src/shared/config";
import { createLogger } from "@/src/core/logger";
import { isMeetUrl, extractMeetingCode } from "@/src/core/meeting-code";
import { evaluateGuard } from "@/src/core/tab-guard";
import {
  evaluateTabRemoved,
  evaluateTabUrlChange,
  type SessionEndReason,
} from "@/src/core/session-end-detector";
import { formatElapsedBadge } from "@/src/core/badge-format";
import { withAlert, isDegraded, type AlertKey } from "@/src/core/alert-set";
import { assertNever } from "@/src/core/assert";
import { SessionLedger } from "@/src/core/session-ledger";
import {
  evaluateStorageGuard,
  sumBacklogBytes,
  formatBytes,
} from "@/src/core/storage-guard";
import { EventReporter } from "@/src/core/event-reporter";
import { EventBus } from "@/src/core/event-bus";
import type { RecordingEvent } from "@/src/core/event-reporter";

const logger = createLogger("background");
const tabCapture = new ChromeTabCaptureApi();
const offscreen = new ChromeOffscreenApi();
const store = new ChromeStorageAdapter();
const sessionLedger = new SessionLedger(store);
const backgroundEventReporter = new EventReporter(
  store,
  new EventBus<{ event: RecordingEvent }>(),
  logger,
);

/**
 * Active-session ownership lives here and nowhere else, persisted rather than
 * held in a module variable because Chrome kills the service worker at will —
 * mid-session included. Every other context (popup, content script) asks for
 * this state instead of remembering its own copy.
 */
const ACTIVE_SESSION_KEY = "activeSession";
const LAST_ERROR_KEY = "lastSessionError";
const ACTIVE_ALERTS_KEY = "activeAlerts";
const BADGE_ALARM = "badgeTick";

function makeSessionId(): string {
  return crypto.randomUUID();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readActiveSession(): Promise<ActiveSessionInfo | null> {
  return (
    (await store.get<ActiveSessionInfo | null>(ACTIVE_SESSION_KEY)) ?? null
  );
}

async function writeActiveSession(
  session: ActiveSessionInfo | null,
): Promise<void> {
  await store.set(ACTIVE_SESSION_KEY, session);
}

async function readLastError(): Promise<string | null> {
  return (await store.get<string | null>(LAST_ERROR_KEY)) ?? null;
}

async function writeLastError(error: string | null): Promise<void> {
  await store.set(LAST_ERROR_KEY, error);
}

async function readActiveAlerts(): Promise<AlertKey[]> {
  return (await store.get<AlertKey[]>(ACTIVE_ALERTS_KEY)) ?? [];
}

/**
 * Vẽ lại badge từ trạng thái đã persist chứ không từ biến trong bộ nhớ:
 * service worker chết giữa buổi là chuyện thường, và đồng hồ phải chạy tiếp
 * đúng chứ không nhảy về 0.
 */
async function refreshBadge(): Promise<void> {
  const active = await readActiveSession();
  if (!active) {
    await browser.action.setBadgeText({ text: "" });
    return;
  }
  const degraded = isDegraded(await readActiveAlerts());
  await browser.action.setBadgeText({
    text: formatElapsedBadge(Date.now() - active.startedAtMs),
  });
  await browser.action.setBadgeBackgroundColor({
    color: degraded
      ? CONFIG.BADGE_COLOR_DEGRADED
      : CONFIG.BADGE_COLOR_RECORDING,
  });
}

/** Mọi thứ gắn với badge của một phiên đang chạy. Gọi ở mọi đường giải phóng phiên. */
async function clearBadgeState(): Promise<void> {
  await browser.alarms.clear(BADGE_ALARM);
  await store.set(ACTIVE_ALERTS_KEY, []);
  await browser.action.setBadgeText({ text: "" });
}

/** Bật/tắt một nguồn cảnh báo rồi vẽ lại badge nếu tập cảnh báo thực sự đổi. */
async function setAlert(key: AlertKey, active: boolean): Promise<void> {
  const before = await readActiveAlerts();
  const after = withAlert(before, key, active);
  if (before.length === after.length) return;
  await store.set(ACTIVE_ALERTS_KEY, after);
  await refreshBadge();
}

/**
 * The only way to reach a content script — `runtime.sendMessage` never does.
 * The tab may have been closed mid-session, so this must not throw.
 */
async function sendToTab(tabId: number, message: Message): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, message);
  } catch (error) {
    logger.debug("content script unreachable", {
      tabId,
      type: message.type,
      error: describeError(error),
    });
  }
}

async function refreshActionState(
  tabId: number,
  url: string | undefined,
): Promise<void> {
  if (url && isMeetUrl(url)) {
    await browser.action.enable(tabId);
  } else {
    await browser.action.disable(tabId);
  }
}

async function refuseStart(
  reason: MessageOf<"GUARD_RESULT">["reason"],
  detail?: string,
): Promise<void> {
  logger.warn("start refused", { reason, detail });
  await browser.runtime.sendMessage({
    type: "GUARD_RESULT",
    allowed: false,
    reason,
    detail,
  });
}

/**
 * `getUserMedia` in the offscreen document can never show a permission
 * prompt — it has no visible surface. So this is checked up front, from a
 * document that can actually answer (the offscreen document itself; its
 * origin's grant is shared with every extension page), rather than letting
 * a denied or never-asked mic fail the whole recording silently (R4/R6).
 */
async function checkMicPermissionState(): Promise<
  MicPermissionStateResponse["state"]
> {
  try {
    await offscreen.ensureDocument(
      "/offscreen.html",
      ["USER_MEDIA"],
      "Recording the class session tab for teaching quality review.",
    );
    const response = await browser.runtime.sendMessage({
      type: "GET_MIC_PERMISSION_STATE",
    });
    return response?.state ?? "prompt";
  } catch (error) {
    logger.warn("could not check microphone permission state", {
      error: describeError(error),
    });
    return "prompt";
  }
}

/**
 * Refuses the start AND persists the reason, unlike a guard refusal (which
 * the popup can always recompute live from the tab it's looking at). Nothing
 * but this round-trip knows the mic permission state, and opening the tab
 * below is itself liable to kill the popup before it ever renders the
 * `GUARD_RESULT` broadcast — the same focus-loss problem that ruled out
 * priming from the popup in the first place, just one step removed. Without
 * persisting it, the one attempt where this guidance matters most (the very
 * first click, before anything is granted) is the one most likely to lose it.
 */
async function refuseStartAndPersist(
  reason: MessageOf<"GUARD_RESULT">["reason"],
  detail: string,
): Promise<void> {
  await writeLastError(detail);
  await refuseStart(reason, detail);
}

/**
 * Brings an already-open permission tab to the front instead of piling up a
 * new one on every repeated Start click — plausible here specifically,
 * since a teacher whose popup just vanished (see refuseStartAndPersist) has
 * no visible feedback and no obvious reason not to click Start again.
 */
async function openPermissionTab(): Promise<void> {
  const url = browser.runtime.getURL("/permission.html");
  const [existing] = await browser.tabs.query({ url });
  if (existing?.id !== undefined) {
    await browser.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined)
      await browser.windows.update(existing.windowId, { focused: true });
    return;
  }
  await browser.tabs.create({ url });
}

async function handleStart(
  message: MessageOf<"START_RECORDING">,
): Promise<void> {
  await writeLastError(null);

  const existing = await readActiveSession();
  if (existing) {
    const isStaleStart =
      existing.status === "STARTING" &&
      Date.now() - existing.startedAtMs > CONFIG.STARTING_ACK_TIMEOUT_MS;

    if (!isStaleStart) {
      await refuseStart(
        "ALREADY_RECORDING",
        `Session ${existing.sessionId} is already recording.`,
      );
      return;
    }
    logger.warn("clearing a STARTING session that never acked", {
      sessionId: existing.sessionId,
      ageMs: Date.now() - existing.startedAtMs,
    });
    await writeActiveSession(null);
  }

  const tab = await browser.tabs.get(message.tabId);
  const guard = evaluateGuard(
    isMeetUrl(tab.url ?? ""),
    extractMeetingCode(tab.url ?? ""),
    undefined,
  );
  if (!guard.allowed) {
    await refuseStart(guard.reason);
    return;
  }

  // Guard đã bảo đảm đây là tab Meet có mã phòng hợp lệ, nên giá trị này
  // không thể null — tính một lần ở đây thay vì ép kiểu ở từng chỗ dùng.
  const meetingCode = extractMeetingCode(tab.url ?? "")!;

  // Prevent client's device run out of disk spaces
  const { quota, usage } = await navigator.storage.estimate();
  const freeBytes = (quota ?? 0) - (usage ?? 0);
  const backlogBytes = sumBacklogBytes(await sessionLedger.list());
  const storageGuard = evaluateStorageGuard(freeBytes, backlogBytes);
  if (!storageGuard.allowed) {
    await backgroundEventReporter.report(
      storageGuard.reason,
      storageGuard.reason === "LOW_DISK"
        ? { freeBytes: storageGuard.freeBytes }
        : { backlogBytes: storageGuard.backlogBytes },
    );
    await refuseStart(
      storageGuard.reason,
      storageGuard.reason === "LOW_DISK"
        ? `Chỉ còn ${formatBytes(storageGuard.freeBytes)} trống — cần tối thiểu ${formatBytes(CONFIG.DISK_MIN_FREE_BYTES)} để bắt đầu ghi.`
        : `Bản ghi cũ tồn đọng ${formatBytes(storageGuard.backlogBytes)} chưa dọn — tạm dừng ghi mới cho tới khi được tải lên.`,
    );
    return;
  }

  const micState = await checkMicPermissionState();
  if (micState === "denied") {
    await refuseStartAndPersist(
      "MIC_PERMISSION_DENIED",
      "Microphone access is blocked for this extension. Reset it under chrome://settings/content/microphone, then try again.",
    );
    return;
  }
  if (micState !== "granted") {
    await openPermissionTab();
    await refuseStartAndPersist(
      "MIC_PERMISSION_NEEDED",
      "Grant microphone access in the tab that just opened, then click Start again.",
    );
    return;
  }

  const sessionId = makeSessionId();
  try {
    const streamId = await tabCapture.getMediaStreamId(message.tabId);
    await writeActiveSession({
      sessionId,
      tabId: message.tabId,
      meetingCode,
      status: "STARTING",
      startedAtMs: Date.now(),
    });
    await sessionLedger.start({
      sessionId,
      meetingCode,
      tabId: message.tabId,
      startedAtMs: Date.now(),
    });
    // Already exists from the permission check above; ensureDocument() is a
    // no-op when one does, so this stays correct even if that check is ever
    // skipped or reordered.
    await offscreen.ensureDocument(
      "/offscreen.html",
      ["USER_MEDIA"],
      "Recording the class session tab for teaching quality review.",
    );
    await browser.runtime.sendMessage({
      type: "RECORDING_STARTED",
      sessionId,
      streamId,
    });
    logger.info("start dispatched", { sessionId, tabId: message.tabId });
  } catch (error) {
    const detail = describeError(error);
    await writeActiveSession(null);
    await sessionLedger.setStatus(sessionId, "FAILED");
    await writeLastError(detail);
    logger.error("start failed", { sessionId, error: detail });
    await refuseStart("START_FAILED", detail);
  }
}

async function endSession(
  sessionId: string,
  reason: SessionEndReason,
): Promise<void> {
  const active = await readActiveSession();
  if (!active || active.sessionId !== sessionId) {
    logger.warn("end requested for a session this worker does not own", {
      requested: sessionId,
      active: active?.sessionId ?? null,
      reason,
    });
  }

  logger.info("ending session", { sessionId, reason });

  await writeActiveSession(null);
  await clearBadgeState();
  if (active) {
    await sendToTab(active.tabId, {
      type: "RECORDING_ACTIVE",
      active: false,
      sessionId: null,
      startedAtMs: null,
    });
  }

  // offscreen listen this event then stop recorder
  await browser.runtime.sendMessage({ type: "RECORDING_STOP", sessionId });
}

async function handleStop(message: MessageOf<"STOP_RECORDING">): Promise<void> {
  await endSession(message.sessionId, "USER_STOPPED");
}

async function handleRecordingState(
  message: MessageOf<"RECORDING_STATE">,
): Promise<void> {
  const active = await readActiveSession();

  if (message.state === "RECORDING") {
    if (!active || active.sessionId !== message.sessionId) {
      logger.warn("ack for a session this worker does not own", {
        sessionId: message.sessionId,
      });
      return;
    }
    await writeActiveSession({ ...active, status: "RECORDING" });
    await store.set(ACTIVE_ALERTS_KEY, []);
    // chrome.alarms chứ không phải setInterval: service worker bị Chrome giết
    // bất cứ lúc nào, alarm đánh thức nó dậy đúng hạn còn setInterval chết theo.
    await browser.alarms.create(BADGE_ALARM, {
      periodInMinutes: CONFIG.BADGE_TICK_ALARM_MINUTES,
    });
    await refreshBadge();
    await sendToTab(active.tabId, {
      type: "RECORDING_ACTIVE",
      active: true,
      sessionId: message.sessionId,
      startedAtMs: active.startedAtMs,
    });
    logger.info("recording confirmed", {
      sessionId: message.sessionId,
      tabId: active.tabId,
    });
    return;
  }

  if (message.state === "FAILED") {
    const detail = message.error ?? "Recording failed.";
    logger.error("recording failed", {
      sessionId: message.sessionId,
      error: detail,
    });
    await sessionLedger.setStatus(message.sessionId, "FAILED");
    await writeLastError(detail);
    if (active?.sessionId === message.sessionId) {
      await writeActiveSession(null);
      await clearBadgeState();
      await sendToTab(active.tabId, {
        type: "RECORDING_ACTIVE",
        active: false,
        sessionId: null,
        startedAtMs: null,
      });
    }
    return;
  }

  if (message.state === "FINALIZING") {
    await sessionLedger.setStatus(message.sessionId, "STOPPED");

    // Khi offscreen tự dừng (video track chết) thì background chưa hề biết.
    // endSession chưa chạy, nên phải dọn ở đây. Nếu endSession đã chạy rồi
    // thì active đã null và cả khối này là no-op.
    if (active?.sessionId === message.sessionId) {
      await writeActiveSession(null);
      await clearBadgeState();
      await sendToTab(active.tabId, {
        type: "RECORDING_ACTIVE",
        active: false,
        sessionId: null,
        startedAtMs: null,
      });
    }
    return;
  }

  logger.info("session state", {
    sessionId: message.sessionId,
    state: message.state,
  });
}

/** Fans an offscreen alert out to the tab being recorded — the only way it reaches a content script. */
async function fanOutToRecordedTab(message: Message): Promise<void> {
  const active = await readActiveSession();
  if (!active) return;
  await sendToTab(active.tabId, message);
}

/**
 * Every Meet tab reports its own mute button, recording or not — only the
 * tab actually being recorded should ever reach the offscreen document's
 * mic gain node, or a teacher muting themselves on an unrelated Meet tab in
 * another window would silence the real recording.
 */
async function handleMicMuteChanged(
  message: MessageOf<"MIC_MUTE_CHANGED">,
  senderTabId: number | undefined,
): Promise<void> {
  const active = await readActiveSession();
  if (!active || active.tabId !== senderTabId) return;
  await browser.runtime.sendMessage({
    type: "SET_MIC_MUTED",
    muted: message.muted,
  } satisfies Message);
}

/**
 * Meet giữ nguyên URL khi giáo viên bấm "Kết thúc cuộc gọi" — nó chỉ vẽ đè
 * màn hình hậu-cuộc-gọi — nên `evaluateTabUrlChange` không bao giờ thấy, và
 * `videoTrack.onended` cũng không: tab vẫn đang bị capture, chỉ là đang quay
 * đúng cái màn hình đó. Đây là đường phát hiện duy nhất cho trường hợp này.
 *
 * Chỉ chấp nhận từ đúng tab đang ghi. Mọi tab Meet đều chạy content script,
 * nên một tab Meet khác kết thúc cuộc gọi của nó không được phép dừng lớp
 * đang dạy.
 */
async function handleMeetingLeft(senderTabId: number | undefined): Promise<void> {
  const active = await readActiveSession();
  if (!active || active.tabId !== senderTabId) return;
  await endSession(active.sessionId, "MEETING_LEFT");
}

async function buildStateResponse(
  senderTabId: number | undefined,
): Promise<RecordingStateResponse> {
  const session = await readActiveSession();
  return {
    session,
    lastError: await readLastError(),
    activeForSenderTab:
      senderTabId !== undefined &&
      session?.tabId === senderTabId &&
      session.status === "RECORDING",
  };
}

/** Runs a handler's async body without letting a rejection escape as an unhandled promise. */
function run(task: Promise<void>, label: string): void {
  void task.catch((error: unknown) =>
    logger.error(`${label} failed`, { error: describeError(error) }),
  );
}

export default defineBackground(() => {
  logger.info("service worker started");

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== BADGE_ALARM) return;
    run(refreshBadge(), "badge tick");
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete") refreshActionState(tabId, tab.url);

    if (changeInfo.url === undefined) return;
    run(
      (async () => {
        const active = await readActiveSession();
        const reason = evaluateTabUrlChange(active, tabId, changeInfo.url);
        if (!reason || !active) return;
        await endSession(active.sessionId, reason);
      })(),
      "tab url change",
    );
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    run(
      (async () => {
        const active = await readActiveSession();
        const reason = evaluateTabRemoved(active, tabId);
        if (!reason || !active) return;
        await endSession(active.sessionId, reason);
      })(),
      "tab removed",
    );
  });

  browser.tabs.onActivated.addListener(async ({ tabId }) => {
    const tab = await browser.tabs.get(tabId);
    void refreshActionState(tabId, tab.url);
  });

  browser.runtime.onMessage.addListener(
    (
      message: Message,
      sender: Browser.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ) => {
      switch (message.type) {
        case "START_RECORDING":
          run(handleStart(message), "start");
          return false;
        case "STOP_RECORDING":
          run(handleStop(message), "stop");
          return false;
        case "GET_RECORDING_STATE":
          // Async response, so the channel has to be held open with `return true`.
          run(
            buildStateResponse(sender.tab?.id).then((response) =>
              sendResponse(response),
            ),
            "state query",
          );
          return true;
        case "STORAGE_GET":
          // The offscreen document's only proxy onto chrome.storage — see the
          // Message union's own comment on STORAGE_GET/STORAGE_SET for why.
          run(
            store
              .get(message.key)
              .then((value) =>
                sendResponse({ value } satisfies StorageGetResponse),
              ),
            "storage get",
          );
          return true;
        case "STORAGE_SET":
          // Fire-and-forget: the sender's own await resolves on message
          // dispatch, not on this set() actually committing. What makes
          // ordering-sensitive callers (e.g. Task 1's stop()-waits-for-
          // ledger-write fix) correct in practice is chrome.storage.local's
          // FIFO ordering within one storage area, not any guarantee this
          // handler itself provides.
          run(store.set(message.key, message.value), "storage set");
          return false;
        case "RECORDING_STATE":
          run(handleRecordingState(message), "state update");
          return false;
        case "AUDIO_ALERT":
          run(setAlert(message.source, message.silent), "audio alert badge");
          run(fanOutToRecordedTab(message), "alert fan-out");
          return false;
        case "VIDEO_STALLED":
          run(setAlert("video", true), "video stall badge");
          run(fanOutToRecordedTab(message), "alert fan-out");
          return false;
        case "VIDEO_RECOVERED":
          run(setAlert("video", false), "video recovered badge");
          run(fanOutToRecordedTab(message), "alert fan-out");
          return false;
        case "STORAGE_ALERT":
          run(setAlert("storage", message.low), "storage alert badge");
          run(fanOutToRecordedTab(message), "alert fan-out");
          return false;
        case "MIC_MUTE_CHANGED":
          run(
            handleMicMuteChanged(message, sender.tab?.id),
            "mic mute changed",
          );
          return false;
        case "MEETING_LEFT":
          run(handleMeetingLeft(sender.tab?.id), "meeting left");
          return false;
        // Mức âm chỉ dành cho popup — không đấu vào setAlert cũng không
        // fan-out sang content script, pill không hiện mức âm.
        case "AUDIO_LEVEL":
        // Messages this worker emits rather than consumes.
        case "RECORDING_STARTED":
        case "RECORDING_STOP":
        case "GET_MIC_PERMISSION_STATE":
        case "SET_MIC_MUTED":
        case "RECORDING_ACTIVE":
        case "GUARD_RESULT":
          return false;
        default:
          return assertNever(message);
      }
    },
  );
});
