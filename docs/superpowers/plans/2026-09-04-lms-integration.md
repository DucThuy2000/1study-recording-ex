# Kế hoạch triển khai: Tích hợp LMS APIs vào 1Study Recording Extension

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tích hợp 2 API LMS (`meet/context.php` và `meet/end_class.php`) vào extension làm cổng bảo vệ (Guard), hiển thị tài liệu buổi học trên popup, và kết thúc lớp học an toàn từ Google Meet.

**Architecture:** Tách tầng mạng generic `ApiService`, tầng nghiệp vụ `LmsAdapter` (quản lý gọi API và cache khung giờ học trong `storage.local` không lưu token nhạy cảm). `entrypoints/background.ts` đóng vai trò Single Source of Truth điều phối giữa Popup và Content Script.

**Tech Stack:** TypeScript, WXT (WebExtension framework), Chrome Extension MV3 (Service Worker, Storage, Tabs, Scripting), Vitest.

**Spec:** [`docs/superpowers/specs/2026-09-04-lms-integration-design.md`](file:///Users/admin/Project/extensions/1study-recording-ex/docs/superpowers/specs/2026-09-04-lms-integration-design.md)

## Global Constraints

- **Bỏ bước commit từng task:** Người dùng yêu cầu review toàn bộ code sau khi hoàn thành tất cả task trước khi tạo 1 commit duy nhất. Không commit trong từng task.
- **Bảo mật:** Tuyệt đối không lưu token ghi hình (`token`) hoặc `sesskey` vào `storage.local`.
- **Khung giờ hợp lệ:** $\text{scheduledStart} - 10\text{m} \le \text{now} \le \text{scheduledEnd} + 30\text{m}$.
- **Background SOT:** Mọi request mạng sang LMS chỉ được gọi từ Background (đảm bảo CORS origin `chrome-extension://*`).
- **Best-effort End Class:** Timeout fallback 2.5s trước khi kích hoạt native leave click.
- **Không dùng any:** Định nghĩa interface/type chặt chẽ.

---

### Task 1: Tầng mạng tổng quát `ApiService`

**Files:**
- Create: `src/core/api-service.ts`
- Create: `src/core/test/api-service.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface ApiServiceOptions {
    baseUrl?: string;
    credentials?: RequestCredentials;
    defaultHeaders?: Record<string, string>;
    timeoutMs?: number;
  }
  export class ApiNetworkError extends Error { ... }
  export class ApiAuthError extends Error { ... }
  export class ApiHttpError extends Error { ... }
  export class ApiService {
    constructor(options?: ApiServiceOptions);
    get<T>(endpoint: string, params?: Record<string, string | number | boolean>): Promise<T>;
    post<T>(endpoint: string, body?: unknown): Promise<T>;
  }
  ```

- [ ] **Step 1: Viết failing test cho `ApiService`**

Tạo file `src/core/test/api-service.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiService, ApiNetworkError, ApiAuthError, ApiHttpError } from '../api-service';

describe('ApiService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('performs GET request with query parameters', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { id: 123 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService({ baseUrl: 'https://api.example.com/' });
    const result = await api.get<{ success: boolean; data: { id: number } }>('test', { foo: 'bar', num: 42 });

    expect(result).toEqual({ success: true, data: { id: 123 } });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/test?foo=bar&num=42',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Accept: 'application/json' }),
      }),
    );
  });

  it('performs POST request with body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService({ baseUrl: 'https://api.example.com/' });
    const result = await api.post<{ success: boolean }>('submit', { name: 'test' });

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/submit',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
      }),
    );
  });

  it('throws ApiAuthError on 401 or 403', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ message: 'NOT_LOGGED_IN' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService();
    await expect(api.get('https://api.example.com/auth')).rejects.toThrow(ApiAuthError);
  });

  it('throws ApiHttpError on 500 with response body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'server broke' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService();
    await expect(api.get('https://api.example.com/fail')).rejects.toThrow(ApiHttpError);
  });

  it('throws ApiNetworkError when fetch rejects or aborts', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', mockFetch);

    const api = new ApiService();
    await expect(api.get('https://api.example.com/network-error')).rejects.toThrow(ApiNetworkError);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận test fail**

Chạy: `npx vitest run src/core/test/api-service.test.ts`
Kỳ vọng: FAIL vì chưa có file `src/core/api-service.ts`.

- [ ] **Step 3: Cài đặt `ApiService` trong `src/core/api-service.ts`**

```typescript
export interface ApiServiceOptions {
  baseUrl?: string;
  credentials?: RequestCredentials;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export class ApiNetworkError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "ApiNetworkError";
  }
}

export class ApiAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "ApiAuthError";
  }
}

export class ApiHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

export class ApiService {
  private readonly baseUrl: string;
  private readonly credentials?: RequestCredentials;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: ApiServiceOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.credentials = options.credentials;
    this.defaultHeaders = {
      Accept: "application/json",
      ...options.defaultHeaders,
    };
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async get<T>(
    endpoint: string,
    params?: Record<string, string | number | boolean>,
  ): Promise<T> {
    const url = this.buildUrl(endpoint, params);
    return this.request<T>(url, { method: "GET" });
  }

  async post<T>(endpoint: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(endpoint);
    const headers: Record<string, string> = { ...this.defaultHeaders };
    let requestBody: BodyInit | undefined;

    if (body !== undefined) {
      if (typeof body === "string" || body instanceof FormData || body instanceof URLSearchParams) {
        requestBody = body;
      } else {
        headers["Content-Type"] = "application/json";
        requestBody = JSON.stringify(body);
      }
    }

    return this.request<T>(url, {
      method: "POST",
      headers,
      body: requestBody,
    });
  }

  private buildUrl(
    endpoint: string,
    params?: Record<string, string | number | boolean>,
  ): string {
    const base = this.baseUrl
      ? this.baseUrl.endsWith("/") || endpoint.startsWith("/")
        ? `${this.baseUrl}${endpoint}`
        : `${this.baseUrl}/${endpoint}`
      : endpoint;

    if (!params || Object.keys(params).length === 0) return base;

    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        credentials: this.credentials,
        headers: {
          ...this.defaultHeaders,
          ...init.headers,
        },
        signal: controller.signal,
      });

      let responseData: unknown;
      const contentType = response.headers?.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          responseData = await response.json();
        } catch {
          responseData = null;
        }
      } else {
        try {
          responseData = await response.text();
        } catch {
          responseData = null;
        }
      }

      if (response.status === 401 || response.status === 403) {
        throw new ApiAuthError(
          response.statusText || "Authentication required",
          response.status,
          responseData,
        );
      }

      if (!response.ok) {
        throw new ApiHttpError(
          response.statusText || `HTTP Error ${response.status}`,
          response.status,
          responseData,
        );
      }

      return responseData as T;
    } catch (error) {
      if (error instanceof ApiAuthError || error instanceof ApiHttpError) {
        throw error;
      }
      throw new ApiNetworkError(
        error instanceof Error ? error.message : String(error),
        error,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
```

- [ ] **Step 4: Chạy test xác nhận test pass**

Chạy: `npx vitest run src/core/test/api-service.test.ts`
Kỳ vọng: PASS (5/5 tests).

---

### Task 2: LMS Types & `LmsAdapter` (Thư mục `src/adapters/lms/`)

**Files:**
- Create: `src/adapters/lms/types.ts`
- Create: `src/adapters/lms/lms-adapter.ts`
- Create: `src/adapters/lms/test/lms-adapter.test.ts`
- Delete: `src/adapters/lms-system.ts`

**Interfaces:**
- Consumes: `ApiService`, `ChromeStorageAdapter`, `Logger`, `CONFIG`
- Produces: `LmsAdapter`, `LmsCachedContext`, `LmsGuardResult`, `LmsMeetContextData`

- [ ] **Step 1: Tạo file `src/adapters/lms/types.ts`**

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

/** Cache an toàn trong storage.local: KHÔNG LƯU token hoặc sesskey */
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

- [ ] **Step 2: Viết test cho `LmsAdapter` trong `src/adapters/lms/test/lms-adapter.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LmsAdapter } from '../lms-adapter';
import type { ApiService } from '@/src/core/api-service';
import type { ChromeStorageAdapter } from '@/src/adapters/storage';
import type { Logger } from '@/src/core/logger';
import { ApiAuthError, ApiNetworkError } from '@/src/core/api-service';

describe('LmsAdapter', () => {
  let store: Record<string, unknown>;
  let mockStorage: ChromeStorageAdapter;
  let mockApi: ApiService;
  let mockLogger: Logger;
  let adapter: LmsAdapter;

  beforeEach(() => {
    store = {};
    mockStorage = {
      get: vi.fn(async (key: string) => store[key]),
      set: vi.fn(async (key: string, value: unknown) => {
        store[key] = value;
      }),
      delete: vi.fn(async (key: string) => {
        delete store[key];
      }),
    } as unknown as ChromeStorageAdapter;

    mockApi = {
      get: vi.fn(),
      post: vi.fn(),
    } as unknown as ApiService;

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    adapter = new LmsAdapter(mockStorage, mockApi, mockLogger);
  });

  it('returns cached context if same meetingCode and within schedule window', async () => {
    const nowSec = 1725000000;
    vi.spyOn(Date, 'now').mockReturnValue(nowSec * 1000);

    store['lmsCachedContext'] = {
      meetingCode: 'abc-defg-hij',
      classroomId: 1,
      className: 'Class 1',
      scheduledStart: nowSec - 300, // started 5 mins ago
      scheduledEnd: nowSec + 3600,
      classroomStatus: 1,
      materials: [],
      cachedAtMs: (nowSec - 300) * 1000,
    };

    const result = await adapter.ensureContext('abc-defg-hij');
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.context.classroomId).toBe(1);
    }
    expect(mockApi.get).not.toHaveBeenCalled();
  });

  it('fetches context from LMS when meetingCode differs from cache', async () => {
    const nowSec = 1725000000;
    vi.spyOn(Date, 'now').mockReturnValue(nowSec * 1000);

    vi.mocked(mockApi.get).mockResolvedValue({
      success: true,
      data: {
        classroomId: 2,
        className: 'Class 2',
        scheduledStart: nowSec - 60,
        scheduledEnd: nowSec + 3600,
        classroomStatus: 1,
        sesskey: 'secret-sesskey',
        recording: { classid: 2, token: 'super-secret-token', skipupload: false },
        materials: [{ name: 'Book 1', links: [{ label: 'Link', url: 'https://...' }] }],
      },
    });

    const result = await adapter.ensureContext('new-room-code');
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.context.classroomId).toBe(2);
      expect(result.context.className).toBe('Class 2');
    }

    // Verify token was NOT cached in storage
    const cached = store['lmsCachedContext'] as Record<string, unknown>;
    expect(cached).toBeDefined();
    expect(cached['token']).toBeUndefined();
    expect(cached['sesskey']).toBeUndefined();
    expect(cached['recording']).toBeUndefined();
  });

  it('rejects OUTSIDE_SCHEDULE when class is more than 10 mins in the future', async () => {
    const nowSec = 1725000000;
    vi.spyOn(Date, 'now').mockReturnValue(nowSec * 1000);

    vi.mocked(mockApi.get).mockResolvedValue({
      success: true,
      data: {
        classroomId: 3,
        className: 'Future Class',
        scheduledStart: nowSec + 15 * 60, // 15 mins away (> 10m)
        scheduledEnd: nowSec + 60 * 60,
        classroomStatus: 1,
        sesskey: 'key',
        recording: null,
        materials: [],
      },
    });

    const result = await adapter.ensureContext('future-room');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('OUTSIDE_SCHEDULE');
    }
  });

  it('maps 403 NO_ACTIVE_CLASS correctly', async () => {
    vi.mocked(mockApi.get).mockRejectedValue(
      new ApiAuthError('Forbidden', 403, { message: 'NO_ACTIVE_CLASS' }),
    );

    const result = await adapter.ensureContext('unknown-room');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('NO_ACTIVE_CLASS');
    }
  });

  it('maps 403 NOT_YOUR_CLASS correctly', async () => {
    vi.mocked(mockApi.get).mockRejectedValue(
      new ApiAuthError('Forbidden', 403, { message: 'NOT_YOUR_CLASS' }),
    );

    const result = await adapter.ensureContext('other-room');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('NOT_YOUR_CLASS');
    }
  });

  it('maps network errors correctly', async () => {
    vi.mocked(mockApi.get).mockRejectedValue(new ApiNetworkError('Failed to fetch'));

    const result = await adapter.ensureContext('error-room');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('NETWORK_ERROR');
    }
  });

  it('clears context from storage when clearContext is called', async () => {
    store['lmsCachedContext'] = { classroomId: 1 };
    await adapter.clearContext();
    expect(store['lmsCachedContext']).toBeUndefined();
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận fail**

Chạy: `npx vitest run src/adapters/lms/test/lms-adapter.test.ts`
Kỳ vọng: FAIL vì chưa có `LmsAdapter`.

- [ ] **Step 4: Cài đặt `src/adapters/lms/lms-adapter.ts` và xoá file cũ `src/adapters/lms-system.ts`**

Xoá `src/adapters/lms-system.ts`.
Tạo `src/adapters/lms/lms-adapter.ts`:
```typescript
import type { ChromeStorageAdapter } from "../storage";
import {
  ApiService,
  ApiAuthError,
  ApiNetworkError,
  ApiHttpError,
} from "@/src/core/api-service";
import type { Logger } from "@/src/core/logger";
import { CONFIG } from "@/src/shared/config";
import type {
  LmsMeetContextData,
  LmsCachedContext,
  LmsGuardResult,
} from "./types";

const LMS_CONTEXT_KEY = "lmsCachedContext";

interface LmsApiResponse<T> {
  success: boolean;
  message?: string;
  data: T;
}

export class LmsAdapter {
  constructor(
    private readonly store: ChromeStorageAdapter,
    private readonly api: ApiService,
    private readonly logger: Logger,
  ) {}

  async getCachedContext(): Promise<LmsCachedContext | null> {
    return (await this.store.get<LmsCachedContext>(LMS_CONTEXT_KEY)) ?? null;
  }

  async clearContext(): Promise<void> {
    await this.store.delete(LMS_CONTEXT_KEY);
    this.logger.info("cleared LMS cached context from storage");
  }

  async ensureContext(meetingCode: string): Promise<LmsGuardResult> {
    const nowSec = Math.floor(Date.now() / 1000);
    const cached = await this.getCachedContext();

    if (cached && cached.meetingCode === meetingCode) {
      const startWindow = cached.scheduledStart - 10 * 60;
      const endWindow = cached.scheduledEnd + 30 * 60;
      if (nowSec >= startWindow && nowSec <= endWindow) {
        this.logger.debug("using valid cached LMS context", {
          meetingCode,
          classroomId: cached.classroomId,
        });
        return { allowed: true, context: cached };
      }
    }

    try {
      this.logger.info("fetching meet context from LMS", { meetingCode });
      const contextData = await this.getMeetContext(meetingCode);

      const startWindow = contextData.scheduledStart - 10 * 60;
      const endWindow = contextData.scheduledEnd + 30 * 60;
      if (nowSec < startWindow || nowSec > endWindow) {
        this.logger.warn("meet class is outside schedule window", {
          meetingCode,
          scheduledStart: contextData.scheduledStart,
          scheduledEnd: contextData.scheduledEnd,
          nowSec,
        });
        return {
          allowed: false,
          reason: "OUTSIDE_SCHEDULE",
          detail: "Buổi học chưa bắt đầu hoặc đã kết thúc.",
        };
      }

      const safeContext: LmsCachedContext = {
        meetingCode,
        classroomId: contextData.classroomId,
        className: contextData.className,
        scheduledStart: contextData.scheduledStart,
        scheduledEnd: contextData.scheduledEnd,
        classroomStatus: contextData.classroomStatus,
        materials: contextData.materials ?? [],
        cachedAtMs: Date.now(),
      };

      await this.store.set(LMS_CONTEXT_KEY, safeContext);
      this.logger.info("saved safe LMS context to storage", {
        meetingCode,
        classroomId: safeContext.classroomId,
      });

      return { allowed: true, context: safeContext };
    } catch (error) {
      return this.handleLmsError(error);
    }
  }

  async getMeetContext(meetingCode: string): Promise<LmsMeetContextData> {
    const endpoint = CONFIG.LMS_API().meet_context;
    const response = await this.api.get<LmsApiResponse<LmsMeetContextData>>(
      endpoint,
      { meetingCode },
    );
    if (!response.success || !response.data) {
      throw new Error(response.message || "Failed to retrieve meet context");
    }
    return response.data;
  }

  async endClass(
    classroomId: number,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.logger.info("calling LMS end_class endpoint", { classroomId });
      const endpoint = CONFIG.LMS_API().end_class;
      const response = await this.api.post<
        LmsApiResponse<{ classroomId: number; classroomStatus: number }>
      >(endpoint, new URLSearchParams({ classroomid: String(classroomId) }));

      if (!response.success) {
        throw new Error(response.message || "Class end failed");
      }
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("LMS endClass error", { classroomId, error: message });
      return { success: false, error: message };
    }
  }

  private handleLmsError(error: unknown): LmsGuardResult {
    this.logger.error("LMS error encountered", { error: String(error) });

    if (error instanceof ApiAuthError) {
      const body = error.responseBody as { message?: string } | undefined;
      const msg = body?.message;
      if (msg === "NO_ACTIVE_CLASS") {
        return { allowed: false, reason: "NO_ACTIVE_CLASS" };
      }
      if (msg === "NOT_YOUR_CLASS") {
        return { allowed: false, reason: "NOT_YOUR_CLASS" };
      }
      return { allowed: false, reason: "NOT_LOGGED_IN" };
    }

    if (error instanceof ApiNetworkError) {
      return { allowed: false, reason: "NETWORK_ERROR" };
    }

    if (error instanceof ApiHttpError) {
      return {
        allowed: false,
        reason: "NETWORK_ERROR",
        detail: error.message,
      };
    }

    return {
      allowed: false,
      reason: "NETWORK_ERROR",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
```

- [ ] **Step 5: Chạy test xác nhận test pass**

Chạy: `npx vitest run src/adapters/lms/test/lms-adapter.test.ts`
Kỳ vọng: PASS (7/7 tests).

---

### Task 3: Cập nhật Messages, Manifest & Dọn dẹp `tab-guard.ts`

**Files:**
- Modify: `src/shared/messages.ts`
- Modify: `wxt.config.ts`
- Delete: `src/core/tab-guard.ts`

**Interfaces:**
- Produces: Mở rộng `GuardFailureReason`, bổ sung message `LMS_GET_CONTEXT` và `LMS_END_CLASS`.

- [ ] **Step 1: Xoá `src/core/tab-guard.ts`**

Xoá file `src/core/tab-guard.ts`. Kiểm tra nếu có `src/core/test/tab-guard.test.ts` thì xoá luôn.

- [ ] **Step 2: Cập nhật `src/shared/messages.ts`**

Import `LmsGuardResult` từ `@/src/adapters/lms/types`.
Cập nhật `GuardFailureReason`:
```typescript
export type GuardFailureReason =
  | "NOT_MEET_TAB"
  | "NOT_LOGGED_IN"
  | "NO_ACTIVE_CLASS"
  | "NOT_YOUR_CLASS"
  | "OUTSIDE_SCHEDULE"
  | "NETWORK_ERROR"
  | "ALREADY_RECORDING"
  | "START_FAILED"
  | "MIC_PERMISSION_DENIED"
  | "MIC_PERMISSION_NEEDED"
  | "LOW_DISK"
  | "BACKLOG_HIGH";
```
Bổ sung vào `Message`:
```typescript
  // popup → background: yêu cầu lấy LMS context và kiểm tra guard
  | { type: "LMS_GET_CONTEXT"; meetingCode: string }
  // content script → background: yêu cầu kết thúc lớp và xoá cache LMS
  | { type: "LMS_END_CLASS" }
```

- [ ] **Step 3: Cập nhật `wxt.config.ts`**

Thêm LMS origins vào `host_permissions`:
```typescript
    host_permissions: [
      'https://meet.google.com/*',
      'https://1study-lms-local.edu/*',
      'https://*.1study.vn/*',
    ],
```

---

### Task 4: Tích hợp Background Service Worker (`entrypoints/background.ts`)

**Files:**
- Modify: `entrypoints/background.ts`

- [ ] **Step 1: Khởi tạo `LmsAdapter` và thay thế guard cũ**

1. Import `ApiService`, `LmsAdapter`, `LmsGuardResult`.
2. Khởi tạo:
   ```typescript
   const lmsApiService = new ApiService({
     credentials: "include",
     defaultHeaders: { Accept: "application/json" },
   });
   const lmsAdapter = new LmsAdapter(store, lmsApiService, logger);
   ```
3. Trong `handleStart(message)`:
   - Thay thế `evaluateGuard`:
     ```typescript
     const tab = await browser.tabs.get(message.tabId);
     const meetingCode = extractMeetingCode(tab.url ?? "");
     if (!tab.url || !isMeetUrl(tab.url) || !meetingCode) {
       await refuseStart("NOT_MEET_TAB");
       return;
     }

     const lmsGuard = await lmsAdapter.ensureContext(meetingCode);
     if (!lmsGuard.allowed) {
       await refuseStart(lmsGuard.reason, lmsGuard.detail);
       return;
     }
     ```
   - Trong `writeActiveSession`: Gắn `classroomId: lmsGuard.context.classroomId`.

- [ ] **Step 2: Thêm message handler cho `LMS_GET_CONTEXT` và `LMS_END_CLASS`**

Trong `browser.runtime.onMessage.addListener`:
```typescript
        case "LMS_GET_CONTEXT":
          run(
            lmsAdapter
              .ensureContext(message.meetingCode)
              .then((result) => sendResponse(result)),
            "lms get context",
          );
          return true;
        case "LMS_END_CLASS":
          run(
            (async () => {
              const active = await readActiveSession();
              const cached = await lmsAdapter.getCachedContext();
              const classroomId = active?.classroomId ?? cached?.classroomId;
              let result = { success: true };
              if (classroomId) {
                result = await lmsAdapter.endClass(classroomId);
              }
              await lmsAdapter.clearContext();
              sendResponse(result);
            })(),
            "lms end class",
          );
          return true;
```

---

### Task 5: Cập nhật Giao diện và Logic Popup (`entrypoints/popup/`)

**Files:**
- Modify: `entrypoints/popup/index.html`
- Modify: `entrypoints/popup/style.css`
- Modify: `entrypoints/popup/main.ts`

- [ ] **Step 1: Cập nhật HTML `entrypoints/popup/index.html`**

Bổ sung hiển thị Tên lớp, Danh sách tài liệu, và Nút Đăng nhập:
```html
        <div id="class-info" class="class-info" hidden>
          <span class="class-label">Lớp học</span>
          <span id="class-name" class="class-name"></span>
        </div>

        <div id="materials" class="materials" hidden>
          <span class="materials-title">Tài liệu học</span>
          <div id="materials-list" class="materials-list"></div>
        </div>

        <button id="login-btn" class="btn btn-secondary" type="button" hidden>Đăng nhập 1Study</button>
```

- [ ] **Step 2: Cập nhật CSS `entrypoints/popup/style.css`**

Thêm styles cho `class-info`, `materials`, `btn-secondary`:
```css
.class-info {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}

.class-label {
  color: var(--muted);
  font-size: 13px;
  flex-shrink: 0;
}

.class-name {
  font-weight: 500;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.materials {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 140px;
  overflow-y: auto;
  padding: 8px;
  border-radius: 8px;
  background: #f9fafb;
  border: 1px solid var(--line);
}

.materials-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
}

.material-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.material-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.material-links {
  display: flex;
  gap: 4px;
}

.material-link {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--surface);
  border: 1px solid var(--line);
  color: var(--brand);
  text-decoration: none;
}

.material-link:hover {
  background: #fff7ed;
  border-color: var(--brand);
}

.btn-secondary {
  margin-top: 8px;
  background: var(--surface);
  color: var(--brand);
  border: 1px solid var(--brand);
}

.btn-secondary:hover:not(:disabled) {
  background: #fff7ed;
}
```

- [ ] **Step 3: Cập nhật logic trong `entrypoints/popup/main.ts`**

1. Bỏ import `evaluateGuard` từ `tab-guard.ts`.
2. Lấy tham chiếu các element mới: `classInfo`, `className`, `materials`, `materialsList`, `loginBtn`.
3. Cài đặt hàm `applyGuard()` mới:
   - Kiểm tra tab hiện tại có phải Meet URL và có `meetingCode` không.
   - Gửi `{ type: "LMS_GET_CONTEXT", meetingCode }` sang Background.
   - Nếu `allowed: true`:
     - Gán `guardAllowed = true`.
     - Hiển thị tên lớp, gọi hàm `renderMaterials(context.materials)`.
     - Ẩn `loginBtn`.
     - `guardMessage = "Sẵn sàng ghi tab Meet này."`.
   - Nếu `allowed: false`:
     - Gán `guardAllowed = false`.
     - Ẩn tên lớp, ẩn materials.
     - Phân loại reason và hiển thị thông báo tiếng Việt:
       - `"NOT_LOGGED_IN"`: Hiện `loginBtn` và thông báo *"Chưa đăng nhập LMS hoặc phiên làm việc đã hết hạn. Vui lòng đăng nhập lại 1Study để bắt đầu."*
       - `"NO_ACTIVE_CLASS"`: *"Phòng Meet này không thuộc lớp học nào đang diễn ra trên 1Study."*
       - `"NOT_YOUR_CLASS"`: *"Bạn không phải giáo viên phụ trách lớp học này."*
       - `"OUTSIDE_SCHEDULE"`: *"Buổi học chưa bắt đầu hoặc đã kết thúc (cho phép từ trước 10 phút đến sau 30 phút)."*
       - `"NETWORK_ERROR"`: *"Không thể kết nối đến hệ thống LMS. Vui lòng kiểm tra lại mạng."*
4. Gắn event click cho `loginBtn`: mở `CONFIG.LMS_API().root + "login/index.php"` trong tab mới.

---

### Task 6: Redesign Modal Leave Action & Fallback (`detect-leave-action.ts` & `content.ts`)

**Files:**
- Modify: `src/content-logic/detect-leave-action.ts`
- Modify: `src/content-logic/test/detect-leave-action.test.ts`
- Modify: `entrypoints/content.ts`

- [ ] **Step 1: Viết test cập nhật cho `LeaveConfirmDialog` trong `detect-leave-action.test.ts`**

Cập nhật `src/content-logic/test/detect-leave-action.test.ts`:
- Sửa `HOST = '#1study-leave-confirm-dialog'` đồng nhất với `HOST_ID`.
- Gọi `openShadowRoots()` trong `beforeEach` của describe `LeaveConfirmDialog`.
- Kiểm tra render dialog: tiêu đề "Kết thúc lớp học", thời gian ghi, text cảnh báo.
- Kiểm tra nút Huỷ resolve `false`, nút Kết thúc resolve `true`.

- [ ] **Step 2: Cập nhật giao diện Modal trong `src/content-logic/detect-leave-action.ts`**

Áp dụng bảng màu `theme.css`, cấu trúc thẻ rõ ràng:
- Tiêu đề: *"Kết thúc lớp học"* (16px, font-weight 600).
- Chip thời gian: *"Thời gian đã ghi: X phút"* với nền cam nhạt hoặc xám.
- Nội dung: *"Bạn có chắc muốn kết thúc lớp học ngay lúc này không?"*.
- Dòng giải thích: *"Hệ thống sẽ kết thúc cuộc gọi cho tất cả học sinh và hoàn tất bản ghi hình."*.
- Nút `Huỷ`: Class `cancel`, border `1px solid #e5e7eb`, background `#ffffff`.
- Nút `Kết thúc lớp`: Class `confirm`, background `#dc2626`, chữ trắng đậm.
- Hỗ trợ hàm `setLoading(loading: boolean)` đổi nút sang "Đang kết thúc..." và disable để tránh double click.

- [ ] **Step 3: Cập nhật `entrypoints/content.ts` gọi `LMS_END_CLASS` với 2.5s timeout fallback**

Trong handler `watchLeaveButton`:
```typescript
      void leaveConfirmDialog.show(elapsedMs).then(async (confirmed) => {
        if (!confirmed) return;

        leaveConfirmDialog.setLoading(true);

        try {
          await Promise.race([
            browser.runtime.sendMessage({ type: "LMS_END_CLASS" }),
            new Promise((resolve) => setTimeout(resolve, 2500)),
          ]);
        } catch (err) {
          logger.warn("LMS_END_CLASS error or timeout", { error: String(err) });
        } finally {
          leaveConfirmDialog.unmount();
          suppressNextLeaveClick = true;
          button.click();
        }
      });
```

- [ ] **Step 4: Chạy test xác nhận test modal pass**

Chạy: `npx vitest run src/content-logic/test/detect-leave-action.test.ts`
Kỳ vọng: PASS.

---

### Task 7: Kiểm thử toàn diện & Hồi quy hệ thống

**Files:**
- Run checks across the codebase

- [ ] **Step 1: Kiểm tra TypeScript Compile**

Chạy: `npm run compile`
Kỳ vọng: Không có bất kỳ lỗi TypeScript nào (`tsc --noEmit` exit 0).

- [ ] **Step 2: Chạy toàn bộ Test Suite**

Chạy: `npm test`
Kỳ vọng: Tất cả test files đều pass (bao gồm api-service, lms-adapter, detect-leave-action, session-ledger, recorder, v.v.).

- [ ] **Step 3: Dọn dẹp & Chuẩn bị Review**

Kiểm tra `git status` đảm bảo:
- `src/adapters/lms-system.ts` đã xoá.
- `src/core/tab-guard.ts` đã xoá.
- Thư mục `src/adapters/lms/` có đầy đủ `types.ts`, `lms-adapter.ts`, `test/lms-adapter.test.ts`.
- Mọi thay đổi đều đã sẵn sàng để người dùng review trước khi commit.
