import type { ActiveSessionInfo } from '../shared/messages';
import { extractMeetingCode } from './meeting-code';

/** Vì sao một phiên đang ghi kết thúc mà không phải do giáo viên bấm Dừng. */
export type SessionEndReason = 'TAB_CLOSED' | 'MEETING_LEFT';

/**
 * Đóng tab đang ghi là kết thúc lớp. Bắt luôn cả đóng cửa sổ chứa tab và tab
 * crash — Chrome bắn `tabs.onRemoved` cho cả ba.
 */
export function evaluateTabRemoved(
  active: ActiveSessionInfo | null,
  closedTabId: number,
): SessionEndReason | null {
  if (!active) return null;
  return active.tabId === closedTabId ? 'TAB_CLOSED' : null;
}

/**
 * Bấm "Kết thúc cuộc gọi" khiến Meet điều hướng khỏi mã phòng. Meet cũng đổi
 * query string ngay trong phiên, nên chỉ so mã phòng chứ không so cả URL.
 *
 * Phiên cũ lưu từ bản trước không có `meetingCode`; không đủ dữ liệu để kết
 * luận thì không kết luận — `evaluateTabRemoved` vẫn bảo vệ được trường hợp đó.
 */
export function evaluateTabUrlChange(
  active: ActiveSessionInfo | null,
  tabId: number,
  newUrl: string | undefined,
): SessionEndReason | null {
  if (!active || active.tabId !== tabId) return null;
  if (!active.meetingCode) return null;
  if (newUrl === undefined) return null;
  return extractMeetingCode(newUrl) === active.meetingCode ? null : 'MEETING_LEFT';
}
