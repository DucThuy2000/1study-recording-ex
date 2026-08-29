# Đặc tả xây dựng: Chrome Extension ghi hình lớp học Google Meet

> Tài liệu này dùng làm brief cho đội dev hoặc coding agent.
> Đọc hết **Phần 0 (Luật tuyệt đối)** trước khi viết dòng code đầu tiên.

---

## 1. Bối cảnh và mục tiêu

### Vấn đề

Google Meet ghi hình gốc **chỉ bắt người đang nói** (active speaker) + nội dung chia sẻ màn hình. Học sinh im lặng không bao giờ xuất hiện trong video. Đây là hành vi cố ý của Google, không có setting nào đổi được.

Yêu cầu nghiệp vụ bắt buộc: **bản ghi phải có camera của cả giáo viên lẫn học sinh**, vì phụ huynh xem lại để đánh giá thái độ học tập của con.

### Giải pháp

Chrome Extension chạy trên máy giáo viên, dùng `chrome.tabCapture` ghi lại **đúng khung nhìn tab Meet** (chế độ Tiled → có đủ lưới camera), trộn thêm micro giáo viên, lưu chunk xuống OPFS, upload có giới hạn tốc độ lên server công ty.

### Phạm vi extension

```
tab Meet → capture → chunk → OPFS (theo sessionId) → upload → Node.js server (ĐÃ CÓ)
                                                                     ↓
                                                          ffmpeg merge → S3
```

**Extension KHÔNG làm:** ghép file, transcode, đụng trực tiếp S3, xử lý video. Server Node.js hiện có giữ nguyên vai trò đó.

Ngoài luồng lõi trên, extension còn một **tầng độ tin cậy** — không phải tính năng phụ, mà là những thứ mà nếu thiếu sẽ lặp lại đúng các sự cố của hệ thống cũ:

| Thành phần                 | Phân loại  | Hoãn được?              |
| -------------------------- | ---------- | ----------------------- |
| Capture → OPFS → upload    | Lõi        | Không                   |
| Xác thực với LMS           | Bảo mật    | Không                   |
| Trộn mic + giám sát mức âm | Độ tin cậy | Không (R4, R5, R6)      |
| Giới hạn tốc độ upload     | Độ tin cậy | Không (R2)              |
| Kiểm tra dung lượng        | Độ tin cậy | Không (R9, R10)         |
| Tiền kiểm mic trước lớp    | Độ tin cậy | Nên giữ                 |
| Heartbeat về LMS           | Giám sát   | Có — hoãn được sang sau |
| Phát hiện layout Tiled     | Giám sát   | Có — hoãn được sang sau |

### Ràng buộc hệ thống

| Hạng mục            | Giá trị                                                    |
| ------------------- | ---------------------------------------------------------- |
| Quy mô              | ~800 giáo viên, ~500 lớp/ngày, cao điểm ~300 lớp đồng thời |
| Thiết bị giáo viên  | Máy cá nhân, cấu hình từ i3/4GB trở lên, Chrome            |
| Tài khoản giáo viên | Gmail cá nhân (KHÔNG thuộc Workspace của công ty)          |
| Mạng                | Internet gia đình Việt Nam, upload không ổn định           |
| Định dạng đầu ra    | **WebM** (VP8 + Opus) — KHÔNG cần convert MP4              |
| Nơi xem lại         | Website LMS của công ty                                    |
| Phát hành           | Chrome Web Store, chế độ **Unlisted**                      |

### Stack

- **Extension**: TypeScript, Manifest V3, build bằng Vite
- **Server**: NodeJS / NestJS (đã có sẵn)
- **Lưu trữ**: S3 (đã có sẵn)
- **Xử lý**: ffmpeg (đã có sẵn)

---

## 2. LUẬT TUYỆT ĐỐI — rút ra từ hệ thống recording cũ đã thất bại

> Hệ thống trước đây (dùng cho Tencent) đã hỏng theo đúng những cách dưới đây.
> Mỗi luật tương ứng với một sự cố có thật đã xảy ra trong production.

### R1. KHÔNG BAO GIỜ tích chunk trong RAM

Mỗi blob từ `ondataavailable` phải được ghi thẳng xuống OPFS rồi giải phóng tham chiếu. Không có mảng `recordedChunks[]` nào tồn tại quá 1 giây.
_Sự cố cũ: chiếm RAM client, máy yếu bị đơ._

### R2. KHÔNG BAO GIỜ upload không giới hạn tốc độ trong lúc lớp đang diễn ra

Upload phải qua token bucket. Lớp học luôn được ưu tiên băng thông hơn upload.
_Sự cố cũ: giáo viên crash, đơ màn hình, không dạy tiếp được._

### R3. KHÔNG BAO GIỜ xoá dữ liệu local trước khi server xác nhận file hoàn chỉnh đã ở trên S3

HTTP 200 của một chunk KHÔNG phải là xác nhận. Chỉ xoá sau khi endpoint `/finalize` trả về `{ ok: true, s3Key, checksum }`.

### R4. KHÔNG BAO GIỜ giả định `tabCapture` có tiếng giáo viên

Tab audio chỉ chứa tiếng **học sinh**. Micro giáo viên đi thẳng lên server Google, không vòng lại tab. Bắt buộc phải `getUserMedia({audio})` riêng và trộn.
_Sự cố cũ: hàng loạt bản ghi không có tiếng giáo viên, phát hiện sau nhiều tuần._

### R5. KHÔNG BAO GIỜ dùng micro thô

Phải bật `echoCancellation`, `noiseSuppression`, `autoGainControl` ngay trong `getUserMedia`. Khử ồn của Meet chỉ áp lên luồng gửi đi, không áp lên micro local.
_Sự cố cũ: học sinh nghe sạch nhưng bản ghi rất ồn, không nghe được giáo viên nói gì._

### R6. KHÔNG BAO GIỜ để lỗi im lặng

Mọi trạng thái bất thường (mic câm, tab audio câm, upload fail, OPFS lỗi, dung lượng thấp) phải: (a) hiện cảnh báo cho giáo viên trong tab, (b) gửi sự kiện về LMS.
_Sự cố cũ: hỏng âm thầm, chỉ phát hiện khi có người xem lại._

### R7. KHÔNG BAO GIỜ xử lý từng khung hình bằng JavaScript

Không dùng canvas để vẽ/ghép/scale. `tabCapture` trả về luồng đã ghép sẵn ở tầng native; `MediaRecorder` mã hoá bằng native. JS chỉ chạm tới dữ liệu mỗi 5 giây.

### R8. KHÔNG BAO GIỜ phụ thuộc vào việc giáo viên nhớ làm gì đó

Upload phải tự động khi mở Chrome. Không có nút "gửi bản ghi" nào mà giáo viên phải bấm.
_Sự cố cũ: giáo viên không upload → IndexedDB đầy → trình duyệt xoá chunk cũ → mất recording._

### R9. KHÔNG BAO GIỜ để tồn đọng phình vô hạn

Trần cứng 5 GB. Vượt ngưỡng → chặn nhận lớp mới (chặn ở khâu tiền kiểm, xem R12).

### R10. KHÔNG BAO GIỜ để dung lượng trống chạm vùng nguy hiểm

Có báo cáo lỗi Chromium chưa đóng: khi dung lượng còn ~0, dữ liệu OPFS bị xoá **dù đã có `unlimitedStorage`**, kèm `InvalidStateError` chỉ khắc phục bằng restart Chrome. Phải chủ động chặn trước khi tới đó (ngưỡng 3 GB).

### R11. KHÔNG BAO GIỜ hardcode codec, và KHÔNG BAO GIỜ dùng remote code

- Codec phải qua **chuỗi fallback có feature detection** (`vp9,opus` → `vp8,opus` → `webm`) và **gắn với bậc thiết bị**: VP9 cho bậc Cao/Vừa, VP8 cho bậc Thấp. VP9 nén tốt hơn 30–50% (nhẹ băng thông) nhưng tốn CPU gấp 2–3 lần. Task 0.4 phải đo cả hai trên máy yếu để chốt ranh giới.
- Manifest V3 **cấm** tải và thực thi code từ xa. Toàn bộ JS phải nằm trong package.

### R12. KHÔNG BAO GIỜ chặn hoặc làm gián đoạn lớp học đang diễn ra

Mọi cơ chế chặn chỉ được đặt ở **khâu tiền kiểm trước lớp**. Khi lớp đã bắt đầu, lỗi ghi hình chỉ được cảnh báo và ghi log — tuyệt đối không dừng lớp, không hiện modal chặn màn hình, không đòi giáo viên xử lý ngay.

### R13. KHÔNG BAO GIỜ giả định luồng video vẫn chạy khi giáo viên chuyển tab

`tabCapture` gắn với một tab cụ thể. Có bằng chứng mâu thuẫn về việc Chrome có tiếp tục vẽ khung hình cho tab ở nền hay không: nhóm chuẩn W3C nói tab đang bị capture được coi là "visible" và không bị bóp, nhưng nhà cung cấp dịch vụ ghi hình chuyên nghiệp báo cáo video đóng băng khi người dùng chuyển tab (mic thì vẫn chạy).

Bắt buộc: (a) đo thực tế ở Task 0.5, (b) luôn có cơ chế **phát hiện đóng băng khung hình** và ghi nhận mốc thời gian bị mất, (c) khuyến nghị vận hành mở lớp ở **cửa sổ Chrome riêng** thay vì tab.

Không bao giờ đặt logic quan trọng vào `setInterval` của content script — tab ở nền có thể bị bóp xuống 1 lần/phút. Dùng `timeslice` của `MediaRecorder` (native), `chrome.alarms`, và xử lý trong offscreen.

---

## 3. Kiến trúc

```
┌─ Service Worker (background.ts) ─────────────────────────┐
│  • Xác thực với LMS, quản lý token                       │
│  • chrome.tabCapture.getMediaStreamId(tabId)             │
│  • Tạo / huỷ offscreen document                          │
│  • chrome.runtime.onStartup → khôi phục upload dở dang   │
│  • chrome.alarms → heartbeat định kỳ                     │
│  (CÓ THỂ BỊ CHROME GIẾT BẤT CỨ LÚC NÀO — không giữ state)│
└──────────────────┬───────────────────────────────────────┘
                   │ chrome.runtime.sendMessage
┌──────────────────▼─ Offscreen Document (offscreen.ts) ───┐
│  SỐNG SUỐT BUỔI HỌC — nơi duy nhất chạm tới media        │
│  • getUserMedia (tab) + getUserMedia (mic)               │
│  • AudioContext trộn 2 luồng + phát lại tab audio ra loa │
│  • AnalyserNode giám sát mức âm thanh 2 luồng            │
│  • MediaRecorder(timeslice: 5000)                        │
│  • OPFS writer (append)                                  │
│  • Uploader có token bucket                              │
└──────────────────┬───────────────────────────────────────┘
                   │
┌──────────────────▼─ Content Script (content.ts) ─────────┐
│  Chạy trên meet.google.com/*                             │
│  • Đọc meetingCode từ URL                                │
│  • Badge "ĐANG GHI" + cảnh báo (không chặn thao tác)     │
│  • Phát hiện layout không phải Tiled                     │
│  • Phát hiện lớp kết thúc                                │
└──────────────────┬───────────────────────────────────────┘
                   │
        ┌──────────▼──────────┐
        │  LMS Server + S3    │
        └─────────────────────┘
```

### Manifest

```json
{
  "manifest_version": 3,
  "name": "1Study Class Recorder",
  "version": "0.1.0",
  "permissions": [
    "tabCapture",
    "offscreen",
    "storage",
    "unlimitedStorage",
    "alarms"
  ],
  "host_permissions": ["https://meet.google.com/*", "https://<lms-domain>/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    {
      "matches": ["https://meet.google.com/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "action": { "default_popup": "popup.html" }
}
```

> **Chỉ khai đúng các quyền này.** Mỗi quyền thừa sẽ bị đội duyệt Chrome Web Store chất vấn và làm chậm phát hành.

### Hợp đồng API server

```
POST /api/recordings/session          → { sessionId, uploadToken }
     body: { teacherId, meetingCode, startedAt, clientInfo }

PUT  /api/recordings/{sessionId}/chunk/{index}
     body: binary (webm chunk)
     → { ok: true, received: index }

POST /api/recordings/{sessionId}/finalize
     body: { totalChunks, durationMs, sha256 }
     → { ok: true, s3Key, checksum }     ← CHỈ SAU CÁI NÀY MỚI XOÁ LOCAL

POST /api/recordings/{sessionId}/event
     body: { type, payload, ts }
     types: MIC_SILENT | TAB_AUDIO_SILENT | LOW_DISK | BACKLOG_HIGH
            | OPFS_ERROR | UPLOAD_STALLED | QUALITY_DEGRADED | LAYOUT_WRONG

POST /api/recordings/heartbeat
     body: { teacherId, sessionId?, state, backlogBytes, chunksUploaded }

GET  /api/recordings/preflight?teacherId=
     → { allowed: bool, reason?, blockingBacklogBytes? }
```

---

## 4. Nguyên tắc thiết kế code

> Áp dụng từ Phase 0. Không có giai đoạn "code tạm rồi dọn sau".

### 4.1. State machine tường minh cho vòng đời session

Ghi hình là bài toán có trạng thái, và phần lớn bug của loại phần mềm này đến từ trạng thái ngầm định (cờ boolean rải rác, `isRecording` ở ba nơi khác nhau). Dùng một máy trạng thái duy nhất, chuyển trạng thái tường minh, mọi chuyển đổi đều được log.

```
IDLE ──preflight ok──▶ READY ──start──▶ RECORDING ──stop──▶ FINALIZING
                                            │                    │
                                       (lỗi ghi)                 ▼
                                            │              UPLOADING ──▶ DONE
                                            ▼                    │
                                        DEGRADED ────────────────┘
                                     (vẫn ghi, có cảnh báo)         └──▶ FAILED
```

- Chuyển trạng thái chỉ qua một hàm `transition(from, to, reason)` duy nhất
- Trạng thái được persist vào `chrome.storage.local` sau mỗi lần đổi (service worker có thể chết bất cứ lúc nào)
- `DEGRADED` là trạng thái quan trọng: có sự cố nhưng **vẫn ghi tiếp** (R12)

### 4.2. Các pattern áp dụng

| Pattern           | Áp dụng ở                        | Lý do                                                                  |
| ----------------- | -------------------------------- | ---------------------------------------------------------------------- |
| **Repository**    | `ChunkRepository` bọc OPFS       | Đổi sang IndexedDB sau này không phải sửa nơi khác; mock được khi test |
| **Strategy**      | `QualityTier` (Low/Mid/High)     | Thêm bậc mới hoặc đổi codec không đụng vào recorder                    |
| **State machine** | `SessionStateMachine`            | Xem 4.1                                                                |
| **EventBus**      | Giao tiếp nội bộ trong offscreen | Giám sát âm thanh, uploader, recorder không gọi thẳng nhau             |
| **Adapter**       | `ChromeApi` bọc `chrome.*`       | Test được bằng Vitest không cần Chrome thật                            |
| **Result type**   | Mọi thao tác I/O                 | Lỗi dự đoán được thì trả `Result<T, E>`, không `throw`                 |

### 4.3. Hợp đồng message có kiểu

Ba context (service worker / offscreen / content script) chỉ nói chuyện qua discriminated union, khai một chỗ duy nhất:

```ts
// shared/messages.ts
export type Message =
  | {
      type: "START_RECORDING";
      streamId: string;
      sessionId: string;
      tier: TierName;
    }
  | { type: "STOP_RECORDING"; sessionId: string }
  | {
      type: "RECORDING_STATE";
      sessionId: string;
      state: SessionState;
      elapsedMs: number;
    }
  | { type: "AUDIO_ALERT"; source: "mic" | "tab"; silent: boolean }
  | {
      type: "UPLOAD_PROGRESS";
      sessionId: string;
      uploaded: number;
      total: number;
    };

export type MessageOf<T extends Message["type"]> = Extract<
  Message,
  { type: T }
>;
```

Không dùng `any`, không dùng chuỗi rời rạc. `switch` trên `type` phải exhaustive (bật `noImplicitReturns`, dùng `assertNever`).

### 4.4. Cấu trúc thư mục

```
src/
  background/        service worker: điều phối, alarms, vòng đời offscreen
  offscreen/
    recorder.ts      MediaRecorder + quản lý stream
    audio-mixer.ts   AudioContext, trộn, phát lại
    audio-monitor.ts AnalyserNode, phát hiện câm
    chunk-writer.ts  ghi OPFS
    uploader.ts      token bucket, retry, backoff
  content/           badge, cảnh báo, phát hiện layout
  popup/
  core/
    state-machine.ts
    session.ts
    result.ts
    event-bus.ts
  adapters/
    chrome-api.ts    bọc toàn bộ chrome.*
    opfs.ts
    lms-client.ts
  shared/
    messages.ts
    config.ts
    types.ts
```

### 4.5. Quy tắc bắt buộc

- TypeScript `strict: true`, cấm `any` (dùng `unknown` + type guard)
- **Constructor injection**, không singleton, không biến global — nếu một class không test được mà không cần Chrome thật thì thiết kế sai
- Mọi hằng số nằm trong `shared/config.ts`, không rải magic number
- Unit test bằng Vitest cho `core/` và các module thuần logic (token bucket, state machine, tính RMS, đánh số chunk); phần chạm `chrome.*` test thủ công theo test case của từng task
- Không `console.log` thô — dùng logger có mức độ, và **không bao giờ log nội dung media hay token**

---

## PHASE 0 — Chứng minh khả thi

**Mục tiêu:** trả lời 4 câu hỏi có/không rủi ro nhất.
**Điều kiện thoát phase:** ghi được một lớp 60 phút thật, mở file lên thấy đủ lưới học sinh, nghe rõ cả hai bên — với code đã tổ chức theo Phần 4, không phải bản nháp vứt đi.

### Task 0.1 — Khung dự án

**Việc:** Scaffold MV3 + TypeScript + Vite. Service worker log được. Content script chạy trên `meet.google.com`. Popup rỗng.

**Test:**

1. `npm run build` → thư mục `dist/`
2. `chrome://extensions` → Developer mode → Load unpacked
3. Mở `meet.google.com` → console tab hiện log của content script
4. Kiểm tra service worker log trong trang extension

**Cases:** extension load không lỗi · content script chỉ chạy trên Meet, không chạy trên tab khác · reload extension không cần restart Chrome.

**Review:** không có quyền thừa trong manifest · TS strict mode bật · không có `console.log` lộ dữ liệu nhạy cảm.

---

### Task 0.2 — tabCapture → offscreen → file local ⭐

**Việc:** Bấm icon extension → service worker lấy `streamId` → tạo offscreen document → offscreen mở stream, ghi 30 giây, tải file WebM về máy.

```ts
// background.ts
const streamId = await chrome.tabCapture.getMediaStreamId({
  targetTabId: tabId,
});
await chrome.offscreen.createDocument({
  url: "offscreen.html",
  reasons: ["USER_MEDIA"],
  justification: "Recording class session",
});
chrome.runtime.sendMessage({ type: "START", streamId });
```

```ts
// offscreen.ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
  },
  video: {
    mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
  },
} as any);
```

**Test:**

1. Vào một phòng Meet có ≥2 người, bật camera cả hai
2. Đặt layout **Tiled**
3. Ghi 30 giây → mở file

**Cases:**

- [ ] Video có đủ **lưới camera nhiều người**, không phải chỉ người đang nói ← _mục tiêu cốt lõi của cả dự án_
- [ ] Có tiếng học sinh
- [ ] **Giáo viên vẫn nghe được học sinh trong lúc ghi** (nếu không → thiếu bước nối `ctx.destination`)
- [ ] Đổi layout sang Speaker view → bản ghi đổi theo (xác nhận ghi đúng khung nhìn)

**Review:** không có mảng chunk trong RAM (R1) · không dùng canvas (R7) · offscreen được huỷ khi dừng.

---

### Task 0.3 — Trộn micro + giám sát âm thanh ⭐⭐

**Việc:** Thêm luồng mic có xử lý, trộn với tab audio, và giám sát mức âm cả hai luồng.

```ts
const micStream = await navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
});

const ctx = new AudioContext();
const dest = ctx.createMediaStreamDestination();
const tabSrc = ctx.createMediaStreamSource(tabStream);
const micSrc = ctx.createMediaStreamSource(micStream);

const tabGain = ctx.createGain();
tabGain.gain.value = 1.0;
const micGain = ctx.createGain();
micGain.gain.value = 1.0;

tabSrc.connect(tabGain).connect(dest);
micSrc.connect(micGain).connect(dest);
tabSrc.connect(ctx.destination); // BẮT BUỘC (R4/R5)

const mixed = new MediaStream([
  tabStream.getVideoTracks()[0],
  dest.stream.getAudioTracks()[0],
]);
```

Giám sát: `AnalyserNode` trên từng luồng, tính RMS mỗi 10s. Câm liên tục 60s → cảnh báo + gửi event.

**Test:**

1. Giáo viên nói, học sinh im → nghe rõ giáo viên trong bản ghi
2. Học sinh nói, giáo viên im → nghe rõ học sinh
3. Cả hai nói cùng lúc → không méo, không dội đôi
4. **Rút micro giữa chừng** → cảnh báo trong ≤70 giây
5. Bật loa ngoài thay tai nghe → kiểm tra dội âm
6. Bật quạt/điều hoà cạnh mic → so sánh có/không `noiseSuppression`

**Cases:**

- [ ] Tiếng giáo viên có trong bản ghi (R4)
- [ ] Tiếng học sinh không bị lặp hai lần
- [ ] Cảnh báo mic câm hoạt động (R6)
- [ ] Cảnh báo tab audio câm hoạt động
- [ ] AGC không bơm tiếng ồn nền lên khi im lặng

**Review:** không dùng mic thô (R5) · analyser không tạo rác mỗi vòng lặp · interval được clear khi dừng.

> **Đây là task quan trọng nhất Phase 0.** Sự cố mất tiếng giáo viên là lỗi tốn kém nhất của hệ thống cũ.

---

### Task 0.4 — Chạy bền 60 phút trên máy yếu ⭐

**Việc:** Chưa cần upload. Ghi liên tục 60 phút trên máy cấu hình thấp nhất mà giáo viên đang dùng, đo tài nguyên.

**Test:** Chrome Task Manager (Shift+Esc) + Task Manager hệ điều hành, ghi số liệu mỗi 10 phút.

**Cases:**

- [ ] Không crash sau 60 phút
- [ ] RAM offscreen **ổn định** (không tăng tuyến tính) — nếu tăng dần thì R1 đang bị vi phạm
- [ ] CPU của Chrome tăng thêm < 25% so với chỉ chạy Meet
- [ ] Chất lượng cuộc gọi Meet không giảm rõ rệt (hỏi người ở đầu kia)
- [ ] File cuối cùng mở được, không hỏng
- [ ] Thời lượng file khớp thời gian ghi thật

**Ngưỡng chấp nhận:**

| Bậc  | Điều kiện máy       | Cấu hình                  | Codec      |
| ---- | ------------------- | ------------------------- | ---------- |
| Thấp | ≤4 luồng hoặc ≤4 GB | 854×480, 12fps, 600 kbps  | VP8 + Opus |
| Vừa  | mặc định            | 1280×720, 15fps, 1.2 Mbps | VP9 + Opus |
| Cao  | ≥8 luồng và ≥8 GB   | 1280×720, 24fps, 1.8 Mbps | VP9 + Opus |

**Thí nghiệm codec (bắt buộc, chạy trong task này):** trên **cùng một máy bậc Thấp**, ghi 20 phút với VP9 rồi 20 phút với VP8, cùng độ phân giải và fps. Ghi lại:

|                                                   | VP9 | VP8 |
| ------------------------------------------------- | --- | --- |
| CPU trung bình của Chrome                         |     |     |
| Khung hình rớt                                    |     |     |
| Kích thước file                                   |     |     |
| Điểm chất lượng cuộc gọi (người đầu kia chấm 1–5) |     |     |

Kết quả quyết định ranh giới bậc trong `config.ts`. Nếu VP9 trên máy yếu làm rớt khung hình hoặc tụt chất lượng cuộc gọi, hạ bậc Vừa xuống VP8.

**Review:** chuỗi fallback `isTypeSupported` được cài đúng (R11) · codec gắn với bậc, không hardcode · bitrate khai báo tường minh · logic chọn bậc dựa trên `hardwareConcurrency` / `deviceMemory` · `QualityTier` cài theo Strategy pattern (4.2).

### Task 0.5 — Guard tab và ràng buộc quyền

**Việc:** Extension chỉ cho bắt đầu ghi khi tab đang active là phòng Meet đúng của lớp.

Ràng buộc kỹ thuật bắt buộc phải tuân theo: `tabCapture` chỉ gọi được sau khi người dùng invoke extension (bấm icon / popup / `chrome.commands`), và **chỉ target được tab đã có quyền `activeTab`**. Nghĩa là giáo viên bắt buộc phải đang đứng ở tab Meet lúc bấm — không có cách nào ra lệnh ghi một tab ở nền.

```
Bấm icon extension
   ↓ đọc URL tab active
├─ Không phải meet.google.com
│     → popup giải thích + nút mở tab lớp học (link lấy từ LMS)
├─ Là Meet, meetingCode KHÔNG khớp lớp đang lên lịch
│     → cảnh báo, yêu cầu xác nhận
└─ Khớp → hiện nút "Bắt đầu ghi"
```

Thêm `chrome.action.disable(tabId)` / `enable(tabId)` theo `chrome.tabs.onUpdated` và `onActivated` để icon xám trên tab không phải Meet.

**Cases:**

- [ ] Đang ở tab YouTube → bấm icon → không ghi được, hiện hướng dẫn rõ ràng
- [ ] Đang ở tab Meet nhưng sai mã phòng → cảnh báo trước khi ghi
- [ ] Đang ở đúng phòng → ghi bình thường
- [ ] Icon xám trên tab không phải Meet, sáng trên tab Meet
- [ ] Mở 2 tab Meet khác nhau → bám đúng tab đã bấm, không nhầm
- [ ] Đóng tab Meet rồi mở tab Meet mới trong lúc đang ghi → session cũ không bị cướp

**Review:** truyền `targetTabId` tường minh, không dựa vào "current active tab" ngầm định · guard nằm ở cả popup lẫn service worker (không tin phía UI).

---

### Task 0.6 — Hành vi khi giáo viên chuyển tab ⭐⭐ (R13)

**Việc:** Đo xem luồng video có đóng băng khi tab Meet bị đưa xuống nền không. Đây là câu hỏi có bằng chứng mâu thuẫn giữa nhóm chuẩn W3C và nhà cung cấp dịch vụ ghi hình — phải có số liệu thật.

Cài `requestVideoFrameCallback` trên một `<video>` ẩn nhận stream, đếm khung hình theo giây, ghi log timestamp.

**Test:**

1. Bắt đầu ghi ở tab Meet có ≥2 camera bật
2. Chuyển sang tab khác **2 phút**, làm việc bình thường ở đó
3. Quay lại tab Meet, ghi thêm 1 phút, dừng
4. Xem lại video + đối chiếu log đếm khung hình

**Cases:**

- [ ] Video trong 2 phút đó có đóng băng không? Ghi rõ CÓ / KHÔNG
- [ ] Tiếng học sinh (tab audio) có mất không?
- [ ] Tiếng giáo viên (mic) có tiếp tục không? (dự kiến: có)
- [ ] Lặp lại với **tab Meet nằm ở cửa sổ Chrome riêng, cửa sổ đó không được focus** ← giả thuyết mitigation chính
- [ ] Lặp lại khi **minimize toàn bộ cửa sổ Chrome**
- [ ] Lặp lại khi giáo viên đang chia sẻ màn hình
- [ ] Offscreen document, uploader, service worker có tiếp tục chạy không? (dự kiến: có, độc lập với tab)

**Kết quả quyết định thiết kế:**

| Kết quả                                                  | Hành động                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Không đóng băng ở mọi kịch bản                           | Chỉ cần cơ chế phát hiện làm lưới an toàn                                                              |
| Đóng băng khi chuyển tab, KHÔNG đóng băng ở cửa sổ riêng | **Bắt buộc quy trình: lớp học mở ở cửa sổ Chrome riêng.** Extension tự mở bằng `chrome.windows.create` |
| Đóng băng ở mọi kịch bản                                 | Vấn đề nghiêm trọng — cân nhắc `getDisplayMedia` (ghi cả màn hình) và báo cáo lại trước khi đi tiếp    |

**Bắt buộc triển khai bất kể kết quả:**

- Phát hiện đóng băng: không có khung hình mới trong 3 giây → event `VIDEO_STALLED`, ghi mốc thời gian vào metadata session
- `visibilitychange`: tab bị ẩn khi đang ghi → khi quay lại hiện thông báo _"Bạn đã rời tab lớp học X phút — đoạn đó có thể không được ghi hình"_

> Nếu có mất đoạn, ít nhất bạn **biết chính xác đoạn nào mất** thay vì phát hiện khi phụ huynh khiếu nại (R6).

---

> 🚦 **CỔNG PHASE 0:** cả 6 task xanh mới đi tiếp. Nếu 0.2 không cho ra lưới camera, **dừng toàn bộ dự án** và báo cáo lại — mọi thứ phía sau đều vô nghĩa.

---

## PHASE 1 — Lưu trữ và độ bền

**Mục tiêu:** dữ liệu không bao giờ mất, ổ đĩa không bao giờ tràn.

### Task 1.1 — OPFS writer

**Việc:** Mỗi session một thư mục OPFS. Chunk ghi nối tiếp, đánh số. Sổ metadata trong `chrome.storage.local`.

```
opfs:/sessions/{sessionId}/chunk_00001.webm
                          /chunk_00002.webm
chrome.storage.local: {
  sessions: {
    [sessionId]: { meetingCode, startedAt, totalChunks,
                   uploadedUpTo, state, bytesTotal }
  }
}
```

**Test:** ghi 10 phút → kiểm tra file trong DevTools → Application → Storage.

**Cases:**

- [ ] Số chunk khớp `totalChunks` trong sổ
- [ ] Kích thước cộng dồn khớp
- [ ] Ghi được khi có 2 session tồn tại song song
- [ ] Chunk đánh số liên tục, không nhảy cóc

**Review:** dùng `FileSystemWritableFileStream`, không đọc lại file đã ghi · handle được đóng đúng cách · sổ metadata ghi **sau** khi chunk đã nằm trên đĩa (thứ tự này quan trọng khi crash).

---

### Task 1.2 — Bảo vệ dung lượng (R9, R10)

**Việc:** Kiểm tra dung lượng trước khi ghi + trần tồn đọng.

```ts
const { quota, usage } = await navigator.storage.estimate();
const free = (quota ?? 0) - (usage ?? 0);
if (free < 3 * 1024 ** 3) → chặn ở tiền kiểm + event LOW_DISK
if (backlogBytes > 5 * 1024 ** 3) → chặn ở tiền kiểm + event BACKLOG_HIGH
```

**Test:** dùng máy ảo hoặc file rác để ép ổ gần đầy.

**Cases:**

- [ ] Còn < 3 GB → **chặn trước khi lớp bắt đầu**, hiện lý do rõ ràng
- [ ] Tồn đọng > 5 GB → chặn tương tự
- [ ] Đã đang ghi mà ổ tụt xuống dưới ngưỡng → **CHỈ cảnh báo, KHÔNG dừng ghi** (R12)
- [ ] Sự kiện gửi được về LMS

**Review:** ngưỡng là hằng số cấu hình được · thông báo cho giáo viên phải nói rõ cần làm gì.

---

### Task 1.3 — Chống lỗi OPFS

**Việc:** Bắt riêng `InvalidStateError` và kiểm tra toàn vẹn khi khởi động.

```ts
catch (e) {
  if (e.name === 'InvalidStateError') {
    sendEvent('OPFS_ERROR', { sessionId });
    showBanner('Lỗi lưu trữ — vui lòng khởi động lại Chrome sau buổi học');
    switchToMemoryBuffer();   // cứu lớp đang dạy, tối đa ~200 MB
  }
}
```

Khi khởi động: đối chiếu sổ metadata với file thật trong OPFS. Lệch → gửi event, đánh dấu session hỏng.

**Test:** khó tái hiện tự nhiên → mock lỗi bằng cách ném exception giả trong writer.

**Cases:**

- [ ] `InvalidStateError` không làm sập offscreen
- [ ] Lớp vẫn tiếp tục ghi (buffer RAM) sau khi OPFS hỏng (R12)
- [ ] Buffer RAM có trần cứng, không phình vô hạn
- [ ] Phát hiện được file thiếu so với sổ
- [ ] Session hỏng không chặn session mới

**Review:** không nuốt exception · mọi nhánh lỗi đều gửi event (R6).

---

### Task 1.4 — Phục hồi sau crash

**Việc:** `chrome.runtime.onStartup` → quét session dở dang → tiếp tục.

**Test:**

1. Ghi 5 phút → kill Chrome bằng Task Manager
2. Mở lại Chrome
3. Không cần thao tác gì

**Cases:**

- [ ] Chunk đã ghi còn nguyên
- [ ] Session được đánh dấu `INTERRUPTED`
- [ ] Tự động chuyển sang upload (sau Phase 2)
- [ ] Chunk cuối bị ghi dở → phát hiện và bỏ, không làm hỏng cả file

---

## PHASE 2 — Đường ống upload

**Mục tiêu:** upload không làm hỏng lớp học, không mất dữ liệu, tự phục hồi.

### Task 2.1 — Giao thức upload chunk

**Việc:** Dựng endpoint server + uploader client. Chưa cần giới hạn tốc độ.

**Test:** ghi 10 phút → xem chunk lên server → gọi finalize → file hoàn chỉnh trên S3.

**Cases:**

- [ ] Chunk lên **đúng thứ tự index**
- [ ] Upload lại chunk đã có → server idempotent, không nhân đôi
- [ ] `finalize` kiểm tra đủ số chunk trước khi ghép
- [ ] Thiếu chunk → finalize **thất bại**, không tạo file lỗi
- [ ] File ghép xong mở được, thời lượng đúng
- [ ] **Local chỉ bị xoá sau khi finalize trả `ok:true`** (R3)

**Review server:** ffmpeg remux `-c copy -fflags +genpts` để sửa metadata thời lượng WebM (nếu không, người xem không tua được) · chunk tạm được dọn sau khi lên S3.

---

### Task 2.2 — Giới hạn tốc độ (R2) ⭐

**Việc:** Token bucket + thích ứng theo tốc độ thật.

```
Mặc định: 900 kbps trong lúc lớp đang diễn ra
Chunk 5s upload < 3s          → tăng 10% (trần 1.5 Mbps)
Chunk 5s upload > 8s          → giảm 30%
3 lần liên tiếp > 10s         → TẠM DỪNG upload, chỉ ghi OPFS
                                 gửi event UPLOAD_STALLED
Luôn luôn: 1 request tại một thời điểm, không song song
Lỗi: backoff 2s → 4s → 8s → ... trần 60s
```

**Test:** dùng Chrome DevTools Network throttling + `tc` trên Linux để mô phỏng mạng kém.

**Cases:**

- [ ] Mạng tốt (50 Mbps): tồn đọng ~0 khi lớp kết thúc
- [ ] Mạng vừa (10 Mbps up): lớp mượt, tồn đọng < 200 MB
- [ ] **Mạng kém (2 Mbps up): chất lượng cuộc gọi Meet KHÔNG giảm** ← case quan trọng nhất
- [ ] Rút mạng 5 phút rồi cắm lại → tự tiếp tục, không mất chunk
- [ ] Server trả 500 → backoff đúng, không spam

**Cách đo case quan trọng:** người ở đầu kia chấm điểm chất lượng cuộc gọi 1–5 trong 3 kịch bản: không ghi hình / ghi hình + upload có giới hạn / ghi hình + upload không giới hạn. Chênh lệch giữa hai cái đầu phải ≤ 0.5 điểm.

---

### Task 2.3 — Sống sót sau khi đóng tab ⭐

**Việc:** Tab Meet đóng ≠ dừng upload. Offscreen thuộc về extension, không thuộc tab.

```
Content script phát hiện tab đóng / lớp kết thúc
   → offscreen: dừng MediaRecorder, chốt file
   → uploader: BỎ giới hạn tốc độ (không còn lớp cần bảo vệ)
   → badge icon hiện "↑ 45%"
   → xong → xoá local → đóng offscreen
```

Trước khi đóng tab, content script hiện thông báo: _"Còn X MB chưa tải lên, vui lòng giữ Chrome mở thêm ~Y phút."_ (thông báo, không chặn — R12)

**Test:**

1. Ghi 20 phút
2. Đóng tab Meet ngay
3. Theo dõi badge

**Cases:**

- [ ] Upload tiếp tục sau khi tab đóng
- [ ] Tốc độ bung lên full sau khi lớp kết thúc
- [ ] Badge phản ánh đúng tiến độ
- [ ] Mở tab Meet mới trong lúc đang upload → không xung đột
- [ ] Offscreen được đóng sau khi xong (không rò rỉ)

---

### Task 2.4 — Tự phục hồi khi mở lại Chrome (R8)

**Việc:** Mở Chrome → tự tiếp tục upload, giáo viên không phải bấm gì.

**Test:**

1. Ghi 20 phút → đóng tab → **tắt hẳn Chrome** khi mới upload 30%
2. Đợi 10 phút
3. Mở lại Chrome, không mở Meet

**Cases:**

- [ ] Upload tự chạy trong vòng 30 giây sau khi Chrome khởi động
- [ ] Tiếp tục từ chunk dở dang, không gửi lại từ đầu
- [ ] Nhiều session dở dang → xử lý tuần tự, cũ trước
- [ ] Token hết hạn → tự refresh, không mất dữ liệu
- [ ] **Giáo viên không phải thao tác gì**

---

## PHASE 3 — Tích hợp LMS

### Task 3.1 — Xác thực

**Việc:** Extension vô dụng nếu không có token hợp lệ. Đây là mô hình bảo mật thật — chế độ Unlisted trên store KHÔNG phải cơ chế bảo mật.

**Cases:**

- [ ] Chưa đăng nhập → không ghi được, hiện màn hình đăng nhập
- [ ] Token hết hạn giữa buổi → **vẫn ghi tiếp**, refresh ngầm (R12)
- [ ] Tài khoản bị khoá → chặn ở lần tiền kiểm tiếp theo, không cắt lớp đang chạy
- [ ] Token lưu trong `browser.storage.local`, không ở `localStorage`

---

### Task 3.2 — Heartbeat

**Việc:** `chrome.alarms` mỗi 30 giây gửi `{ teacherId, sessionId, state, backlogBytes, chunksUploaded }`.

**Cases:**

- [ ] Heartbeat đều đặn khi đang ghi
- [ ] Service worker bị Chrome giết → `chrome.alarms` vẫn đánh thức đúng hạn
- [ ] Mất mạng → xếp hàng, gửi bù khi có mạng (không cần đủ, chỉ cần cái mới nhất)
- [ ] LMS dựng được dashboard "ai đang dạy, ai đang ghi hình"

---

### Task 3.3 — Tiền kiểm trước lớp ⭐

**Việc:** Đây là **cổng chặn duy nhất** trong toàn hệ thống (R12). Chạy trước khi giáo viên vào lớp.

```
1. Extension đã cài và đăng nhập?
2. Dung lượng trống ≥ 3 GB?
3. Tồn đọng < 5 GB?
4. Micro hoạt động? → yêu cầu nói một câu, hiện thanh mức âm, phải vượt ngưỡng
5. Đang ở tab Meet đúng meetingCode?
```

**Cases:**

- [ ] Mic hỏng → phát hiện **trước** lớp, không phải sau
- [ ] Chọn nhầm thiết bị mic → hiện danh sách để đổi
- [ ] Thiếu điều kiện nào → nói rõ điều kiện đó và cách khắc phục
- [ ] Qua hết → cho phép bắt đầu

> Task này ngăn chặn phần lớn sự cố âm thanh của hệ thống cũ, chỉ tốn 15 giây mỗi buổi.

---

### Task 3.4 — Đối soát với Workspace Events

**Việc:** LMS đã nhận `conference.ended` từ Google Workspace Events API (đã kiểm chứng ở phase trước). Đối chiếu với bản ghi trên S3.

```
conference.ended  +  không có bản ghi hoàn chỉnh sau 2 giờ
   → gắn cờ lớp, thông báo trong LMS cho giáo viên
   → quá 24 giờ → cảnh báo quản lý, tính vào KPI tuân thủ
   → tồn đọng > 5 GB → chặn nhận lớp mới (qua endpoint preflight)
```

**Cases:**

- [ ] Lớp có bản ghi đủ → không cảnh báo
- [ ] Lớp thiếu bản ghi → cảnh báo đúng hạn
- [ ] Giáo viên iPad (không dùng extension) → luồng riêng, không cảnh báo nhầm
- [ ] Bản ghi lên muộn 3 giờ → cờ được gỡ tự động

---

## PHASE 4 — Giao diện và rào chắn

### Task 4.1 — Chỉ báo trong tab + đồng hồ ghi hình

**Việc:** Badge góc màn hình hiển thị trạng thái kèm thời gian đã ghi, cộng cảnh báo khi có sự cố.

```
● ĐANG GHI · 45:12          (đang dạy)
⚠ KHÔNG NGHE THẤY BẠN · 47:03   (mic câm, vẫn đang ghi)
↑ ĐANG TẢI LÊN · 62%        (lớp đã kết thúc)
```

Song song, badge trên icon extension (`chrome.action.setBadgeText`) — **tối đa 4 ký tự**: `45m`, `1h12`, `62%`.

**Cài đặt:**

- Đồng hồ tính từ `session.startedAt` **lưu trong `chrome.storage.local`**, KHÔNG phải từ lúc content script mount
- Cập nhật mỗi giây bằng một `setInterval` duy nhất, chỉ ghi vào text node (không re-render cây DOM)
- Màu theo trạng thái: đỏ = đang ghi, vàng = DEGRADED, xanh = đang tải lên

**Cases:**

- [ ] Badge hiện rõ nhưng không che nút điều khiển Meet
- [ ] **Reload tab giữa buổi → đồng hồ tiếp tục đúng, không nhảy về 0** ← lỗi hay gặp nhất ở task này
- [ ] Ghi > 60 phút → hiển thị đúng dạng `1:05:30`, icon badge thành `1h05`
- [ ] Cảnh báo mic câm hiện ra và **tự ẩn khi mic có tiếng lại**
- [ ] Trạng thái DEGRADED hiện màu vàng nhưng đồng hồ vẫn chạy
- [ ] Không bao giờ hiện modal chặn màn hình khi lớp đang diễn ra (R12)
- [ ] Meet đổi giao diện → badge không vỡ layout
- [ ] `setInterval` được clear khi lớp kết thúc (không rò rỉ)

---

### Task 4.2 — Phát hiện layout

**Việc:** Nếu giáo viên để Speaker view, bản ghi sẽ chỉ có một người — đúng vấn đề ta đang cố tránh. Content script phát hiện và nhắc.

**Cases:**

- [ ] Speaker view → hiện nhắc "Chuyển sang chế độ Tiled để ghi đủ học sinh"
- [ ] Chuyển sang Tiled → nhắc biến mất
- [ ] **Selector DOM không khớp (Google đổi giao diện) → gửi event LAYOUT_WRONG, KHÔNG chặn ghi hình**
- [ ] Trong lúc chia sẻ màn hình → không cảnh báo sai

> ⚠️ Đây là phần dễ vỡ nhất khi Google cập nhật Meet. Bắt buộc phải fail mềm và báo về LMS để đội biết mà sửa.

---

### Task 4.3 — Popup

**Việc:** Trạng thái đăng nhập, session hiện tại, tồn đọng, tiến độ upload, nút đăng xuất.

**Cases:** hiện đúng trạng thái ở mọi giai đoạn · không lộ token · mở popup không làm gián đoạn ghi hình.

---

## PHASE 5 — Kiểm thử chịu tải và phát hành

### Task 5.1 — Ma trận thiết bị

Test trên **máy thật của giáo viên**, không phải máy dev.

| Cấu hình                          | Kết quả cần đạt                      |
| --------------------------------- | ------------------------------------ |
| i3 / 4GB / HDD                    | Chạy được bậc Thấp, không crash      |
| i5 / 8GB / SSD                    | Bậc Vừa mượt                         |
| Máy có phần mềm diệt virus nặng   | Không xung đột                       |
| Màn hình ngoài / độ phân giải cao | Không vỡ layout, không phình bitrate |
| Chrome đang mở 20 tab             | Vẫn ghi ổn định                      |

---

### Task 5.2 — Kiểm thử hỗn loạn

| Kịch bản                  | Kỳ vọng                                  |
| ------------------------- | ---------------------------------------- |
| Rút mạng 10 phút giữa lớp | Ghi tiếp, upload tạm dừng rồi tiếp tục   |
| Server upload sập 30 phút | Tồn đọng tăng, không mất dữ liệu         |
| Máy sleep giữa lớp        | Phục hồi hoặc chốt file sạch, không hỏng |
| Đóng tab đột ngột         | Upload tiếp tục (Task 2.3)               |
| Ổ đầy giữa lớp            | Cảnh báo, không dừng lớp                 |
| Hai tab Meet cùng lúc     | Bám đúng tab của lớp đang dạy            |
| Lớp 3 tiếng liên tục      | Không rò rỉ RAM, file không hỏng         |

---

### Task 5.3 — Chuẩn bị phát hành

**Việc:**

- Trang **privacy policy thật** trên domain công ty (không dùng Google Docs)
- Giải trình từng quyền trong bản khai của Chrome Web Store
- Khai báo sử dụng dữ liệu + tuân thủ Limited Use
- Icon và ảnh chụp màn hình đúng kích thước
- Chọn chế độ **Unlisted**

**Điểm dễ bị hỏi khi duyệt:** quyền `tabCapture` bị soi kỹ. Mô tả phải nêu rõ một mục đích duy nhất: ghi hình buổi học cho nền tảng nội bộ của công ty. Không nhồi thêm tính năng phụ.

**Cases:**

- [ ] Không có remote code (R11)
- [ ] Mọi quyền đều có lý do chính đáng
- [ ] Privacy policy nêu rõ: ghi gì, lưu ở đâu, giữ bao lâu, ai xem được
- [ ] Đệm 1–2 tuần cho vòng duyệt đầu tiên

---

### Task 5.4 — Thí điểm

Triển khai theo bậc: **5 giáo viên → 30 → 100 → toàn bộ**. Mỗi bậc chạy tối thiểu một tuần.

**Chỉ số theo dõi:**

- Tỉ lệ lớp có bản ghi hoàn chỉnh (mục tiêu > 98%)
- Thời gian trung bình từ kết thúc lớp tới file lên S3
- Số sự kiện `MIC_SILENT` / `UPLOAD_STALLED` / `LOW_DISK`
- Điểm phản hồi của giáo viên về độ mượt của lớp
- **Kiểm tra thủ công ngẫu nhiên 10 bản ghi/tuần**: có đủ lưới học sinh không, nghe rõ cả hai bên không

---

## Phụ lục A — Việc song song, không thuộc phần code

| Hạng mục                | Ghi chú                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Pháp lý**             | Quay hình trẻ em và phân phối cho phụ huynh — cần luật sư xem trước khi launch. Tham chiếu Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân. Cần: đồng ý của phụ huynh, mục đích giới hạn, thời hạn lưu trữ, quyền yêu cầu xoá, kiểm soát ai xem được bản ghi nào |
| **Nhóm giáo viên iPad** | Quy trình riêng: tự ghi màn hình + upload qua LMS, có hạn nộp và chế tài. **Cần test trước:** ghi màn hình trên iPad có bắt được tiếng học sinh không                                                                                                              |
| **Chính sách tai nghe** | Yêu cầu giáo viên dùng tai nghe có mic — biện pháp rẻ và hiệu quả nhất cho chất lượng âm thanh                                                                                                                                                                     |
| **Đào tạo**             | Hướng dẫn cài extension, đặt layout Tiled, hiểu các cảnh báo                                                                                                                                                                                                       |
| **Dự phòng**            | Giữ recording gốc của Google Meet chạy song song. Miễn phí, và là lưới an toàn nếu extension bị Chrome Web Store gỡ hoặc lỗi diện rộng                                                                                                                             |

## Phụ lục B — Tóm tắt hằng số cấu hình

```ts
export const CONFIG = {
  CHUNK_MS: 5000,
  UPLOAD_RATE_IN_CLASS_BPS: 900_000,
  UPLOAD_RATE_MAX_BPS: 1_500_000,
  DISK_MIN_FREE_BYTES: 3 * 1024 ** 3,
  BACKLOG_MAX_BYTES: 5 * 1024 ** 3,
  SILENCE_ALERT_SECONDS: 60,
  HEARTBEAT_INTERVAL_MS: 30_000,
  MEMORY_BUFFER_MAX_BYTES: 200 * 1024 ** 2,
  AUDIO_BITRATE: 64_000,
  TIERS: {
    LOW: {
      width: 854,
      height: 480,
      fps: 12,
      bitrate: 600_000,
      codecs: ["vp8"],
    },
    MID: {
      width: 1280,
      height: 720,
      fps: 15,
      bitrate: 1_200_000,
      codecs: ["vp9", "vp8"],
    },
    HIGH: {
      width: 1280,
      height: 720,
      fps: 24,
      bitrate: 1_800_000,
      codecs: ["vp9", "vp8"],
    },
  },
};

// Chuỗi fallback có feature detection (R11)
export function pickMimeType(codecs: string[]): string {
  const candidates = [
    ...codecs.map((c) => `video/webm;codecs=${c},opus`),
    "video/webm",
  ];
  const found = candidates.find((t) => MediaRecorder.isTypeSupported(t));
  if (!found) throw new Error("Không có codec WebM nào được hỗ trợ");
  return found;
}
```

---

## Quy tắc làm việc

1. **Không chuyển task khi task hiện tại chưa xanh hết các case.**
2. **Không chuyển phase khi chưa qua cổng phase.**
3. Mỗi task kết thúc bằng một lần review code, đối chiếu với **Phần 2 (Luật tuyệt đối)**.
4. Task có dấu ⭐ là task rủi ro cao — cần review kỹ hơn và test trên máy thật, không phải máy dev.
5. Mọi sai lệch so với đặc tả này phải được ghi lại kèm lý do.
