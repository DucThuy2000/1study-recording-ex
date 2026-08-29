/**
 * chrome.action.setBadgeText cắt cụt text quá dài, nên trần này là ràng buộc
 * cứng chứ không phải lựa chọn thẩm mỹ. Lớp học không dài tới 10 tiếng.
 */
const MAX_BADGE_MS = 10 * 60 * 60 * 1000 - 60_000;

/** Thời gian đã ghi, gói trong tối đa 4 ký tự: `0m`, `45m`, `1h05`. */
export function formatElapsedBadge(elapsedMs: number): string {
  const capped = Math.min(Math.max(elapsedMs, 0), MAX_BADGE_MS);
  const totalMinutes = Math.floor(capped / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${String(minutes).padStart(2, '0')}`;
}

/** Đồng hồ đầy đủ cho popup và pill: `45:12` dưới một giờ, `1:05:30` từ một giờ. */
export function formatClock(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
