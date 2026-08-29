import type { ActiveSessionInfo } from "../shared/messages";
import { extractMeetingCode } from "./meeting-code";

export type SessionEndReason = "TAB_CLOSED" | "MEETING_LEFT";

/** Bắt cả đóng cửa sổ chứa tab và tab crash — Chrome bắn `tabs.onRemoved` cho cả ba. */
export function evaluateTabRemoved(
  active: ActiveSessionInfo | null,
  closedTabId: number,
): SessionEndReason | null {
  if (!active) return null;
  return active.tabId === closedTabId ? "TAB_CLOSED" : null;
}

/**
 * Chỉ so mã phòng chứ không so cả URL: Meet đổi query string ngay trong phiên.
 * Phiên cũ lưu từ bản trước không có `meetingCode` — không đủ dữ liệu để kết
 * luận thì không kết luận, `evaluateTabRemoved` vẫn phủ được.
 */
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

/**
 * Bấm "Kết thúc cuộc gọi" KHÔNG đổi URL — Meet giữ nguyên tab và mã phòng, chỉ
 * vẽ đè màn hình hậu-cuộc-gọi, và mãi ~60 giây sau mới tự về trang chủ. Nên
 * `evaluateTabUrlChange` không thấy, `videoTrack.onended` cũng không (tab vẫn
 * đang bị capture, chỉ là đang quay đúng màn hình đó). Đây là đường duy nhất.
 *
 * `data-call-ended` là thuộc tính trạng thái chức năng nên không đổi theo ngôn
 * ngữ tài khoản, và ổn định hơn các `jsname` obfuscate quanh nó. Vẫn sẽ vỡ khi
 * Google đổi giao diện: không tìm thấy thì im lặng, ghi hình chạy tiếp đúng như
 * trước, hai lớp kia không bị ảnh hưởng.
 */
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
