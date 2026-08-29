# Đặc tả: Giao diện extension + tự động dừng ghi khi lớp kết thúc

> Bổ sung cho `2026-08-26-meet-recorder-extension-design.md`.
> Đọc Phần 2 (Luật tuyệt đối) của tài liệu đó trước — mọi ràng buộc ở đó vẫn áp dụng nguyên vẹn.

---

## 1. Phạm vi

Hai việc, làm trực tiếp trên extension:

1. **Sửa lỗi:** ghi hình không tự dừng khi giáo viên đóng tab Meet hoặc bấm "Kết thúc cuộc gọi".
2. **Giao diện:** thiết kế lại popup, thêm badge trạng thái + thời gian trên icon extension, thay banner cảnh báo trong tab bằng một pill trạng thái có đồng hồ. Màu chủ đạo: cam.

**Ngoài phạm vi — không đụng tới:** uploader, `lms-client`, giao thức chunk lên server, xác thực LMS, heartbeat, phát hiện layout Tiled. Các module `chunk-writer`, `session-ledger`, `storage-guard`, `event-reporter` chỉ được *đọc*, không sửa hành vi.

**Ghi chú định hướng (không triển khai ở đợt này):** khi tích hợp LMS, bản ghi sẽ được gom theo `classId` thay vì `sessionId` sinh tự động — một lớp bị ghi thành nhiều phiên sẽ được server ghép lại thành một file. Vì vậy việc dừng ghi ngay khi lớp kết thúc không gây mất mát nghiệp vụ, kể cả khi giáo viên vào lại phòng và bấm ghi lần nữa.

---

## 2. Lỗi hiện tại và nguyên nhân

### Triệu chứng

Giáo viên đóng tab Meet (hoặc bấm "Kết thúc cuộc gọi") trong lúc đang ghi. Bản ghi vẫn tiếp tục dài ra: phần video đóng băng ở khung hình cuối cùng trước khi tab đóng, phần tiếng vẫn nghe rõ giọng giáo viên nói sau giờ học.

### Nguyên nhân

`entrypoints/background.ts` không đăng ký listener nào cho vòng đời tab. Không có `tabs.onRemoved`, và `tabs.onUpdated` hiện chỉ dùng để bật/tắt icon (`refreshActionState`), không đối chiếu với session đang chạy.

Khi tab đóng:

- Video track của `tabCapture` kết thúc → `MediaRecorder` không còn khung hình mới, giữ nguyên khung cuối.
- Mic stream là một `getUserMedia` **độc lập**, không gắn với tab → vẫn thu bình thường.
- `MediaRecorder` chưa ai gọi `stop()` → tiếp tục sinh chunk.

Kết quả đúng như triệu chứng: ảnh đơ + tiếng giáo viên.

### Vì sao không lộ ra sớm hơn

Đường dừng duy nhất hiện có là popup → `STOP_RECORDING` → background → offscreen. Mọi lần test đều bấm Stop bằng tay nên đường này luôn chạy.

---

## 3. Tự động dừng ghi

### 3.1. Hai lớp phát hiện

| Lớp | Đặt ở | Sự kiện | Bắt được |
| --- | --- | --- | --- |
| 1 (chính) | background | `tabs.onRemoved` | đóng tab, đóng cửa sổ chứa tab, tab crash |
| 1 (chính) | background | `tabs.onUpdated` khi `changeInfo.url` đổi | bấm "Kết thúc cuộc gọi" (Meet điều hướng khỏi mã phòng), giáo viên tự gõ URL khác |
| 2 (lưới an toàn) | offscreen | `videoTrack.onended` | mọi trường hợp lớp 1 hụt |

Lớp 2 không thừa. Nó không phụ thuộc vào việc listener nào của service worker còn sống, và tầng media biết track chết trước khi bất kỳ sự kiện tab nào tới được background.

**Không** dùng DOM selector của Meet để phát hiện màn hình "Bạn đã rời cuộc họp". Đó đúng là loại phụ thuộc dễ vỡ mà tài liệu gốc đã cảnh báo ở Task 4.2, và nó không mang lại gì thêm so với việc theo dõi URL.

### 3.2. Module quyết định

`src/core/session-end-detector.ts` — thuần logic, không chạm `chrome.*`, test bằng Vitest:

```ts
export type SessionEndReason = "TAB_CLOSED" | "MEETING_LEFT";

export function evaluateTabRemoved(
  active: ActiveSessionInfo | null,
  closedTabId: number,
): SessionEndReason | null;

export function evaluateTabUrlChange(
  active: ActiveSessionInfo | null,
  tabId: number,
  newUrl: string | undefined,
): SessionEndReason | null;
```

`evaluateTabUrlChange` trả `"MEETING_LEFT"` khi tab khớp session đang ghi **và** mã phòng trích từ `newUrl` khác `active.meetingCode` (bao gồm cả trường hợp URL mới không phải Meet, hoặc không có mã phòng nào). Trả `null` khi URL đổi mà mã phòng giữ nguyên — Meet đổi query string trong phiên là chuyện bình thường, không được nhầm thành kết thúc lớp.

### 3.3. Thay đổi trong `ActiveSessionInfo`

Thêm một trường:

```ts
export interface ActiveSessionInfo {
  sessionId: string;
  tabId: number;
  meetingCode: string;   // MỚI
  status: ActiveSessionStatus;
  startedAtMs: number;
}
```

`handleStart` đã tính `extractMeetingCode(tab.url)` để ghi vào `sessionLedger.start()` nhưng không lưu vào active session. Giờ lưu.

Session cũ còn sót trong `chrome.storage.local` từ bản trước sẽ không có trường này. Đọc ra `meetingCode === undefined` → `evaluateTabUrlChange` trả `null` (không đủ dữ liệu để kết luận), `evaluateTabRemoved` vẫn hoạt động bình thường vì chỉ cần `tabId`.

### 3.4. Gộp đường dừng

Hiện `handleStop` vừa là handler của message `STOP_RECORDING`, vừa là toàn bộ logic dừng. Tách ra:

```
endSession(sessionId, reason)          ← đường finalize duy nhất
   ├── writeActiveSession(null)
   ├── sendToTab(tabId, RECORDING_ACTIVE false)
   ├── clearBadge()
   └── sendMessage(RECORDING_STOP, sessionId)   → offscreen
```

Ba nơi gọi vào:

- `handleStop` (popup bấm Dừng) → `endSession(id, "USER_STOPPED")`
- `tabs.onRemoved` → `endSession(id, "TAB_CLOSED")`
- `tabs.onUpdated` → `endSession(id, "MEETING_LEFT")`

Kiểu của tham số rộng hơn kết quả của detector, vì dừng bằng tay không phải một sự kiện tab:

```ts
type EndReason = SessionEndReason | "USER_STOPPED";
```

`reason` **chỉ dùng để ghi log**. Trạng thái trong `sessionLedger` vẫn do đường `FINALIZING` sẵn có ghi (`setStatus(id, "STOPPED")`), không đổi. Không thêm event type nào gửi lên LMS — ngoài phạm vi.

### 3.5. Lớp 2 — offscreen tự dừng

Trong `startRecording`, sau khi mở `activeTabStream`:

```ts
activeTabStream.getVideoTracks()[0].addEventListener("ended", () => {
  run(stopRecording({ type: "RECORDING_STOP", sessionId }), "track ended stop");
});
```

Dùng lại đúng `stopRecording` sẵn có — cùng đường finalize, cùng `releaseSessionHandles()`, cùng `window.close()`. `stopRecording` đã idempotent: gọi lần hai với session đã dọn sẽ rơi vào nhánh "unknown session" và thoát.

### 3.6. Đồng bộ ngược về background

Khi lớp 2 kích hoạt, offscreen dừng trước và background chưa biết. Offscreen báo `RECORDING_STATE` với `state: "FINALIZING"` như bình thường, nhưng `handleRecordingState` hiện **không** giải phóng `activeSession` ở nhánh `FINALIZING` — nó giả định `handleStop` đã dọn trước. Giả định đó không còn đúng.

Sửa: nhánh `FINALIZING` giải phóng `activeSession` nếu `sessionId` khớp phiên đang giữ, đồng thời gửi `RECORDING_ACTIVE false` về tab (nếu tab còn) và xoá badge. Khi `endSession` đã dọn trước thì bước này là no-op.

### 3.7. Điều không đổi

Đoạn video đóng băng còn sót lại tối đa bằng độ trễ phát hiện — dưới một giây trong mọi kịch bản. Đây là giới hạn vật lý của `tabCapture`, không phải thứ có thể loại bỏ hoàn toàn: khung hình cuối cùng luôn thuộc về một `timeslice` đang mở.

---

## 4. Badge trên icon extension

Chủ sở hữu: background — nơi duy nhất giữ trạng thái session.

### Nội dung

Text tối đa 4 ký tự, là thời gian đã ghi:

| Thời gian | Text |
| --- | --- |
| < 1 phút | `0m` |
| 45 phút | `45m` |
| 65 phút | `1h05` |
| ≥ 10 giờ | `9h59` (chốt trần, lớp học không dài tới mức này) |

`src/core/badge-format.ts`:

```ts
export function formatElapsedBadge(elapsedMs: number): string;
```

Thuần, có test, không đụng `chrome.*`.

### Màu

| Trạng thái | Nền badge |
| --- | --- |
| Không có phiên | không hiện badge (text rỗng) |
| `STARTING` | `--brand`, text `0m` |
| `RECORDING` | `--brand`, text theo bảng trên |
| `DEGRADED` (mic câm / lỗi lưu trữ / video đóng băng) | `--danger` |

### Nhịp cập nhật

`chrome.alarms` chu kỳ 1 phút, **không** `setInterval`. Service worker bị Chrome giết bất cứ lúc nào; alarm đánh thức nó dậy đúng hạn, `setInterval` thì chết theo.

Thời gian tính từ `active.startedAtMs` đã persist trong `chrome.storage.local`, nên service worker chết rồi sống lại vẫn ra đúng số, không nhảy về 0.

Alarm được tạo khi vào `RECORDING`, xoá trong `endSession`. Quyền `alarms` đã có trong manifest.

Badge cũng được cập nhật ngay (không đợi alarm) tại các mốc: bắt đầu ghi, chuyển DEGRADED, dừng.

---

## 5. Pill trạng thái trong tab Meet

Thay thế banner đỏ hiện tại. Gộp đồng hồ và cảnh báo vào **một** component — bớt một bề mặt, bớt một chỗ vỡ khi Meet đổi giao diện.

### Hình dáng

```
Bình thường:                    Có sự cố:
┌────────────────────────┐      ┌────────────────────────┐
│ ● ĐANG GHI    45:12    │      │ ● ĐANG GHI    47:03    │
└────────────────────────┘      │ ⚠ Không nghe thấy bạn  │
   viền/chấm màu cam            └────────────────────────┘
                                   viền/chấm màu đỏ
```

### Cài đặt

`src/content-logic/status-pill.ts` — một class với API hẹp:

```ts
export class StatusPill {
  mount(startedAtMs: number): void;
  setWarning(text: string | null): void;
  unmount(): void;
}
```

`entrypoints/content.ts` sau thay đổi chỉ còn làm hai việc: theo dõi nút mute của Meet, và định tuyến message vào pill. Toàn bộ DOM chuyển sang `status-pill.ts`.

**Shadow DOM.** Pill dựng trong một shadow root đóng, style nằm trong đó. CSS của Meet không chọc vào được — khác với div inline-style hiện tại, vốn vẫn có thể bị quy tắc `!important` của Meet đè.

**Vị trí: góc dưới-trái.** Thanh điều khiển của Meet nằm dưới-giữa, thông tin cuộc họp nằm trên. Vị trí trên-giữa hiện tại đụng vào vùng Meet dùng.

**Đồng hồ.** Một `setInterval` 1 giây duy nhất, chỉ ghi vào text node, không dựng lại cây DOM. `startedAtMs` xin từ background khi mount qua `GET_RECORDING_STATE` — nên **reload tab giữa buổi thì đồng hồ chạy tiếp đúng, không về 0**. `unmount()` clear interval.

`RecordingStateResponse` đã trả `session` chứa `startedAtMs`, không cần thêm message mới.

**Không bao giờ chặn.** Không modal, không overlay che thao tác, `pointer-events: none` trên pill (R12).

### Ánh xạ cảnh báo

Các message hiện có giữ nguyên, chỉ đổi nơi hiển thị:

| Message | Nội dung dòng cảnh báo |
| --- | --- |
| `AUDIO_ALERT` mic silent | Không nghe thấy bạn — kiểm tra micro |
| `AUDIO_ALERT` tab silent | Không nghe thấy học sinh — kiểm tra âm thanh tab |
| `VIDEO_STALLED` | Hình ảnh có thể đang bị đóng băng |
| `STORAGE_ALERT` `LOW_DISK` | Ổ đĩa sắp đầy |
| `STORAGE_ALERT` `BACKLOG_HIGH` | Dữ liệu cũ tồn đọng quá nhiều |
| `STORAGE_ALERT` `OPFS_ERROR` | Lỗi lưu trữ — đang ghi vào bộ nhớ tạm |

Cảnh báo tự biến mất khi tình trạng hết (`silent: false`, `VIDEO_RECOVERED`, `low: false`) — hành vi này đã có, giữ nguyên.

Thông báo "Bạn đã rời tab lớp học X phút" hiện tại: **bỏ**. Rời tab quá lâu giờ thường đồng nghĩa với kết thúc lớp, và trường hợp đó đã dừng ghi. Sự kiện `visibilitychange` không còn dùng.

---

## 6. Popup

Rộng 360px. Ba khối theo trạng thái.

```
CHƯA GHI — tab hợp lệ          ĐANG GHI
┌──────────────────────┐       ┌────────────────────────────┐
│ 1Study Recorder      │       │ 1Study Recorder  ● ĐANG GHI│
│                      │       │                            │
│ Phòng  abc-defg-hij  │       │         45:12              │
│                      │       │ Phòng  abc-defg-hij        │
│ ┌──────────────────┐ │       │                            │
│ │  Bắt đầu ghi     │ │       │ Bạn       ▮▮▮▮▮▯▯▯▯▯       │
│ └──────────────────┘ │       │ Học sinh  ▮▮▯▯▯▯▯▯▯▯       │
└──────────────────────┘       │                            │
                               │ ┌────────────────────────┐ │
CHƯA GHI — tab không hợp lệ    │ │  Dừng ghi              │ │
┌──────────────────────┐       │ └────────────────────────┘ │
│ 1Study Recorder      │       └────────────────────────────┘
│                      │
│ Mở tab Google Meet   │
│ của lớp rồi bấm lại  │
│                      │
│ [ Bắt đầu ghi ] mờ   │
└──────────────────────┘
```

Trạng thái `STARTING` và `STOPPING` giữ nguyên như hiện tại (nút khoá, chữ "Đang bắt đầu…" / "Đang dừng…"). Lỗi và guard message hiện dưới cùng, không đổi logic — chỉ đổi cách trình bày.

### Thanh mức âm

Đây là thứ trực tiếp chống lại sự cố tốn kém nhất của hệ thống cũ: mất tiếng giáo viên, phát hiện sau nhiều tuần (R4, R5). Giáo viên nhìn thanh chạy là biết máy đang nghe được mình.

Cài đặt:

- `AudioLevelMonitor` thêm callback tuỳ chọn `onLevel(rms)`, lấy mẫu mỗi `CONFIG.LEVEL_SAMPLE_MS` (250ms) **dùng lại đúng `AnalyserNode` đã tạo**. Không thêm node, không thêm AudioContext. Logic phát hiện câm giữ nguyên nhịp 10 giây, không đụng tới.
- Offscreen giữ `lastMicLevel` / `lastTabLevel`, một timer 250ms phát một message gộp:

```ts
| { type: 'AUDIO_LEVEL'; mic: number; tab: number }
```

- Popup đóng → không ai nhận → `notify()` đã nuốt lỗi sẵn. 4 message/giây là không đáng kể.
- Timer này tạo trong `startRecording`, clear trong `releaseSessionHandles()`.
- `src/core/rms.ts` thêm `levelToPercent(rms): number` (0–100), thuần, có test. RMS giọng nói thực tế nằm khoảng 0.01–0.25; hàm ánh xạ phi tuyến để thanh có phản ứng nhìn thấy được ở mức nói bình thường thay vì dính đáy.

Content script **không** nhận `AUDIO_LEVEL` — pill chỉ hiện cảnh báo câm, không hiện mức âm.

---

## 7. Hệ màu

| Token | Giá trị | Dùng cho |
| --- | --- | --- |
| `--brand` | `#F97316` | nút chính, badge đang ghi, chấm pill |
| `--brand-dark` | `#EA580C` | hover / nhấn |
| `--danger` | `#DC2626` | DEGRADED, nút Dừng, dòng cảnh báo |
| `--ok` | `#16A34A` | dòng "Đã lưu bản ghi" trong popup sau khi chốt file |
| `--ink` | `#1F2937` | chữ chính |
| `--muted` | `#6B7280` | chữ phụ |
| `--surface` | `#FFFFFF` | nền |
| `--line` | `#E5E7EB` | đường kẻ |

**Không dùng vàng.** Vàng quá gần cam, giáo viên liếc qua không phân biệt được trạng thái bình thường với trạng thái có sự cố. Quy ước: cam = đang chạy đúng, đỏ = có vấn đề.

Tất cả nằm trong `src/shared/theme.css`, popup import trực tiếp. Pill trong shadow DOM nhân bản đúng bộ giá trị này dưới dạng chuỗi style — shadow root không kế thừa stylesheet của trang.

Mã cam `#F97316` là giá trị khởi điểm. Nếu công ty có mã thương hiệu chính thức, đổi đúng một dòng trong `theme.css` và một hằng số trong pill.

---

## 8. Danh sách file

### Mới

| File | Vai trò |
| --- | --- |
| `src/core/session-end-detector.ts` | quyết định sự kiện tab nào kết thúc phiên |
| `src/core/badge-format.ts` | định dạng thời gian ≤ 4 ký tự |
| `src/content-logic/status-pill.ts` | pill trạng thái trong tab |
| `src/shared/theme.css` | token màu |
| `src/core/test/session-end-detector.test.ts` | |
| `src/core/test/badge-format.test.ts` | |

### Sửa

| File | Thay đổi |
| --- | --- |
| `entrypoints/background.ts` | `tabs.onRemoved`, đối chiếu URL trong `tabs.onUpdated`, tách `endSession`, quản lý badge + alarm, giải phóng session ở nhánh `FINALIZING` |
| `entrypoints/offscreen/main.ts` | listener `videoTrack.onended`, timer phát `AUDIO_LEVEL` |
| `src/offscreen-logic/audio-monitor.ts` | callback `onLevel` |
| `src/core/rms.ts` | `levelToPercent` |
| `src/shared/messages.ts` | `AUDIO_LEVEL`, `meetingCode` trong `ActiveSessionInfo` |
| `entrypoints/content.ts` | dùng `StatusPill`, bỏ DOM banner và `visibilitychange` |
| `entrypoints/popup/index.html` | cấu trúc mới |
| `entrypoints/popup/main.ts` | render theo trạng thái, nhận `AUDIO_LEVEL` |
| `src/shared/config.ts` | `LEVEL_SAMPLE_MS`, `BADGE_UPDATE_ALARM_MINUTES` |

### Không đụng

`uploader`, `lms-client`, `chunk-writer`, `session-ledger`, `storage-guard`, `event-reporter`, `state-machine`, `frame-monitor`, `device-tier`, `tab-guard`, `entrypoints/permission/`.

---

## 9. Kiểm thử

### Vitest

- `session-end-detector`: tab khác không kích hoạt · tab khớp + đóng → `TAB_CLOSED` · URL đổi cùng mã phòng → `null` · URL đổi khác mã phòng → `MEETING_LEFT` · URL rời khỏi Meet → `MEETING_LEFT` · `active === null` → `null` · `meetingCode` thiếu (session cũ) → `null` cho URL, vẫn `TAB_CLOSED` cho đóng tab
- `badge-format`: 0 → `0m` · 45 phút → `45m` · 65 phút → `1h05` · 10 giờ → `9h59` · mọi kết quả ≤ 4 ký tự
- `levelToPercent`: 0 → 0 · trên trần → 100 · đơn điệu tăng · giá trị giọng nói bình thường cho ra phần trăm nhìn thấy được (> 15)

### Thủ công

| Kịch bản | Kỳ vọng |
| --- | --- |
| Ghi 2 phút, đóng tab Meet | File chốt ngay, không có đuôi ảnh đơ, không có tiếng giáo viên sau khi đóng |
| Ghi 2 phút, bấm "Kết thúc cuộc gọi", để tab mở | Như trên |
| Ghi 2 phút, đóng cả cửa sổ Chrome chứa tab | Như trên |
| Mở 2 tab Meet, ghi tab A, đóng tab B | Ghi tiếp bình thường |
| Đang ghi, reload tab Meet | Đồng hồ pill chạy tiếp đúng, không về 0 |
| Ghi > 60 phút | Badge hiện `1h05`, pill hiện `1:05:30` |
| Rút micro giữa buổi | Pill đổi đỏ + dòng cảnh báo, badge đổi đỏ, cắm lại thì tự hết |
| Mở popup trong lúc ghi | Hai thanh mức âm chạy, nói vào mic thấy thanh "Bạn" nhảy |
| Mở popup ở tab YouTube | Nút Bắt đầu mờ, hiện hướng dẫn |
| Đóng popup rồi mở lại giữa buổi | Đồng hồ và mức âm hiện đúng ngay |

### Đối chiếu luật tuyệt đối

- **R6** — không lỗi im lặng: mọi cảnh báo cũ vẫn hiện, chỉ đổi chỗ hiển thị. Auto-stop được ghi log kèm `reason`.
- **R12** — không chặn lớp: pill `pointer-events: none`, không modal. Auto-stop chỉ kích hoạt khi lớp **đã** kết thúc.
- **R13** — không đặt logic quan trọng vào `setInterval` của content script: đồng hồ pill chỉ vẽ chữ; mọi quyết định nằm ở background (`chrome.alarms`) và offscreen.
