# Đặc tả: Xác nhận trước khi rời cuộc gọi lúc đang ghi hình

> Bổ sung cho `2026-08-26-meet-recorder-extension-design.md` và `2026-08-29-recorder-ui-and-auto-stop-design.md`.
> Đọc Phần 2 (Luật tuyệt đối) của tài liệu gốc trước — mọi ràng buộc ở đó vẫn áp dụng nguyên vẹn.

---

## 1. Phạm vi

Chặn nút "Rời khỏi cuộc gọi" của Meet khi tab đang được ghi hình, hỏi xác nhận trước khi thực sự kết thúc cuộc gọi.

**Ngoài phạm vi:**
- Gọi LMS API thật để force-end lớp — chỉ để lại comment `TODO` tại đúng chỗ gọi, không implement.
- Chặn các cách rời cuộc gọi khác (đóng tab, phím tắt, đóng cửa sổ trình duyệt) — các luồng đó đã có `watchCallEnded` / `tabs.onRemoved` xử lý theo `2026-08-29-recorder-ui-and-auto-stop-design.md`, không đổi.
- Đa ngôn ngữ đầy đủ cho UI Meet — chỉ cần fallback hợp lý cho vi/en, không cam kết mọi locale Google hỗ trợ.

---

## 2. Vấn đề

Giáo viên bấm "Rời khỏi cuộc gọi" trong lúc đang ghi hình lớp học → Meet rời phòng ngay lập tức, không có bước xác nhận nào nhắc rằng buổi ghi đang chạy. Giáo viên có thể bấm nhầm hoặc chưa sẵn sàng kết thúc, làm mất phần còn lại của buổi học.

---

## 3. Thiết kế

### 3.1 Nhận diện nút "Rời khỏi cuộc gọi"

Google không có API chính thức cho nút này; DOM/aria-label có thể đổi giữa các bản deploy hoặc theo locale (vd. `aria-label="Rời khỏi cuộc gọi"` vs `"Leave call"`). Để không phụ thuộc một attribute duy nhất, nhận diện bằng 4 tín hiệu độc lập, coi là đúng nút khi khớp **≥ 2/4**:

1. Icon Material Symbols có glyph `call_end` (ligature text bên trong `<i class="google-symbols">`) — bền nhất qua locale vì đây là tên icon nội bộ, không dịch.
2. `jsname="CQylAd"` trên `<button>`.
3. `<button>` nằm trong container `.NHaLPe[data-should-confirm-hangup]`.
4. `aria-label` khớp một trong danh sách từ khoá: vi `"rời cuộc gọi"`, `"rời khỏi cuộc gọi"`; en `"leave call"`, `"leave meeting"` (so khớp không phân biệt hoa/thường, dạng "chứa chuỗi").

Nếu Google đổi 1 trong 4 (vd. đổi `jsname` giữa các lần deploy), 3 tín hiệu còn lại vẫn đủ nhận diện đúng nút. Nếu không tìm được nút nào đạt ngưỡng → tính năng no-op, nút Leave hoạt động bình thường như chưa cài extension (an toàn, không chặn nhầm/chặn hụt gây kẹt UI).

### 3.2 Chặn click và hỏi xác nhận

Trong `entrypoints/content.ts`, thêm `watchLeaveButton(onLeaveClick)` — cùng kiểu với `watchMicMuteButton`/`watchCallEnded` đã có: `MutationObserver` trên `document.body` (`subtree` + `childList`), mỗi lần DOM đổi thì tìm lại nút (3.1) và gắn listener `click` lên **chính nút đó**, ở **capture phase**. Meet vẽ lại thanh điều khiển trong lúc chạy, nên nút có thể xuất hiện muộn hoặc bị thay bằng node mới — watcher gỡ listener khỏi node cũ và gắn sang node mới.

Không dùng listener `click` trên toàn `document`: watcher bám node đúng như hai watcher sẵn có, và không phải xét mọi cú click trong trang.

Listener nằm trên nút và ở capture phase nên chạy trước jsaction của Meet (đăng ký ở tổ tiên, bubble phase). `onLeaveClick` trả về `true` → `preventDefault()` + `stopImmediatePropagation()`, Meet không bao giờ thấy cú click; trả về `false` → thả cho Meet xử lý bình thường.

`onLeaveClick` trả `false` (không chặn) khi: tab không đang ghi (biến `activeSession` trong content.ts, cập nhật qua message `RECORDING_ACTIVE` đã có sẵn — chỉ thêm chỗ lưu `startedAtMs`, không thêm message mới), hoặc cú click này do chính lời "Xác nhận" phát ra (cờ `suppressNextLeaveClick`).

Khi chặn: `preventDefault()` + `stopImmediatePropagation()`, mở dialog xác nhận (3.3).

### 3.3 Dialog xác nhận

Component shadow-DOM riêng (cùng pattern với `StatusPill`: `attachShadow({mode:"closed"})`, style scoped, `z-index: 2147483647`), overlay phủ toàn màn hình, card giữa màn hình:

```
Lớp học đang ghi hình <N> phút
Bạn có chắc muốn kết thúc lớp học ngay lúc này không?

[ Huỷ ]   [ Xác nhận ]
```

`N = Math.floor(elapsedMs / 60000)` với `elapsedMs = Date.now() - activeSession.startedAtMs`.

- **Huỷ** (hoặc click ra ngoài card): đóng dialog, không làm gì thêm — coi như chưa từng bấm Leave.
- **Xác nhận**:
  1. Thêm comment `// TODO: call LMS api để force end lớp` đúng tại điểm xử lý (code, không phải UI).
  2. Đóng dialog.
  3. Bật cờ tạm `suppressNextLeaveClick`, gọi `button.click()` — click giả lập này đi qua đúng listener ở 3.2 nhưng bị thả (cờ đang bật, reset ngay sau đó), nên lần này Meet nhận được click bình thường và tự xử lý rời cuộc gọi.

Không cần message mới tới background: `watchCallEnded` (đã có, phát hiện màn hình hậu-cuộc-gọi qua `data-call-ended`) sẽ tự gửi `MEETING_LEFT` và dừng ghi như luồng hiện tại — dialog chỉ chặn/trễ cú click gốc, không thay đổi cách phiên ghi kết thúc.

### 3.4 Vị trí code

Gộp cả hai phần (nhận diện nút + dialog) vào **một file**: `src/content-logic/detect-leave-action.ts`.

- `findLeaveButton(root: ParentNode): HTMLButtonElement | null` — logic 3.1.
- `class LeaveConfirmDialog` — `show(elapsedMs: number): Promise<boolean>` (resolve `true` = Xác nhận, `false` = Huỷ), `unmount()`. Logic 3.3.

`entrypoints/content.ts` chỉ wire: giữ `activeSession`, đăng ký listener capture-phase, gọi `findLeaveButton`/`LeaveConfirmDialog` từ file trên, xử lý cờ `suppressNextLeaveClick`.

---

## 4. Testing

Unit test `src/content-logic/test/detect-leave-action.test.ts` (mirror pattern `status-pill.test.ts`, jsdom):

- `findLeaveButton`: fixture HTML đúng snippet Google đưa (khớp cả 4 tín hiệu) → tìm thấy; fixture chỉ khớp 1/4 tín hiệu → trả `null`; fixture aria-label tiếng Anh (`"Leave call"`) khớp icon → vẫn tìm thấy.
- `LeaveConfirmDialog`: `show()` render đúng số phút từ `elapsedMs`; click "Xác nhận" → promise resolve `true`; click "Huỷ" → resolve `false`; click backdrop → resolve `false`.

Wiring trong `content.ts` không test riêng (theo convention hiện tại — file này không có test).

---

## 5. Rủi ro đã biết, chấp nhận

- Đồng bộ hoá với Meet DOM luôn là "best effort" — nếu Google đổi cả 4 tín hiệu cùng lúc, tính năng im lặng mất tác dụng (không crash, không chặn nhầm nút khác nhờ ngưỡng ≥2/4 khắt khe).
- Click giả lập (`button.click()`) là *untrusted event* — hoạt động vì Meet dùng `jsaction`/`addEventListener` thường, không kiểm tra `event.isTrusted`. Nếu Google đổi hành vi này trong tương lai, cú "Xác nhận" sẽ không rời được cuộc gọi thật (rủi ro đã biết, không có cách khác từ content script).
