/**
 * Bốn nguồn cảnh báo bật/tắt độc lập với nhau, nên một cờ boolean không đủ:
 * mic hết câm trong khi ổ đĩa vẫn sắp đầy thì phiên vẫn đang DEGRADED.
 *
 * Lưu dưới dạng mảng chứ không phải Set vì nó được persist vào
 * chrome.storage.local — service worker chết bất cứ lúc nào và Set không
 * qua được structured clone của storage.
 */
export type AlertKey = 'mic' | 'tab' | 'video' | 'storage';

/** Trả về tập cảnh báo mới sau khi bật hoặc tắt một nguồn. Không sửa mảng đầu vào. */
export function withAlert(
  alerts: readonly AlertKey[],
  key: AlertKey,
  active: boolean,
): AlertKey[] {
  const without = alerts.filter((alert) => alert !== key);
  return active ? [...without, key] : without;
}

/** Còn bất kỳ cảnh báo nào đang bật thì phiên đang DEGRADED (vẫn ghi tiếp — R12). */
export function isDegraded(alerts: readonly AlertKey[]): boolean {
  return alerts.length > 0;
}
