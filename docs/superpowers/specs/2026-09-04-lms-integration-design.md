# Đặc tả thiết kế: Tích hợp LMS APIs vào 1Study Recording Extension

> Ngày tạo: 2026-09-04  
> Tài liệu liên quan: `2026-08-26-meet-recorder-extension-design.md`, `2026-08-29-recorder-ui-and-auto-stop-design.md`, `2026-09-03-leave-call-confirm-design.md`.

---

## 1. Mục tiêu & Phạm vi

Tích hợp 2 API cốt lõi từ hệ thống 1Study LMS (`local/onestudy/meet`):
1. `meet/context.php`:
   - Xác thực phòng Google Meet có thuộc lớp học hợp lệ do giáo viên phụ trách hay không.
   - Làm cổng bảo vệ (Guard) thay thế hoàn toàn cho `tab-guard.ts` cũ trước khi cho phép bấm ghi hình.
   - Cung cấp tên lớp học và danh sách tài liệu giảng dạy (`materials`) để hiển thị trực tiếp trên giao diện Popup.
   - Cung cấp token ghi hình (được giữ trong bộ nhớ khi phiên ghi bắt đầu, phục vụ phase tải lên recording sau này).
2. `meet/end_class.php`:
   - Hỗ trợ giáo viên kết thúc lớp học khi bấm nút "Rời khỏi cuộc gọi" trên Google Meet.
   - Kích hoạt đóng phòng học cho toàn bộ người tham gia (thông qua Google Meet API `endActiveConference` phía LMS) và chốt bản ghi hình.

### Ngoài phạm vi (Out of Scope):
- Tải các chunks video lên Recording Server (sẽ thực hiện ở phase sau bằng `recording.token`).
- Thay thế `sessionId` (UUID ngẫu nhiên) bằng `classId` trong việc quản lý video chunks ở offscreen.

---

## 2. Nguyên tắc & Ràng buộc cốt lõi

1. **Background làm Single Source of Truth (SOT):**
   - Chỉ `entrypoints/background.ts` khởi tạo `LmsAdapter` và thực thi các cuộc gọi mạng sang LMS.
   - Content Script và Popup tương tác với LMS gián tiếp thông qua Background bằng message.
   - Giải quyết triệt để vấn đề CORS do `MeetCors.php` chỉ whitelist extension origin (`chrome-extension://*`), không whitelist `https://meet.google.com`.
2. **Quy tắc bảo mật (Security Rule):**
   - **Tuyệt đối KHÔNG lưu trữ thông tin nhạy cảm** (`token`, `sesskey`) vào `chrome.storage.local`.
   - Dữ liệu cache trong storage chỉ chứa các trường thông tin hiển thị và kiểm tra lịch học: `meetingCode`, `classroomId`, `className`, `scheduledStart`, `scheduledEnd`, `classroomStatus`, `materials`, `cachedAtMs`.
3. **Quy tắc kiểm tra khung giờ học (Schedule Window):**
   - Phiên học hợp lệ khi thời gian hiện tại nằm trong khoảng:
     $$\text{scheduledStart} - 10\text{ phút} \le \text{now} \le \text{scheduledEnd} + 30\text{ phút}$$
   - Lần đầu mở popup trên tab Meet: Kiểm tra và lưu cache vào `storage.local`.
   - Các lần mở popup tiếp theo: Tái sử dụng cache nếu trùng `meetingCode` và vẫn trong khung giờ cho phép. Chỉ gọi lại LMS khi đổi mã phòng hoặc quá khung giờ.
4. **Xoá cache khi kết thúc lớp học:**
   - Khi giáo viên chủ động bấm "Xác nhận kết thúc lớp" trên modal, cache LMS trong `storage.local` sẽ bị xoá để chuẩn bị cho buổi học tiếp theo.
   - Việc đóng tab hoặc tắt trình duyệt không làm mất cache.
5. **Best-effort End Class với Timeout Fallback:**
   - Khi bấm kết thúc, giao diện modal hiển thị trạng thái "Đang kết thúc..." và chờ tối đa 2.5 giây.
   - Nếu LMS thành công: Mọi người bị đá khỏi phòng → Meet hiển thị màn hình kết thúc → Background chốt ghi hình.
   - Nếu LMS lỗi hoặc quá 2.5 giây: Tự động fallback kích hoạt click nút rời cuộc gọi mặc định của Meet để giáo viên không bao giờ bị kẹt lại trong phòng.
6. **Xoá bỏ hoàn toàn `tab-guard.ts`:**
   - Không kiểm tra theo mã phòng cứng. Cổng guard duy nhất là phản hồi hợp lệ từ LMS context.

---

## 3. Kiến trúc & Cấu trúc thư mục

```
src/
├── core/
│   ├── api-service.ts              # [MỚI] HTTP client tổng quát (hỗ trợ credentials, timeout, chuẩn hoá lỗi)
│   └── test/
│       └── api-service.test.ts      # [MỚI] Unit test cho ApiService
├── adapters/
│   └── lms/                        # [MỚI] Thư mục chứa toàn bộ logic LMS
│       ├── types.ts                # [MỚI] Types: LmsMeetContextData, LmsCachedContext, LmsGuardResult...
│       ├── lms-adapter.ts          # [MỚI] Adapter gọi LMS context, end_class, quản lý cache và check giờ
│       └── test/
│           └── lms-adapter.test.ts # [MỚI] Unit test cho LmsAdapter
├── content-logic/
│   ├── detect-leave-action.ts      # [SỬA] Redesign modal theo theme chuẩn, hỗ trợ loading & timeout fallback
│   └── test/
│       └── detect-leave-action.test.ts # [SỬA] Test dialog và nhận diện nút
├── shared/
│   ├── config.ts                   # Cấu hình LMS endpoints
│   ├── messages.ts                 # [SỬA] Bổ sung GuardFailureReason, LMS_GET_CONTEXT, LMS_END_CLASS
│   └── theme.css                   # Bảng màu thương hiệu chuẩn
entrypoints/
├── background.ts                   # [SỬA] Tích hợp LmsAdapter, xử lý LMS_GET_CONTEXT, LMS_END_CLASS, guard start
├── content.ts                      # [SỬA] Wire nút xác nhận kết thúc lớp với message LMS_END_CLASS
└── popup/
    ├── index.html                  # [SỬA] Bổ sung khu vực tên lớp, danh sách tài liệu và nút đăng nhập LMS
    ├── main.ts                     # [SỬA] Tương tác background lấy context, render tài liệu, xử lý guard
    └── style.css                   # [SỬA] Style cho materials list, link button và nút đăng nhập
wxt.config.ts                       # [SỬA] Bổ sung host_permissions cho các domain LMS
```

Các file bị xoá bỏ:
- `src/adapters/lms-system.ts` (thay bằng `src/adapters/lms/lms-adapter.ts`).
- `src/core/tab-guard.ts` và `src/core/test/tab-guard.test.ts`.

---

## 4. Đặc tả chi tiết các thành phần

### 4.1 Tầng mạng: `src/core/api-service.ts`

```typescript
export interface ApiServiceOptions {
  baseUrl?: string;
  credentials?: RequestCredentials; // Mặc định 'omit'; LMS adapter dùng 'include'
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;               // Mặc định 10_000ms
}

export class ApiNetworkError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'ApiNetworkError';
  }
}

export class ApiAuthError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiAuthError';
  }
}

export class ApiHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

export class ApiService {
  constructor(private readonly options: ApiServiceOptions = {}) {}

  async get<T>(endpoint: string, params?: Record<string, string | number | boolean>): Promise<T> { ... }
  async post<T>(endpoint: string, body?: unknown): Promise<T> { ... }
}
```

### 4.2 Kiểu dữ liệu LMS: `src/adapters/lms/types.ts`

```typescript
export interface TeachingMaterialLink {
  label: string;
  url: string;
}

export interface TeachingMaterial {
  name: string;
  links: TeachingMaterialLink[];
}

export interface LmsMeetContextData {
  classroomId: number;
  className: string;
  scheduledStart: number; // unix timestamp in seconds
  scheduledEnd: number;   // unix timestamp in seconds
  classroomStatus: number;
  sesskey: string;
  recording: {
    classid: number;
    token: string;
    skipupload: boolean;
  } | null;
  materials: TeachingMaterial[];
}

/** Cache an toàn trong chrome.storage.local (không lưu token nhạy cảm) */
export interface LmsCachedContext {
  meetingCode: string;
  classroomId: number;
  className: string;
  scheduledStart: number;
  scheduledEnd: number;
  classroomStatus: number;
  materials: TeachingMaterial[];
  cachedAtMs: number;
}

export type LmsGuardResult =
  | { allowed: true; context: LmsCachedContext }
  | {
      allowed: false;
      reason:
        | "NOT_MEET_TAB"
        | "NOT_LOGGED_IN"
        | "NO_ACTIVE_CLASS"
        | "NOT_YOUR_CLASS"
        | "OUTSIDE_SCHEDULE"
        | "NETWORK_ERROR";
      detail?: string;
    };
```

### 4.3 Tầng Adapter LMS: `src/adapters/lms/lms-adapter.ts`

Lớp `LmsAdapter` nhận `store: ChromeStorageAdapter`, `apiService: ApiService`, `logger: Logger`:
- **`ensureContext(meetingCode: string): Promise<LmsGuardResult>`**:
  1. Đọc key `"lmsCachedContext"` từ `store`.
  2. Kiểm tra nếu có cache, `cache.meetingCode === meetingCode`, và:
     $$\text{cache.scheduledStart} - 600 \le \text{nowSeconds} \le \text{cache.scheduledEnd} + 1800$$
     → Trả về ngay `{ allowed: true, context: cache }`.
  3. Nếu không có cache hoặc hết hạn hoặc khác phòng: Gọi API `getMeetContext(meetingCode)`.
  4. Sau khi nhận dữ liệu từ LMS:
     - Kiểm tra khung giờ: nếu ngoài khoảng cho phép → trả về `{ allowed: false, reason: "OUTSIDE_SCHEDULE", detail: "..." }`.
     - Nếu trong khung giờ: Tạo `LmsCachedContext` (loại bỏ `token` và `sesskey`), lưu vào `store`, trả về `{ allowed: true, context }`.
  5. Nếu API gặp lỗi:
     - 403 `NO_ACTIVE_CLASS` → `{ allowed: false, reason: "NO_ACTIVE_CLASS" }`.
     - 403 `NOT_YOUR_CLASS` → `{ allowed: false, reason: "NOT_YOUR_CLASS" }`.
     - 401/403 (Auth/Login Moodle) → `{ allowed: false, reason: "NOT_LOGGED_IN" }`.
     - Mất mạng/Timeout → `{ allowed: false, reason: "NETWORK_ERROR" }`.
- **`endClass(classroomId: number): Promise<{ success: boolean; error?: string }>`**:
  - Gửi POST request tới `end_class.php` kèm `classroomid`.
  - Bắt lỗi nếu mạng/server trục trặc để đảm bảo không crash caller.
- **`clearContext(): Promise<void>`**:
  - Xoá key `"lmsCachedContext"` trong storage.
- **`getCachedContext(): Promise<LmsCachedContext | null>`**:
  - Đọc cache hiện tại.

### 4.4 Điều phối tại Background: `entrypoints/background.ts`

1. **Khởi tạo:**
   ```typescript
   const lmsApiService = new ApiService({
     credentials: "include",
     defaultHeaders: { Accept: "application/json" },
   });
   const lmsAdapter = new LmsAdapter(store, lmsApiService, logger);
   ```
2. **Xử lý `LMS_GET_CONTEXT`:**
   - Nhận `{ meetingCode }` từ Popup.
   - Gọi `await lmsAdapter.ensureContext(message.meetingCode)`.
   - Trả kết quả `LmsGuardResult` về cho Popup qua `sendResponse`.
3. **Xử lý `START_RECORDING`:**
   - Trích xuất `meetingCode` từ tab URL.
   - Kiểm tra `await lmsAdapter.ensureContext(meetingCode)`.
   - Nếu không allowed: gọi `refuseStart(result.reason, result.detail)`.
   - Nếu allowed: tiếp tục kiểm tra dung lượng đĩa (`evaluateStorageGuard`), kiểm tra quyền micro, tạo session và gắn `classroomId` vào `activeSession`.
4. **Xử lý `LMS_END_CLASS`:**
   - Lấy `classroomId` từ `activeSession` hoặc `lmsAdapter.getCachedContext()`.
   - Nếu có `classroomId`: gọi `await lmsAdapter.endClass(classroomId)`.
   - **Xoá cache LMS:** `await lmsAdapter.clearContext()`.
   - Trả kết quả về cho Content Script.

### 4.5 Giao diện Popup: `entrypoints/popup/`

1. **HTML & CSS cấu trúc:**
   - `#class-info`: Hiển thị tên lớp học `className` khi guard thành công.
   - `#materials`: Khu vực tài liệu gồm tiêu đề "Tài liệu học", danh sách các đầu sách, mỗi đầu sách có các nút link bấm nhỏ (`target="_blank"`). Hiển thị trong cả trạng thái `IDLE` lẫn `RECORDING`. Ẩn đi nếu danh sách rỗng.
   - `#login-btn`: Nút bấm "Đăng nhập 1Study" (`btn-secondary`) hiển thị khi gặp lỗi `NOT_LOGGED_IN`, click sẽ mở trang đăng nhập LMS.
2. **Logic `main.ts`:**
   - Khi load: Gửi `LMS_GET_CONTEXT` tới Background.
   - Nếu guard pass:
     - Render tên lớp, render danh sách materials.
     - Kích hoạt nút `el.start`.
     - Ẩn `#login-btn`.
   - Nếu guard fail:
     - Disable nút `el.start`.
     - Ẩn tài liệu và tên lớp.
     - Hiển thị thông báo tiếng Việt tương ứng:
       - `NOT_LOGGED_IN`: Hiện thông báo và nút `#login-btn`.
       - `NO_ACTIVE_CLASS`: "Phòng Meet này không thuộc lớp học nào đang diễn ra trên 1Study."
       - `NOT_YOUR_CLASS`: "Bạn không phải giáo viên phụ trách lớp học này."
       - `OUTSIDE_SCHEDULE`: "Buổi học chưa bắt đầu hoặc đã kết thúc (chỉ cho phép ghi hình từ trước 10 phút đến sau 30 phút)."
       - `NETWORK_ERROR`: "Không thể kết nối đến hệ thống LMS. Vui lòng kiểm tra lại mạng."

### 4.6 Redesign Modal & Fallback: `src/content-logic/detect-leave-action.ts` & `entrypoints/content.ts`

1. **Giao diện Modal:**
   - Căn giữa màn hình, overlay tối mờ (`rgba(0, 0, 0, 0.5)`), bo góc 12px, shadow nổi.
   - Tiêu đề: "Kết thúc lớp học" (font đậm 16px).
   - Chip ghi hình: "Thời gian đã ghi: X phút" (nền nổi bật nhẹ).
   - Nội dung: "Bạn có chắc muốn kết thúc lớp học ngay lúc này không?"
   - Ghi chú: "Hệ thống sẽ kết thúc cuộc gọi cho tất cả học sinh và hoàn tất bản ghi hình."
   - Nút hành động:
     - `Huỷ`: Nền trắng viền line, hover xám nhẹ.
     - `Kết thúc lớp`: Nền đỏ nguy hiểm (`#dc2626`), chữ trắng đậm.
2. **Xử lý Timeout Fallback (2.5 giây):**
   - Khi giáo viên bấm "Kết thúc lớp":
     - Nút xác nhận chuyển sang "Đang kết thúc..." (disabled).
     - Gửi `browser.runtime.sendMessage({ type: "LMS_END_CLASS" })`.
     - Chờ tối đa 2500ms qua `Promise.race`.
     - Đóng modal.
     - Kích hoạt `suppressNextLeaveClick = true; button.click()` như fallback để đảm bảo giáo viên luôn rời phòng.

---

## 5. Kế hoạch kiểm thử (Testing Strategy)

1. **`src/core/test/api-service.test.ts`:**
   - Test GET và POST thành công với query params và json body.
   - Test xử lý timeout (`AbortController`).
   - Test chuẩn hoá lỗi: `ApiNetworkError` khi fetch reject, `ApiAuthError` khi gặp 401/403, `ApiHttpError` khi gặp 500.
   - Test cấu hình credentials (`include` vs `omit`).
2. **`src/adapters/lms/test/lms-adapter.test.ts`:**
   - Test `ensureContext` khi cache còn hạn trong `[start - 10m, end + 30m]` → trả về cache không gọi API.
   - Test `ensureContext` khi đổi `meetingCode` → gọi API mới.
   - Test `ensureContext` khi ngoài khung giờ → từ chối `OUTSIDE_SCHEDULE`.
   - Test `ensureContext` lọc bỏ `token` và `sesskey` trước khi lưu vào storage.
   - Test xử lý các mã lỗi LMS: `NO_ACTIVE_CLASS`, `NOT_YOUR_CLASS`, `NOT_LOGGED_IN`.
   - Test `clearContext` xoá cache khỏi storage.
3. **`src/content-logic/test/detect-leave-action.test.ts`:**
   - Test nhận diện nút Rời cuộc gọi (4 tiêu chí, khớp >= 2).
   - Test render modal (tiêu đề, số phút, nội dung cảnh báo).
   - Test các tương tác nút: Huỷ, click overlay, Xác nhận.
4. **Kiểm thử hồi quy toàn bộ hệ thống:**
   - Chạy `npm test` đảm bảo 100% test suite vượt qua.
