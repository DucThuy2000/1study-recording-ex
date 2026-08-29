/**
 * Meet vẽ màn hình "Bạn đã rời khỏi cuộc họp" mà **không đổi URL** — mã phòng
 * giữ nguyên, tab giữ nguyên. Đã kiểm chứng trên Meet thật: vì thế bộ phát
 * hiện dựa trên URL ở background không bao giờ bắt được nút "Kết thúc cuộc
 * gọi", và tabCapture thì vẫn tiếp tục quay đúng màn hình đó trong khi micro
 * vẫn thu tiếng giáo viên. Meet chỉ tự điều hướng về trang chủ sau khoảng 60
 * giây, tức là một phút đuôi rác nếu chỉ chờ URL đổi.
 *
 * `data-call-ended` là thuộc tính trạng thái chức năng, không phải chữ hiển
 * thị: nó không đổi theo ngôn ngữ tài khoản, khác với tiêu đề "Bạn đã rời
 * khỏi cuộc họp", và ổn định hơn hẳn các `jsname` obfuscate quanh nó
 * (`W6suGc`, `dqt8Pb`) vốn đổi theo từng bản build của Meet.
 *
 * Vẫn là một selector của Meet, nên vẫn sẽ vỡ khi Google đổi giao diện. Cách
 * chống giống hệt phần phát hiện nút mute: không tìm thấy thì im lặng, ghi
 * hình chạy tiếp đúng như trước, và hai lớp còn lại (đóng tab ở background,
 * video track chết ở offscreen) vẫn nguyên vẹn.
 */
const CALL_ENDED_SELECTOR = '[data-call-ended="true"]';

/**
 * Gọi `onEnded` đúng một lần, ngay khi màn hình hậu-cuộc-gọi của Meet xuất
 * hiện. Trả về hàm huỷ theo dõi.
 */
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

  // Kiểm tra ngay trước khi theo dõi: reload tab sau khi đã rời cuộc họp thì
  // dấu hiệu có sẵn từ trước, chờ mutation sẽ chờ mãi mãi.
  check();
  if (reported) return () => undefined;

  observer = new MutationObserver(check);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-call-ended'],
  });
  return () => observer?.disconnect();
}
