# Đặc tả: Giao diện extension + tự động dừng ghi khi lớp kết thúc

> Bổ sung cho `2026-08-26-meet-recorder-extension-design.md`.
> Đọc Phần 2 (Luật tuyệt đối) của tài liệu đó trước — mọi ràng buộc ở đó vẫn áp dụng nguyên vẹn.

---

## 1. Phạm vi

Hai việc, làm trực tiếp trên extension:

1. **Sửa lỗi:** ghi hình không tự dừng khi giáo viên đóng tab Meet hoặc bấm "Kết thúc cuộc gọi".
2. **Giao diện:** thiết kế lại popup, thay banner cảnh báo trong tab bằng một pill trạng thái có đồng hồ. Màu chủ đạo: cam.

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

### 3.1. Ba lớp phát hiện

| Lớp | Đặt ở | Sự kiện | Bắt được |
| --- | --- | --- | --- |
| 1 | background | `tabs.onRemoved` | đóng tab, đóng cửa sổ chứa tab, tab crash |
| 2 | content script | `data-call-ended="true"` xuất hiện trong DOM | bấm "Kết thúc cuộc gọi" |
| 3 (lưới an toàn) | offscreen | `videoTrack.onended` | mọi trường hợp hai lớp trên hụt |

Ngoài ba lớp này, `tabs.onUpdated` cũng đối chiếu URL với mã phòng đang ghi — bắt trường hợp giáo viên tự gõ URL khác, và bắt cả lần Meet tự điều hướng về trang chủ sau khi rời cuộc họp.

**Lớp 2 dùng DOM selector của Meet, và điều đó là bắt buộc.** Bản đầu tiên cố tránh selector, chỉ theo dõi URL. Kiểm chứng trên Meet thật cho thấy bấm "Kết thúc cuộc gọi" **không đổi URL**: Meet giữ nguyên tab và mã phòng, chỉ vẽ đè màn hình hậu-cuộc-gọi, và mãi khoảng 60 giây sau mới tự về trang chủ. Lớp 3 cũng không cứu được ca này — tab vẫn đang bị capture, chỉ là đang quay đúng màn hình đó. Không có lớp 2 thì mỗi lần kết thúc lớp để lại một phút đuôi ảnh đơ kèm tiếng giáo viên.

Chọn `data-call-ended` chứ không phải tiêu đề "Bạn đã rời khỏi cuộc họp" (đổi theo ngôn ngữ tài khoản) hay các `jsname` quanh nó (chuỗi obfuscate, đổi theo từng bản build). Vẫn sẽ vỡ khi Google đổi giao diện, nên fail mềm giống phần phát hiện nút mute: không tìm thấy thì im lặng, ghi hình chạy tiếp đúng như trước, lớp 1 và lớp 3 không bị ảnh hưởng.

### 3.2. Module quyết định

`src/core/session-end-detector.ts` — thuần logic, không chạm `chrome.*`, test bằng Vitest:

```ts
export type SessionEndReason = "USER_STOPPED" | "TAB_CLOSED" | "MEETING_LEFT";

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
   └── sendMessage(RECORDING_STOP, sessionId)   → offscreen
```

Ba nơi gọi vào:

- `handleStop` (popup bấm Dừng) → `endSession(id, "USER_STOPPED")`
- `tabs.onRemoved` → `endSession(id, "TAB_CLOSED")`
- `tabs.onUpdated` → `endSession(id, "MEETING_LEFT")`

`SessionEndReason` gồm cả `"USER_STOPPED"` dù không hàm phát hiện nào trả về giá trị đó — nó là một lý do phiên kết thúc, và không nơi nào `switch` exhaustive trên kết quả của detector nên độ chính xác mất đi không tốn gì.

`reason` **chỉ dùng để ghi log**. Trạng thái trong `sessionLedger` vẫn do đường `FINALIZING` sẵn có ghi (`setStatus(id, "STOPPED")`), không đổi. Không thêm event type nào gửi lên LMS — ngoài phạm vi.

### 3.5. Lớp 3 — offscreen tự dừng

Trong `startRecording`, sau khi mở `activeTabStream`:

```ts
activeTabStream.getVideoTracks()[0].addEventListener("ended", () => {
  run(stopRecording({ type: "RECORDING_STOP", sessionId }), "track ended stop");
});
```

Dùng lại đúng `stopRecording` sẵn có — cùng đường finalize, cùng `releaseSessionHandles()`, cùng `window.close()`. `stopRecording` đã idempotent: gọi lần hai với session đã dọn sẽ rơi vào nhánh "unknown session" và thoát.

### 3.6. Đồng bộ ngược về background

Khi lớp 3 kích hoạt, offscreen dừng trước và background chưa biết. Offscreen báo `RECORDING_STATE` với `state: "FINALIZING"` như bình thường, nhưng `handleRecordingState` hiện **không** giải phóng `activeSession` ở nhánh `FINALIZING` — nó giả định `handleStop` đã dọn trước. Giả định đó không còn đúng.

Sửa: nhánh `FINALIZING` giải phóng `activeSession` nếu `sessionId` khớp phiên đang giữ, đồng thời gửi `RECORDING_ACTIVE false` về tab (nếu tab còn). Khi `endSession` đã dọn trước thì bước này là no-op.

### 3.7. Điều không đổi

Đoạn video đóng băng còn sót lại tối đa bằng độ trễ phát hiện — dưới một giây trong mọi kịch bản. Đây là giới hạn vật lý của `tabCapture`, không phải thứ có thể loại bỏ hoàn toàn: khung hình cuối cùng luôn thuộc về một `timeslice` đang mở.

---

## 4. Pill trạng thái trong tab Meet

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

## 5. Popup

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

## 6. Hệ màu

| Token | Giá trị | Dùng cho |
| --- | --- | --- |
| `--brand` | `#F97316` | nút chính, chấm pill |
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

## 7. Danh sách file

### Mới

| File | Vai trò |
| --- | --- |
| `src/core/session-end-detector.ts` | quyết định sự kiện tab nào kết thúc phiên |
| `src/core/time-format.ts` | định dạng đồng hồ cho popup và pill |
| `src/content-logic/status-pill.ts` | pill trạng thái trong tab |
| `src/shared/theme.css` | token màu |
| `entrypoints/popup/style.css` | style popup |
| `src/core/test/session-end-detector.test.ts` | |
| `src/core/test/time-format.test.ts` | |
| `src/content-logic/test/status-pill.test.ts` | |

### Sửa

| File | Thay đổi |
| --- | --- |
| `entrypoints/background.ts` | `tabs.onRemoved`, đối chiếu URL trong `tabs.onUpdated`, tách `endSession`, giải phóng session ở nhánh `FINALIZING` |
| `entrypoints/offscreen/main.ts` | listener `videoTrack.onended`, timer phát `AUDIO_LEVEL` |
| `src/offscreen-logic/audio-monitor.ts` | callback `onLevel` |
| `src/core/rms.ts` | `levelToPercent` |
| `src/shared/messages.ts` | `AUDIO_LEVEL`, `MEETING_LEFT`, `meetingCode` và `startedAtMs` trong `RECORDING_ACTIVE` |
| `entrypoints/content.ts` | dùng `StatusPill`, theo dõi `data-call-ended`, bỏ DOM banner và `visibilitychange` |
| `entrypoints/popup/index.html` | cấu trúc mới |
| `entrypoints/popup/main.ts` | render theo trạng thái, nhận `AUDIO_LEVEL` |
| `src/shared/config.ts` | `LEVEL_SAMPLE_MS` |

### Không đụng

`uploader`, `lms-client`, `chunk-writer`, `session-ledger`, `storage-guard`, `event-reporter`, `state-machine`, `frame-monitor`, `device-tier`, `tab-guard`, `entrypoints/permission/`.

---

## 8. Kiểm thử

### Vitest

- `session-end-detector`: tab khác không kích hoạt · tab khớp + đóng → `TAB_CLOSED` · URL đổi cùng mã phòng → `null` · URL đổi khác mã phòng → `MEETING_LEFT` · URL rời khỏi Meet → `MEETING_LEFT` · `active === null` → `null` · `meetingCode` thiếu (session cũ) → `null` cho URL, vẫn `TAB_CLOSED` cho đóng tab
- `levelToPercent`: 0 → 0 · trên trần → 100 · đơn điệu tăng · giá trị giọng nói bình thường cho ra phần trăm nhìn thấy được (> 15)
- `formatClock`: 0 → `00:00` · 45 phút 12 giây → `45:12` · 65 phút 30 giây → `1:05:30` · số âm → `00:00`
- `StatusPill` (jsdom): đồng hồ tính từ mốc bắt đầu chứ không từ lúc mount · chạy mỗi giây · cảnh báo hiện rồi tự hết · xác nhận dừng thì đóng băng đồng hồ rồi tự gỡ · phiên mới huỷ được lời xác nhận đang chờ · `pointer-events: none` · gỡ xong không để lại timer

### Thủ công

| Kịch bản | Kỳ vọng |
| --- | --- |
| Ghi 2 phút, đóng tab Meet | File chốt ngay, không có đuôi ảnh đơ, không có tiếng giáo viên sau khi đóng |
| Ghi 2 phút, bấm "Kết thúc cuộc gọi", để tab mở | Như trên |
| Ghi 2 phút, đóng cả cửa sổ Chrome chứa tab | Như trên |
| Mở 2 tab Meet, ghi tab A, đóng tab B | Ghi tiếp bình thường |
| Đang ghi, reload tab Meet | Đồng hồ pill chạy tiếp đúng, không về 0 |
| Ghi > 60 phút | Pill hiện `1:05:30`, popup hiện `1:05:30` |
| Rút micro giữa buổi | Pill đổi đỏ + dòng cảnh báo, cắm lại thì tự hết |
| Mở popup trong lúc ghi | Hai thanh mức âm chạy, nói vào mic thấy thanh "Bạn" nhảy |
| Mở popup ở tab YouTube | Nút Bắt đầu mờ, hiện hướng dẫn |
| Đóng popup rồi mở lại giữa buổi | Đồng hồ và mức âm hiện đúng ngay |

### Đối chiếu luật tuyệt đối

- **R6** — không lỗi im lặng: mọi cảnh báo cũ vẫn hiện, chỉ đổi chỗ hiển thị. Auto-stop được ghi log kèm `reason`.
- **R12** — không chặn lớp: pill `pointer-events: none`, không modal. Auto-stop chỉ kích hoạt khi lớp **đã** kết thúc.
- **R13** — không đặt logic quan trọng vào `setInterval` của content script: đồng hồ pill chỉ vẽ chữ; mọi quyết định nằm ở background và offscreen.
