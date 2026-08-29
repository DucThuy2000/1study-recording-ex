import type { ActiveSessionInfo } from "../shared/messages";
import { extractMeetingCode } from "./meeting-code";

/** Các hàm phát hiện dưới đây không bao giờ trả `USER_STOPPED` — nó đến từ nút Dừng. */
export type SessionEndReason = "USER_STOPPED" | "TAB_CLOSED" | "MEETING_LEFT";

export function evaluateTabRemoved(
  active: ActiveSessionInfo | null,
  closedTabId: number,
): SessionEndReason | null {
  if (!active) return null;
  return active.tabId === closedTabId ? "TAB_CLOSED" : null;
}

export function evaluateTabUrlChange(
  active: ActiveSessionInfo | null,
  tabId: number,
  newUrl: string | undefined,
): SessionEndReason | null {
  if (!active || active.tabId !== tabId) return null;
  if (!active.meetingCode) return null;
  if (newUrl === undefined) return null;
  return extractMeetingCode(newUrl) === active.meetingCode
    ? null
    : "MEETING_LEFT";
}

const CALL_ENDED_SELECTOR = '[data-call-ended="true"]';

/** Gọi `onEnded` đúng một lần khi màn hình hậu-cuộc-gọi xuất hiện. Trả về hàm huỷ theo dõi. */
export function watchCallEnded(onEnded: () => void): () => void {
  let reported = false;
  let observer: MutationObserver | undefined;

  function check(): void {
    if (reported) return;
    if (!document.querySelector(CALL_ENDED_SELECTOR)) return;
    reported = true;
    observer?.disconnect();
    onEnded();
  }

  // Reload tab sau khi đã rời cuộc họp thì dấu hiệu có sẵn từ trước, chờ
  // mutation sẽ chờ mãi mãi.
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
