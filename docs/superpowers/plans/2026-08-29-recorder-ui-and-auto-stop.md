# Recorder UI + Auto-Stop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dừng ghi hình tự động khi giáo viên đóng tab Meet hoặc rời cuộc họp, và thiết kế lại toàn bộ bề mặt giao diện của extension theo hệ màu cam.

**Architecture:** Phát hiện kết thúc lớp đặt ở background (nơi duy nhất giữ trạng thái phiên) qua `tabs.onRemoved` và `tabs.onUpdated`, cộng một lưới an toàn ở offscreen nghe `videoTrack.onended`. Cả ba đổ về một hàm `endSession` duy nhất. Giao diện gồm ba bề mặt độc lập: badge trên icon (background, chạy bằng `chrome.alarms`), popup (đồng hồ + hai thanh mức âm nhận qua message `AUDIO_LEVEL`), và pill trạng thái trong tab Meet (content script, dựng trong shadow root). Mọi quyết định đều nằm trong module thuần có unit test; các entrypoint chỉ làm dây nối.

**Tech Stack:** TypeScript strict, WXT (Vite) + Manifest V3, Vitest + jsdom, `@webext-core/fake-browser`.

**Spec:** `docs/superpowers/specs/2026-08-29-recorder-ui-and-auto-stop-design.md`

## Global Constraints

- TypeScript `strict: true`. Cấm `any` — dùng `unknown` + type guard.
- Mọi `switch` trên `Message["type"]` phải exhaustive, kết thúc bằng `default: return assertNever(message)`. Thêm một biến thể message mới nghĩa là phải thêm `case` ở **cả bốn** nơi: `entrypoints/background.ts`, `entrypoints/offscreen/main.ts`, `entrypoints/content.ts`, `entrypoints/popup/main.ts`.
- Mọi hằng số nằm trong `src/shared/config.ts`. Không rải magic number.
- Constructor injection, không singleton, không biến global. Class nào không test được mà không cần Chrome thật là thiết kế sai.
- Không `console.log` thô — dùng `createLogger(scope)`. Không bao giờ log nội dung media hoặc token.
- **R12** — không bao giờ chặn lớp đang diễn ra: không modal, không overlay bắt thao tác. Pill phải `pointer-events: none`.
- **R13** — không đặt logic quan trọng vào `setInterval` của content script (tab nền bị bóp còn 1 lần/phút). Đồng hồ pill chỉ vẽ chữ; mọi quyết định nằm ở background (`chrome.alarms`) và offscreen.
- Hệ màu, dùng đúng các giá trị này: `--brand: #F97316` · `--brand-dark: #EA580C` · `--danger: #DC2626` · `--ok: #16A34A` · `--ink: #1F2937` · `--muted: #6B7280` · `--surface: #FFFFFF` · `--line: #E5E7EB`. Không dùng vàng.
- Toàn bộ chữ hiển thị cho giáo viên viết bằng tiếng Việt.
- **Không đụng tới:** uploader, `lms-client`, giao thức chunk, xác thực LMS, heartbeat, phát hiện layout Tiled, `chunk-writer`, `session-ledger`, `storage-guard`, `event-reporter`, `state-machine`, `frame-monitor`, `device-tier`, `tab-guard`, `entrypoints/permission/`.
- Chạy test: `npm test`. Kiểm tra kiểu: `npm run compile`. Build: `npm run build`.

### Ghi chú sai lệch so với spec

Spec liệt kê `src/core/badge-format.ts` chỉ có `formatElapsedBadge`. Kế hoạch này để file đó export thêm `formatClock` — cùng một trách nhiệm (trình bày thời gian đã ghi), và popup lẫn pill đều cần nó. Không tạo file thứ hai cho một hàm bốn dòng.

Spec §8 liệt kê `entrypoints/popup/index.html` và `main.ts` nhưng không nêu file CSS riêng. Kế hoạch tách style popup ra `entrypoints/popup/style.css` thay vì nhét `<style>` vào HTML — style của popup dài hơn 100 dòng, để trong HTML thì cả hai thứ đều khó đọc.

Spec không nêu module theo dõi cảnh báo. Kế hoạch thêm `src/core/alert-set.ts` vì spec §4 yêu cầu badge đổi sang `--danger` khi DEGRADED, mà background cần biết cảnh báo nào đang bật để quyết định — bốn nguồn cảnh báo bật/tắt độc lập, không thể dùng một cờ boolean.

---

### Task 1: Bộ phát hiện kết thúc phiên (thuần) + `meetingCode` trong active session

Module thuần quyết định sự kiện tab nào kết thúc phiên ghi. Chưa đấu dây vào đâu — Task 2 làm việc đó. Task này cũng bổ sung trường `meetingCode` mà bộ phát hiện cần.

**Files:**
- Create: `src/core/session-end-detector.ts`
- Test: `src/core/test/session-end-detector.test.ts`
- Modify: `src/shared/messages.ts` (interface `ActiveSessionInfo`)
- Modify: `entrypoints/background.ts` (`handleStart`, chỗ gọi `writeActiveSession`)

**Interfaces:**
- Consumes: `extractMeetingCode(url: string): string | null` từ `src/core/meeting-code.ts`; `ActiveSessionInfo` từ `src/shared/messages.ts`.
- Produces: `type SessionEndReason = "TAB_CLOSED" | "MEETING_LEFT"`; `evaluateTabRemoved(active: ActiveSessionInfo | null, closedTabId: number): SessionEndReason | null`; `evaluateTabUrlChange(active: ActiveSessionInfo | null, tabId: number, newUrl: string | undefined): SessionEndReason | null`. `ActiveSessionInfo` có thêm `meetingCode: string`.

- [ ] **Step 1: Thêm `meetingCode` vào `ActiveSessionInfo`**

Trong `src/shared/messages.ts`, sửa interface `ActiveSessionInfo`:

```ts
export interface ActiveSessionInfo {
  sessionId: string;
  tabId: number;
  /**
   * Mã phòng Meet của tab đang ghi. Dùng để phát hiện giáo viên đã rời cuộc
   * họp: URL đổi mà mã phòng khác đi nghĩa là lớp kết thúc.
   *
   * Phiên cũ còn sót trong chrome.storage.local từ bản trước không có trường
   * này, nên nó phải được đọc như một giá trị có thể thiếu ở phía tiêu thụ.
   */
  meetingCode: string;
  status: ActiveSessionStatus;
  startedAtMs: number;
}
```

- [ ] **Step 2: Viết test thất bại**

Tạo `src/core/test/session-end-detector.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { evaluateTabRemoved, evaluateTabUrlChange } from '../session-end-detector';
import type { ActiveSessionInfo } from '../../shared/messages';

function session(overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    sessionId: 's1',
    tabId: 42,
    meetingCode: 'abc-defg-hij',
    status: 'RECORDING',
    startedAtMs: 0,
    ...overrides,
  };
}

describe('evaluateTabRemoved', () => {
  it('ends the session when the recorded tab is the one closed', () => {
    expect(evaluateTabRemoved(session(), 42)).toBe('TAB_CLOSED');
  });

  it('ignores another tab closing', () => {
    expect(evaluateTabRemoved(session(), 99)).toBeNull();
  });

  it('ignores everything when no session is active', () => {
    expect(evaluateTabRemoved(null, 42)).toBeNull();
  });

  it('still fires for a pre-upgrade session that has no meetingCode', () => {
    const legacy = { ...session(), meetingCode: undefined } as unknown as ActiveSessionInfo;
    expect(evaluateTabRemoved(legacy, 42)).toBe('TAB_CLOSED');
  });
});

describe('evaluateTabUrlChange', () => {
  it('ends the session when the URL leaves the recorded meeting code', () => {
    expect(evaluateTabUrlChange(session(), 42, 'https://meet.google.com/')).toBe('MEETING_LEFT');
  });

  it('ends the session when the tab navigates off Meet entirely', () => {
    expect(evaluateTabUrlChange(session(), 42, 'https://www.google.com/')).toBe('MEETING_LEFT');
  });

  it('ends the session when the URL moves to a different meeting', () => {
    expect(evaluateTabUrlChange(session(), 42, 'https://meet.google.com/zzz-zzzz-zzz')).toBe('MEETING_LEFT');
  });

  it('keeps recording when the URL changes but the meeting code is unchanged', () => {
    expect(
      evaluateTabUrlChange(session(), 42, 'https://meet.google.com/abc-defg-hij?authuser=1'),
    ).toBeNull();
  });

  it('ignores a URL change in a tab that is not the one being recorded', () => {
    expect(evaluateTabUrlChange(session(), 99, 'https://www.google.com/')).toBeNull();
  });

  it('ignores an onUpdated event that carried no URL', () => {
    expect(evaluateTabUrlChange(session(), 42, undefined)).toBeNull();
  });

  it('ignores everything when no session is active', () => {
    expect(evaluateTabUrlChange(null, 42, 'https://www.google.com/')).toBeNull();
  });

  it('refuses to conclude anything for a pre-upgrade session with no meetingCode', () => {
    const legacy = { ...session(), meetingCode: undefined } as unknown as ActiveSessionInfo;
    expect(evaluateTabUrlChange(legacy, 42, 'https://www.google.com/')).toBeNull();
  });
});
```

- [ ] **Step 3: Chạy test, xác nhận nó thất bại**

Run: `npx vitest run src/core/test/session-end-detector.test.ts`
Expected: FAIL — `Failed to resolve import "../session-end-detector"`

- [ ] **Step 4: Viết implementation tối thiểu**

Tạo `src/core/session-end-detector.ts`:

```ts
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
```

- [ ] **Step 5: Chạy test, xác nhận nó xanh**

Run: `npx vitest run src/core/test/session-end-detector.test.ts`
Expected: PASS — 13 test

- [ ] **Step 6: Lưu `meetingCode` khi bắt đầu phiên**

Trong `entrypoints/background.ts`, `handleStart` hiện tính mã phòng hai lần bằng `extractMeetingCode(tab.url ?? "")` và ép kiểu `!` ở chỗ gọi `sessionLedger.start`. Tính một lần, trước khối `try`, ngay sau khi guard đi qua:

```ts
  if (!guard.allowed) {
    await refuseStart(guard.reason);
    return;
  }

  // Guard đã bảo đảm đây là tab Meet có mã phòng hợp lệ, nên giá trị này
  // không thể null — tính một lần ở đây thay vì ép kiểu ở từng chỗ dùng.
  const meetingCode = extractMeetingCode(tab.url ?? '')!;
```

Rồi trong khối `try`, đưa nó vào cả hai chỗ ghi:

```ts
    await writeActiveSession({
      sessionId,
      tabId: message.tabId,
      meetingCode,
      status: 'STARTING',
      startedAtMs: Date.now(),
    });
    await sessionLedger.start({
      sessionId,
      meetingCode,
      tabId: message.tabId,
      startedAtMs: Date.now(),
    });
```

- [ ] **Step 7: Kiểm tra kiểu và chạy toàn bộ test**

Run: `npm run compile && npm test`
Expected: cả hai xanh. Nếu `npm run compile` báo lỗi ở một chỗ dựng `ActiveSessionInfo` nào khác, thêm `meetingCode` vào đó.

- [ ] **Step 8: Commit**

```bash
git add src/core/session-end-detector.ts src/core/test/session-end-detector.test.ts src/shared/messages.ts entrypoints/background.ts
git commit -m "feat: add a pure detector for tab events that end a recording session"
```

---

### Task 2: Một đường dừng duy nhất + đấu dây vòng đời tab

Đây là task sửa đúng cái bug user báo. Gộp mọi đường dừng vào `endSession`, rồi cho `tabs.onRemoved` và `tabs.onUpdated` gọi vào đó.

**Files:**
- Modify: `entrypoints/background.ts` (`handleStop`, `handleRecordingState`, khối `defineBackground`)

**Interfaces:**
- Consumes: `evaluateTabRemoved`, `evaluateTabUrlChange`, `SessionEndReason` từ Task 1.
- Produces: `endSession(sessionId: string, reason: EndReason): Promise<void>` — đường finalize duy nhất trong background. Task 5 sẽ chèn thêm việc xoá badge vào chính hàm này.

- [ ] **Step 1: Tách `endSession` khỏi `handleStop`**

Trong `entrypoints/background.ts`, thay toàn bộ hàm `handleStop` bằng:

```ts
/** Vì sao một phiên kết thúc. Rộng hơn `SessionEndReason` vì bấm Dừng không phải sự kiện tab. */
type EndReason = SessionEndReason | 'USER_STOPPED';

/**
 * Đường finalize duy nhất. Mọi cách kết thúc một phiên — giáo viên bấm Dừng,
 * đóng tab, rời cuộc họp — đều đi qua đây, nên chỉ có một trình tự dọn dẹp
 * để suy luận và để sửa.
 *
 * `reason` chỉ dùng để ghi log. Trạng thái trong sessionLedger vẫn do đường
 * FINALIZING sẵn có ghi khi offscreen chốt xong file.
 */
async function endSession(sessionId: string, reason: EndReason): Promise<void> {
  const active = await readActiveSession();
  if (!active || active.sessionId !== sessionId) {
    logger.warn('end requested for a session this worker does not own', {
      requested: sessionId,
      active: active?.sessionId ?? null,
      reason,
    });
  }

  logger.info('ending session', { sessionId, reason });

  // Giải phóng quyền sở hữu trước: kể cả khi offscreen đã biến mất, giáo viên
  // vẫn phải bắt đầu được phiên mới ngay sau đó.
  await writeActiveSession(null);
  if (active) {
    await sendToTab(active.tabId, {
      type: 'RECORDING_ACTIVE',
      active: false,
      sessionId: null,
      startedAtMs: null,
    });
  }
  await browser.runtime.sendMessage({ type: 'RECORDING_STOP', sessionId });
}

async function handleStop(message: MessageOf<'STOP_RECORDING'>): Promise<void> {
  await endSession(message.sessionId, 'USER_STOPPED');
}
```

Import `SessionEndReason` ở đầu file:

```ts
import {
  evaluateTabRemoved,
  evaluateTabUrlChange,
  type SessionEndReason,
} from '@/src/core/session-end-detector';
```

- [ ] **Step 2: Thêm `startedAtMs` vào message `RECORDING_ACTIVE`**

Bước trước vừa dùng trường này. Trong `src/shared/messages.ts`, sửa biến thể `RECORDING_ACTIVE`:

```ts
  // background → content script (via browser.tabs.sendMessage). `startedAtMs`
  // đi kèm để pill dựng được đồng hồ ngay, không phải hỏi ngược lại.
  | { type: 'RECORDING_ACTIVE'; active: boolean; sessionId: string | null; startedAtMs: number | null }
```

Rồi trong `handleRecordingState`, nhánh `RECORDING`, bổ sung trường vào lệnh gửi đã có:

```ts
    await sendToTab(active.tabId, {
      type: 'RECORDING_ACTIVE',
      active: true,
      sessionId: message.sessionId,
      startedAtMs: active.startedAtMs,
    });
```

Và nhánh `FAILED` trong cùng hàm đó:

```ts
      await sendToTab(active.tabId, {
        type: 'RECORDING_ACTIVE',
        active: false,
        sessionId: null,
        startedAtMs: null,
      });
```

- [ ] **Step 3: Giải phóng phiên ở nhánh `FINALIZING`**

Vẫn trong `handleRecordingState`. Nhánh `FINALIZING` hiện chỉ ghi ledger, vì nó giả định `handleStop` đã dọn trước. Task 3 phá vỡ giả định đó (offscreen sẽ tự dừng). Thay khối `FINALIZING` bằng:

```ts
  if (message.state === 'FINALIZING') {
    // offscreen chỉ báo FINALIZING sau khi recorder.stop() và bước ghi file
    // đều xong — ở đây nó luôn là tín hiệu kết thúc, không phải "đang chốt".
    await sessionLedger.setStatus(message.sessionId, 'STOPPED');

    // Khi offscreen tự dừng (video track chết, Task 3) thì background chưa
    // hề biết. endSession chưa chạy, nên phải dọn ở đây. Nếu endSession đã
    // chạy rồi thì active đã null và cả khối này là no-op.
    if (active?.sessionId === message.sessionId) {
      await writeActiveSession(null);
      await sendToTab(active.tabId, {
        type: 'RECORDING_ACTIVE',
        active: false,
        sessionId: null,
        startedAtMs: null,
      });
    }
    return;
  }
```

Lưu ý `return;` ở cuối — trước đây khối này rơi xuống lệnh `logger.info` phía dưới; giờ nó tự kết thúc.

- [ ] **Step 4: Đấu `tabs.onRemoved`**

Trong khối `defineBackground(() => { ... })`, thêm ngay sau listener `tabs.onActivated` đã có:

```ts
  // Đóng tab đang ghi = lớp kết thúc. Không có listener này thì tabCapture
  // chết theo tab (khung hình đóng băng) trong khi mic getUserMedia — vốn
  // độc lập với tab — vẫn thu tiếp: đúng cái đuôi ảnh đơ kèm tiếng giáo viên
  // mà bản ghi đang bị dính.
  browser.tabs.onRemoved.addListener((tabId) => {
    run(
      (async () => {
        const reason = evaluateTabRemoved(await readActiveSession(), tabId);
        if (!reason) return;
        const active = await readActiveSession();
        if (active) await endSession(active.sessionId, reason);
      })(),
      'tab removed',
    );
  });
```

- [ ] **Step 5: Đấu phát hiện rời cuộc họp vào `tabs.onUpdated`**

Thay listener `tabs.onUpdated` hiện có bằng:

```ts
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') void refreshActionState(tabId, tab.url);

    // Bấm "Kết thúc cuộc gọi" làm Meet điều hướng khỏi mã phòng. onUpdated
    // bắn cả với điều hướng SPA qua history.pushState, nên không cần load lại
    // trang mới nhận được.
    if (changeInfo.url === undefined) return;
    run(
      (async () => {
        const active = await readActiveSession();
        const reason = evaluateTabUrlChange(active, tabId, changeInfo.url);
        if (!reason || !active) return;
        await endSession(active.sessionId, reason);
      })(),
      'tab url change',
    );
  });
```

- [ ] **Step 6: Kiểm tra kiểu và chạy test**

Run: `npm run compile && npm test`
Expected: cả hai xanh. `npm run compile` sẽ báo lỗi ở mọi `switch` chưa xử lý trường mới của `RECORDING_ACTIVE` — các switch chỉ khớp trên `type` nên không nơi nào cần sửa; nếu có báo lỗi thì là một chỗ dựng message còn thiếu `startedAtMs`.

- [ ] **Step 7: Build và nạp extension**

```bash
npm run build
```

Vào `chrome://extensions` → bật Developer mode → Load unpacked → chọn `.output/chrome-mv3`.

- [ ] **Step 8: Kiểm chứng thủ công — đóng tab**

1. Mở một phòng Meet có ít nhất 2 người, camera cả hai bật, layout Tiled.
2. Bấm icon extension → Bắt đầu ghi. Ghi 2 phút.
3. Đóng tab Meet.
4. Mở file `.webm` vừa tải về.

Kỳ vọng: file dừng đúng lúc đóng tab. **Không** có đuôi ảnh đóng băng, **không** nghe thấy tiếng giáo viên sau thời điểm đóng tab.

- [ ] **Step 9: Kiểm chứng thủ công — rời cuộc họp**

Bước quan trọng nhất của task, vì nó kiểm chứng giả định "Meet đổi URL khi rời cuộc gọi".

1. Mở `chrome://extensions` → service worker → Console, để mở.
2. Bắt đầu ghi, đợi 1 phút.
3. Bấm "Kết thúc cuộc gọi" của Meet, **để nguyên tab, không đóng**.
4. Xem console.

Kỳ vọng: log `[background] ending session { reason: "MEETING_LEFT" }` và file được tải về.

**Nếu không có log nào:** Meet giữ nguyên URL và chỉ vẽ đè màn hình "Bạn đã rời cuộc họp". Ghi lại phát hiện này vào phần Ghi chú của spec, rồi bổ sung một lượt phát hiện phụ trong `entrypoints/content.ts`: theo dõi `document.body` bằng `MutationObserver`, khi nút rời cuộc gọi (`button[aria-label]` chứa hành động kết thúc) biến mất khỏi DOM thì gửi một message mới `MEETING_LEFT` về background, background gọi `endSession(id, "MEETING_LEFT")`. Đây là fallback dựa vào DOM nên phải fail mềm: không tìm thấy nút thì im lặng, ghi hình chạy tiếp đúng như trước. Lớp an toàn ở Task 3 vẫn là lưới cuối.

- [ ] **Step 10: Kiểm chứng thủ công — đóng cả cửa sổ**

Ghi 1 phút → đóng cả cửa sổ Chrome chứa tab Meet (Chrome vẫn còn cửa sổ khác đang mở). Kỳ vọng: phiên dừng, file tải về.

- [ ] **Step 11: Kiểm chứng thủ công — không dừng nhầm**

Ghi ở tab A. Mở tab Meet thứ hai (tab B) ở một phòng khác, rồi đóng tab B. Kỳ vọng: phiên ở tab A vẫn ghi bình thường, không có log `ending session`.

- [ ] **Step 12: Commit**

```bash
git add entrypoints/background.ts src/shared/messages.ts
git commit -m "fix: stop recording when the Meet tab closes or the teacher leaves the call"
```

---

### Task 3: Lưới an toàn — offscreen tự dừng khi video track chết

Lớp 1 phụ thuộc vào listener của service worker còn sống và vào việc Meet đổi URL. Lớp này thì không phụ thuộc gì cả: tầng media biết track chết trước mọi thứ khác.

**Files:**
- Modify: `entrypoints/offscreen/main.ts` (`startRecording`)

**Interfaces:**
- Consumes: `stopRecording(message: MessageOf<'RECORDING_STOP'>): Promise<void>` — đã có sẵn trong cùng file.
- Produces: không có export mới.

- [ ] **Step 1: Nghe sự kiện `ended` của video track**

Trong `entrypoints/offscreen/main.ts`, hàm `startRecording`, ngay sau dòng `activeTabStream = await openTabStream(streamId, tier);`:

```ts
    // Lưới an toàn cho việc tự dừng. Background cũng phát hiện đóng tab và
    // rời cuộc họp (session-end-detector), nhưng lớp này không phụ thuộc vào
    // listener nào của service worker còn sống, cũng không phụ thuộc vào việc
    // Meet có đổi URL hay không — track chết là sự thật của tầng media.
    //
    // Dùng lại đúng stopRecording: cùng đường finalize, cùng
    // releaseSessionHandles(), cùng window.close(). Gọi hai lần vô hại vì
    // stopRecording rơi vào nhánh "unknown session" khi phiên đã dọn xong.
    activeTabStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      logger.warn('captured video track ended — stopping the session', { sessionId });
      run(stopRecording({ type: 'RECORDING_STOP', sessionId }), 'track ended stop');
    });
```

- [ ] **Step 2: Kiểm tra kiểu và chạy test**

Run: `npm run compile && npm test`
Expected: cả hai xanh.

`stopRecording` được khai báo bên dưới `startRecording` trong cùng module — function declaration nên được hoisted, gọi ngược lên là hợp lệ.

- [ ] **Step 3: Kiểm chứng thủ công — lớp an toàn chạy độc lập**

Tạm thời vô hiệu hoá lớp 1 để chứng minh lớp 2 tự đứng được:

1. Trong `entrypoints/background.ts`, comment tạm thân của listener `tabs.onRemoved` (giữ nguyên listener rỗng).
2. `npm run build`, reload extension.
3. Ghi 1 phút → đóng tab Meet.

Kỳ vọng: file vẫn được tải về, vẫn không có đuôi ảnh đơ. Trong console của offscreen (`chrome://extensions` → Inspect views → offscreen.html) có log `captured video track ended`.

4. **Bỏ comment, khôi phục nguyên trạng listener**, `npm run build` lại.
5. `git diff entrypoints/background.ts` — xác nhận không còn dấu vết của bước thử này.

- [ ] **Step 4: Kiểm chứng thủ công — hai lớp cùng bắn không gây lỗi**

Với cả hai lớp bật, ghi 1 phút → đóng tab. Kỳ vọng: đúng một file được tải về, không có exception nào trong console của background lẫn offscreen. Log `ignoring stop for an unknown session` xuất hiện là **đúng như thiết kế** — đó là lần gọi thứ hai bị chặn.

- [ ] **Step 5: Commit**

```bash
git add entrypoints/offscreen/main.ts
git commit -m "fix: self-stop the offscreen recorder when the captured video track ends"
```

---

### Task 4: Module thuần cho badge và tập cảnh báo

Hai module thuần Task 5 cần. Không đấu dây vào đâu ở task này.

**Files:**
- Create: `src/core/badge-format.ts`
- Create: `src/core/alert-set.ts`
- Test: `src/core/test/badge-format.test.ts`
- Test: `src/core/test/alert-set.test.ts`

**Interfaces:**
- Consumes: không.
- Produces: `formatElapsedBadge(elapsedMs: number): string` (tối đa 4 ký tự) · `formatClock(elapsedMs: number): string` (`45:12` hoặc `1:05:30`) · `type AlertKey = 'mic' | 'tab' | 'video' | 'storage'` · `withAlert(alerts: readonly AlertKey[], key: AlertKey, active: boolean): AlertKey[]` · `isDegraded(alerts: readonly AlertKey[]): boolean`.

- [ ] **Step 1: Viết test thất bại cho badge-format**

Tạo `src/core/test/badge-format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatElapsedBadge, formatClock } from '../badge-format';

const MIN = 60_000;

describe('formatElapsedBadge', () => {
  it('shows whole minutes below an hour', () => {
    expect(formatElapsedBadge(0)).toBe('0m');
    expect(formatElapsedBadge(59_999)).toBe('0m');
    expect(formatElapsedBadge(45 * MIN)).toBe('45m');
    expect(formatElapsedBadge(59 * MIN)).toBe('59m');
  });

  it('switches to hours with zero-padded minutes at an hour', () => {
    expect(formatElapsedBadge(60 * MIN)).toBe('1h00');
    expect(formatElapsedBadge(65 * MIN)).toBe('1h05');
    expect(formatElapsedBadge(150 * MIN)).toBe('2h30');
  });

  it('caps at 9h59 so the text never exceeds four characters', () => {
    expect(formatElapsedBadge(10 * 60 * MIN)).toBe('9h59');
    expect(formatElapsedBadge(99 * 60 * MIN)).toBe('9h59');
  });

  it('treats negative input as zero rather than rendering a minus sign', () => {
    expect(formatElapsedBadge(-5000)).toBe('0m');
  });

  it('never produces more than four characters', () => {
    for (let minutes = 0; minutes <= 700; minutes += 7) {
      expect(formatElapsedBadge(minutes * MIN).length).toBeLessThanOrEqual(4);
    }
  });
});

describe('formatClock', () => {
  it('shows mm:ss below an hour', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(45 * MIN + 12_000)).toBe('45:12');
  });

  it('shows h:mm:ss at an hour and beyond', () => {
    expect(formatClock(65 * MIN + 30_000)).toBe('1:05:30');
    expect(formatClock(2 * 60 * MIN)).toBe('2:00:00');
  });

  it('treats negative input as zero', () => {
    expect(formatClock(-1)).toBe('00:00');
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận nó thất bại**

Run: `npx vitest run src/core/test/badge-format.test.ts`
Expected: FAIL — `Failed to resolve import "../badge-format"`

- [ ] **Step 3: Viết implementation**

Tạo `src/core/badge-format.ts`:

```ts
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
```

- [ ] **Step 4: Chạy test, xác nhận nó xanh**

Run: `npx vitest run src/core/test/badge-format.test.ts`
Expected: PASS — 8 test

- [ ] **Step 5: Viết test thất bại cho alert-set**

Tạo `src/core/test/alert-set.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { withAlert, isDegraded, type AlertKey } from '../alert-set';

describe('withAlert', () => {
  it('adds an alert that was not present', () => {
    expect(withAlert([], 'mic', true)).toEqual(['mic']);
  });

  it('does not duplicate an alert that is already raised', () => {
    expect(withAlert(['mic'], 'mic', true)).toEqual(['mic']);
  });

  it('removes an alert when it clears', () => {
    expect(withAlert(['mic', 'video'], 'mic', false)).toEqual(['video']);
  });

  it('clearing an alert that was never raised is a no-op', () => {
    expect(withAlert(['video'], 'mic', false)).toEqual(['video']);
  });

  it('tracks the four sources independently', () => {
    let alerts: AlertKey[] = [];
    alerts = withAlert(alerts, 'mic', true);
    alerts = withAlert(alerts, 'storage', true);
    alerts = withAlert(alerts, 'mic', false);
    expect(alerts).toEqual(['storage']);
  });

  it('does not mutate the array it was given', () => {
    const original: AlertKey[] = ['mic'];
    withAlert(original, 'video', true);
    expect(original).toEqual(['mic']);
  });
});

describe('isDegraded', () => {
  it('is false with no alerts and true with any', () => {
    expect(isDegraded([])).toBe(false);
    expect(isDegraded(['tab'])).toBe(true);
    expect(isDegraded(['mic', 'video'])).toBe(true);
  });
});
```

- [ ] **Step 6: Chạy test, xác nhận nó thất bại**

Run: `npx vitest run src/core/test/alert-set.test.ts`
Expected: FAIL — `Failed to resolve import "../alert-set"`

- [ ] **Step 7: Viết implementation**

Tạo `src/core/alert-set.ts`:

```ts
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
```

- [ ] **Step 8: Chạy toàn bộ test và kiểm tra kiểu**

Run: `npm run compile && npm test`
Expected: cả hai xanh.

- [ ] **Step 9: Commit**

```bash
git add src/core/badge-format.ts src/core/alert-set.ts src/core/test/badge-format.test.ts src/core/test/alert-set.test.ts
git commit -m "feat: add pure helpers for badge text and the active alert set"
```

---

### Task 5: Badge trạng thái trên icon extension

**Files:**
- Modify: `src/shared/config.ts`
- Modify: `entrypoints/background.ts`

**Interfaces:**
- Consumes: `formatElapsedBadge` từ Task 4; `withAlert`, `isDegraded`, `AlertKey` từ Task 4; `endSession` từ Task 2.
- Produces: `refreshBadge(): Promise<void>` — nội bộ background, không export.

- [ ] **Step 1: Thêm hằng số vào config**

Trong `src/shared/config.ts`, thêm vào object `CONFIG`, ngay sau `STARTING_ACK_TIMEOUT_MS`:

```ts
  BADGE_TICK_ALARM_MINUTES: 1,
  BADGE_COLOR_RECORDING: '#F97316',
  BADGE_COLOR_DEGRADED: '#DC2626',
```

- [ ] **Step 2: Thêm state cảnh báo và hàm vẽ badge vào background**

Trong `entrypoints/background.ts`, thêm import:

```ts
import { formatElapsedBadge } from '@/src/core/badge-format';
import { withAlert, isDegraded, type AlertKey } from '@/src/core/alert-set';
```

Rồi thêm, cạnh các hằng số key đã có (`ACTIVE_SESSION_KEY`, `LAST_ERROR_KEY`):

```ts
const ACTIVE_ALERTS_KEY = 'activeAlerts';
const BADGE_ALARM = 'badgeTick';

async function readActiveAlerts(): Promise<AlertKey[]> {
  return (await store.get<AlertKey[]>(ACTIVE_ALERTS_KEY)) ?? [];
}

/**
 * Vẽ lại badge từ trạng thái đã persist chứ không từ biến trong bộ nhớ:
 * service worker chết giữa buổi là chuyện thường, và đồng hồ phải chạy tiếp
 * đúng chứ không nhảy về 0.
 */
async function refreshBadge(): Promise<void> {
  const active = await readActiveSession();
  if (!active) {
    await browser.action.setBadgeText({ text: '' });
    return;
  }
  const degraded = isDegraded(await readActiveAlerts());
  await browser.action.setBadgeText({
    text: formatElapsedBadge(Date.now() - active.startedAtMs),
  });
  await browser.action.setBadgeBackgroundColor({
    color: degraded ? CONFIG.BADGE_COLOR_DEGRADED : CONFIG.BADGE_COLOR_RECORDING,
  });
}

/** Bật/tắt một nguồn cảnh báo rồi vẽ lại badge nếu mức độ nghiêm trọng đổi. */
async function setAlert(key: AlertKey, active: boolean): Promise<void> {
  const before = await readActiveAlerts();
  const after = withAlert(before, key, active);
  if (isDegraded(before) === isDegraded(after) && before.length === after.length) return;
  await store.set(ACTIVE_ALERTS_KEY, after);
  await refreshBadge();
}
```

- [ ] **Step 3: Bật alarm khi vào RECORDING**

Trong `handleRecordingState`, nhánh `message.state === 'RECORDING'`, ngay trước `logger.info('recording confirmed', ...)`:

```ts
    await store.set(ACTIVE_ALERTS_KEY, []);
    await browser.alarms.create(BADGE_ALARM, {
      periodInMinutes: CONFIG.BADGE_TICK_ALARM_MINUTES,
    });
    await refreshBadge();
```

`chrome.alarms` chứ không phải `setInterval`: service worker bị Chrome giết bất cứ lúc nào, alarm đánh thức nó dậy đúng hạn còn `setInterval` thì chết theo.

- [ ] **Step 4: Tắt alarm và xoá badge trong `endSession`**

Nhánh `FINALIZING` và nhánh `FAILED` của `handleRecordingState` cũng giải phóng phiên mà không đi qua `endSession`, nên cùng ba dòng đó phải có ở cả hai chỗ. Gom vào một hàm để không có ba bản sao:

```ts
/** Mọi thứ gắn với badge của một phiên đang chạy. Gọi ở mọi đường giải phóng phiên. */
async function clearBadgeState(): Promise<void> {
  await browser.alarms.clear(BADGE_ALARM);
  await store.set(ACTIVE_ALERTS_KEY, []);
  await browser.action.setBadgeText({ text: '' });
}
```

`endSession` gọi `await clearBadgeState();` ngay sau `await writeActiveSession(null);`.

Nhánh `FAILED` của `handleRecordingState`:

```ts
    if (active?.sessionId === message.sessionId) {
      await writeActiveSession(null);
      await clearBadgeState();
      await sendToTab(active.tabId, {
        type: 'RECORDING_ACTIVE',
        active: false,
        sessionId: null,
        startedAtMs: null,
      });
    }
```

Nhánh `FINALIZING` của `handleRecordingState`:

```ts
    if (active?.sessionId === message.sessionId) {
      await writeActiveSession(null);
      await clearBadgeState();
      await sendToTab(active.tabId, {
        type: 'RECORDING_ACTIVE',
        active: false,
        sessionId: null,
        startedAtMs: null,
      });
    }
```

- [ ] **Step 5: Đăng ký listener cho alarm**

Trong khối `defineBackground`, thêm:

```ts
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== BADGE_ALARM) return;
    run(refreshBadge(), 'badge tick');
  });
```

- [ ] **Step 6: Nối cảnh báo vào badge**

Trong `browser.runtime.onMessage.addListener` của background, tách bốn case cảnh báo đang gộp chung. Thay:

```ts
        case "AUDIO_ALERT":
        case "VIDEO_STALLED":
        case "VIDEO_RECOVERED":
        case "STORAGE_ALERT":
          run(fanOutToRecordedTab(message), "alert fan-out");
          return false;
```

bằng:

```ts
        case 'AUDIO_ALERT':
          run(setAlert(message.source, message.silent), 'audio alert badge');
          run(fanOutToRecordedTab(message), 'alert fan-out');
          return false;
        case 'VIDEO_STALLED':
          run(setAlert('video', true), 'video stall badge');
          run(fanOutToRecordedTab(message), 'alert fan-out');
          return false;
        case 'VIDEO_RECOVERED':
          run(setAlert('video', false), 'video recovered badge');
          run(fanOutToRecordedTab(message), 'alert fan-out');
          return false;
        case 'STORAGE_ALERT':
          run(setAlert('storage', message.low), 'storage alert badge');
          run(fanOutToRecordedTab(message), 'alert fan-out');
          return false;
```

`message.source` của `AUDIO_ALERT` đã là `'mic' | 'tab'`, khớp thẳng với `AlertKey`.

- [ ] **Step 7: Kiểm tra kiểu, test, build**

Run: `npm run compile && npm test && npm run build`
Expected: cả ba xanh.

- [ ] **Step 8: Kiểm chứng thủ công**

Reload extension, rồi:

1. Bắt đầu ghi → badge hiện `0m` nền cam trong vòng vài giây.
2. Đợi qua mốc phút → badge thành `1m`, rồi `2m`.
3. Rút micro, đợi ~70 giây → badge chuyển nền đỏ, số phút vẫn chạy.
4. Cắm micro lại, nói vài câu → badge về nền cam.
5. Dừng ghi → badge biến mất hoàn toàn.
6. Đóng tab Meet giữa buổi (không bấm Dừng) → badge cũng biến mất.

- [ ] **Step 9: Kiểm chứng thủ công — sống sót qua cái chết của service worker**

1. Bắt đầu ghi, đợi 2 phút.
2. `chrome://extensions` → nút **Service worker** → trong DevTools chạy `chrome.runtime.reload()`... **không** làm vậy (nó khởi động lại cả extension). Thay vào đó: đóng tab DevTools của service worker, đợi khoảng 40 giây cho Chrome tự cho nó ngủ, rồi đợi tới lần alarm kế tiếp.
3. Xem badge.

Kỳ vọng: badge tiếp tục đúng số phút tính từ lúc bắt đầu, **không** nhảy về `0m`.

- [ ] **Step 10: Commit**

```bash
git add src/shared/config.ts entrypoints/background.ts
git commit -m "feat: show elapsed recording time and alert state on the extension icon badge"
```

---

### Task 6: Mức âm trực tiếp từ offscreen ra popup

**Files:**
- Modify: `src/shared/config.ts`
- Modify: `src/core/rms.ts`
- Test: `src/core/test/rms.test.ts` (tạo mới nếu chưa có)
- Modify: `src/offscreen-logic/audio-monitor.ts`
- Modify: `src/shared/messages.ts`
- Modify: `entrypoints/offscreen/main.ts`
- Modify: `entrypoints/background.ts`, `entrypoints/content.ts`, `entrypoints/popup/main.ts` (thêm `case` cho switch exhaustive)

**Interfaces:**
- Consumes: `computeRms`, `CONFIG` đã có.
- Produces: `levelToPercent(rms: number): number` (0–100) · message `{ type: 'AUDIO_LEVEL'; mic: number; tab: number }` mang **phần trăm đã chuẩn hoá**, không phải RMS thô · `AudioLevelMonitor` nhận tham số constructor thứ tư `onLevel?: (rms: number) => void`.

- [ ] **Step 1: Thêm hằng số vào config**

Trong `src/shared/config.ts`, thêm ngay sau `SILENCE_RMS_THRESHOLD`:

```ts
  LEVEL_SAMPLE_MS: 250,
  /**
   * Trần RMS ánh xạ thành 100% trên thanh mức âm. Giọng nói bình thường qua
   * micro có xử lý nằm khoảng 0.01–0.25; lấy trần cao hơn nữa thì thanh dính
   * đáy và giáo viên tưởng máy không nghe thấy mình.
   */
  LEVEL_CEILING_RMS: 0.25,
```

- [ ] **Step 2: Viết test thất bại cho `levelToPercent`**

Kiểm tra xem `src/core/test/rms.test.ts` đã tồn tại chưa (`ls src/core/test/`). Nếu có thì thêm khối `describe` bên dưới vào cuối file; nếu chưa thì tạo file với đầy đủ import:

```ts
import { describe, it, expect } from 'vitest';
import { levelToPercent } from '../rms';
import { CONFIG } from '../../shared/config';

describe('levelToPercent', () => {
  it('maps silence to zero', () => {
    expect(levelToPercent(0)).toBe(0);
    expect(levelToPercent(-0.5)).toBe(0);
  });

  it('maps the ceiling and anything above it to 100', () => {
    expect(levelToPercent(CONFIG.LEVEL_CEILING_RMS)).toBe(100);
    expect(levelToPercent(CONFIG.LEVEL_CEILING_RMS * 4)).toBe(100);
  });

  it('rises monotonically between silence and the ceiling', () => {
    let previous = -1;
    for (let rms = 0; rms <= CONFIG.LEVEL_CEILING_RMS; rms += 0.005) {
      const percent = levelToPercent(rms);
      expect(percent).toBeGreaterThanOrEqual(previous);
      previous = percent;
    }
  });

  it('gives ordinary speech a clearly visible reading, not a sliver', () => {
    // RMS ngay trên ngưỡng câm phải nhìn thấy được — đây chính là tín hiệu
    // "máy đang nghe thấy tôi" mà giáo viên trông vào (R4/R5).
    expect(levelToPercent(CONFIG.SILENCE_RMS_THRESHOLD)).toBeGreaterThan(15);
  });

  it('never returns a value outside 0–100', () => {
    for (const rms of [0, 0.001, 0.05, 0.25, 1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const percent = levelToPercent(rms);
      expect(percent).toBeGreaterThanOrEqual(0);
      expect(percent).toBeLessThanOrEqual(100);
    }
  });
});
```

- [ ] **Step 3: Chạy test, xác nhận nó thất bại**

Run: `npx vitest run src/core/test/rms.test.ts`
Expected: FAIL — `levelToPercent is not a function`

- [ ] **Step 4: Viết `levelToPercent`**

Thêm vào cuối `src/core/rms.ts`:

```ts
/**
 * RMS → phần trăm cho thanh mức âm. Thang căn bậc hai chứ không tuyến tính:
 * tai người nghe theo lôgarit, và tuyến tính khiến giọng nói bình thường chỉ
 * nhúc nhích được vài phần trăm ở đáy thanh.
 */
export function levelToPercent(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const normalized = Math.min(rms / CONFIG.LEVEL_CEILING_RMS, 1);
  return Math.round(Math.sqrt(normalized) * 100);
}
```

- [ ] **Step 5: Chạy test, xác nhận nó xanh**

Run: `npx vitest run src/core/test/rms.test.ts`
Expected: PASS

- [ ] **Step 6: Thêm callback `onLevel` vào `AudioLevelMonitor`**

Trong `src/offscreen-logic/audio-monitor.ts`, thay class bằng:

```ts
export class AudioLevelMonitor {
  private readonly analyser: AnalyserNode;
  private readonly buffer: Float32Array<ArrayBuffer>;
  private readonly tracker: SilenceTracker;
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private levelIntervalId: ReturnType<typeof setInterval> | undefined;

  constructor(
    ctx: AudioContext,
    source: MediaStreamAudioSourceNode,
    private readonly onEvent: (event: SilenceEvent) => void,
    /**
     * Nhịp lấy mẫu cho thanh mức âm của popup, nhanh hơn nhiều nhịp phát hiện
     * câm. Dùng lại đúng AnalyserNode ở trên — không thêm node, không thêm
     * AudioContext, chi phí CPU không đáng kể (R7: JS không đụng vào từng
     * khung hình).
     */
    private readonly onLevel?: (rms: number) => void,
  ) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buffer = new Float32Array(this.analyser.fftSize);
    source.connect(this.analyser);
    this.tracker = new SilenceTracker(CONFIG.SILENCE_ALERT_SECONDS, CONFIG.SILENCE_CHECK_INTERVAL_SECONDS);
  }

  private sample(): number {
    this.analyser.getFloatTimeDomainData(this.buffer);
    return computeRms(this.buffer);
  }

  start(): void {
    this.intervalId = setInterval(() => {
      const event = this.tracker.observe(isSilent(this.sample()));
      if (event !== 'NONE') this.onEvent(event);
    }, CONFIG.SILENCE_CHECK_INTERVAL_SECONDS * 1000);

    const onLevel = this.onLevel;
    if (!onLevel) return;
    this.levelIntervalId = setInterval(() => onLevel(this.sample()), CONFIG.LEVEL_SAMPLE_MS);
  }

  stop(): void {
    if (this.intervalId !== undefined) clearInterval(this.intervalId);
    if (this.levelIntervalId !== undefined) clearInterval(this.levelIntervalId);
    this.intervalId = undefined;
    this.levelIntervalId = undefined;
  }
}
```

Hai interval riêng chứ không phải một interval nhanh có đếm: `SilenceTracker` được xây quanh đúng nhịp `SILENCE_CHECK_INTERVAL_SECONDS`, đổi nhịp của nó là đổi ngưỡng cảnh báo câm 60 giây.

- [ ] **Step 7: Thêm message `AUDIO_LEVEL`**

Trong `src/shared/messages.ts`, thêm vào union, cạnh `AUDIO_ALERT`:

```ts
  // offscreen → popup: mức âm trực tiếp cho hai thanh, đơn vị phần trăm 0–100
  // (đã chuẩn hoá ở offscreen, người nhận không cần biết gì về RMS). Phát
  // liên tục trong lúc ghi; popup đóng thì không ai nhận và notify() nuốt lỗi.
  | { type: 'AUDIO_LEVEL'; mic: number; tab: number }
```

- [ ] **Step 8: Phát mức âm từ offscreen**

Trong `entrypoints/offscreen/main.ts`, thêm import `levelToPercent`:

```ts
import { levelToPercent } from '@/src/core/rms';
```

Thêm vào khối biến per-session ở đầu file:

```ts
let lastMicPercent = 0;
let lastTabPercent = 0;
let levelBroadcastIntervalId: ReturnType<typeof setInterval> | undefined;
```

Trong `startRecording`, thêm tham số thứ tư cho hai monitor đã có:

```ts
    micMonitor = new AudioLevelMonitor(
      ctx,
      micSource,
      (event) => {
        // Mute chủ động bằng nút của Meet không phải sự cố mic — bộ phát hiện
        // vẫn chạy để bắt kịp khi giáo viên bật lại, chỉ là không báo gì khi
        // đang mute.
        if (micMuted) return;
        if (event === 'ALERT') void reportEvent('MIC_SILENT', { sessionId });
        void notify({ type: 'AUDIO_ALERT', source: 'mic', silent: event === 'ALERT' });
      },
      (rms) => {
        lastMicPercent = micMuted ? 0 : levelToPercent(rms);
      },
    );
    tabMonitor = new AudioLevelMonitor(
      ctx,
      tabSource,
      (event) => {
        if (event === 'ALERT') void reportEvent('TAB_AUDIO_SILENT', { sessionId });
        void notify({ type: 'AUDIO_ALERT', source: 'tab', silent: event === 'ALERT' });
      },
      (rms) => {
        lastTabPercent = levelToPercent(rms);
      },
    );
    micMonitor.start();
    tabMonitor.start();

    // Một message gộp thay vì hai luồng riêng: popup vẽ cả hai thanh trong
    // cùng một khung hình, và số message giảm một nửa.
    levelBroadcastIntervalId = setInterval(() => {
      void notify({ type: 'AUDIO_LEVEL', mic: lastMicPercent, tab: lastTabPercent });
    }, CONFIG.LEVEL_SAMPLE_MS);
```

Thanh mic về 0 khi đang mute là cố ý: bản ghi lúc đó thật sự không có tiếng giáo viên (`micGain.gain.value = 0`), thanh phải nói đúng sự thật đó.

Trong `releaseSessionHandles`, thêm cạnh chỗ clear `storageCheckIntervalId`:

```ts
  if (levelBroadcastIntervalId !== undefined) clearInterval(levelBroadcastIntervalId);
  levelBroadcastIntervalId = undefined;
  lastMicPercent = 0;
  lastTabPercent = 0;
```

- [ ] **Step 9: Thêm `case 'AUDIO_LEVEL'` vào cả bốn switch**

`npm run compile` sẽ chỉ đúng chỗ nào thiếu. Thêm:

- `entrypoints/offscreen/main.ts` — vào nhóm case "phát ra chứ không tiêu thụ", cạnh `case 'AUDIO_ALERT':`
- `entrypoints/background.ts` — vào nhóm case bỏ qua, **không** đấu vào `setAlert` hay `fanOutToRecordedTab`: mức âm chỉ dành cho popup, content script không nhận
- `entrypoints/content.ts` — vào nhóm case bỏ qua
- `entrypoints/popup/main.ts` — tạm thời cho vào nhóm bỏ qua; Task 7 sẽ biến nó thành nơi vẽ thanh

- [ ] **Step 10: Kiểm tra kiểu, test, build**

Run: `npm run compile && npm test && npm run build`
Expected: cả ba xanh.

- [ ] **Step 11: Kiểm chứng thủ công**

Reload extension. Bắt đầu ghi, mở console của offscreen (`chrome://extensions` → Inspect views → offscreen.html), chạy:

```js
chrome.runtime.onMessage.addListener((m) => { if (m.type === 'AUDIO_LEVEL') console.log(m); });
```

Nói vào micro. Kỳ vọng: message chảy về khoảng 4 lần/giây, `mic` nhảy lên rõ rệt khi nói và về gần 0 khi im. Bấm nút mute của Meet → `mic` về 0.

Ghi nhận có chủ ý: dòng message 4/giây này giữ service worker sống suốt buổi ghi. Đó là đánh đổi đã chọn — badge nhờ vậy luôn đúng — chứ không phải tác dụng phụ ngoài ý muốn.

- [ ] **Step 12: Commit**

```bash
git add src/shared/config.ts src/core/rms.ts src/core/test/rms.test.ts src/offscreen-logic/audio-monitor.ts src/shared/messages.ts entrypoints/offscreen/main.ts entrypoints/background.ts entrypoints/content.ts entrypoints/popup/main.ts
git commit -m "feat: stream normalized mic and tab audio levels from the offscreen document"
```

---

### Task 7: Thiết kế lại popup

**Files:**
- Create: `src/shared/theme.css`
- Modify: `entrypoints/popup/index.html`
- Modify: `entrypoints/popup/main.ts`

**Interfaces:**
- Consumes: `formatClock` từ Task 4; message `AUDIO_LEVEL` từ Task 6; `ActiveSessionInfo.meetingCode` và `startedAtMs` từ Task 1.
- Produces: không có export mới.

- [ ] **Step 1: Tạo file token màu**

Tạo `src/shared/theme.css`:

```css
/*
 * Nguồn duy nhất cho hệ màu. Pill trong tab Meet nhân bản đúng bộ giá trị này
 * dưới dạng chuỗi style — shadow root không kế thừa stylesheet của trang, nên
 * hai nơi phải sửa cùng lúc nếu đổi màu thương hiệu.
 */
:root {
  --brand: #f97316;
  --brand-dark: #ea580c;
  --danger: #dc2626;
  --ok: #16a34a;
  --ink: #1f2937;
  --muted: #6b7280;
  --surface: #ffffff;
  --line: #e5e7eb;
}
```

- [ ] **Step 2: Viết lại markup popup**

Thay toàn bộ `entrypoints/popup/index.html`:

```html
<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <title>1Study Class Recorder</title>
  </head>
  <body>
    <div class="app">
      <header class="hdr">
        <span class="brand">1Study Recorder</span>
        <span id="chip" class="chip" hidden></span>
      </header>

      <main class="body">
        <div id="clock" class="clock" hidden>00:00</div>

        <div id="room" class="room" hidden>
          <span class="room-label">Phòng</span>
          <span id="room-code" class="room-code"></span>
        </div>

        <div id="levels" class="levels" hidden>
          <div class="level">
            <span class="level-label">Bạn</span>
            <div class="meter"><div id="mic-bar" class="bar"></div></div>
          </div>
          <div class="level">
            <span class="level-label">Học sinh</span>
            <div class="meter"><div id="tab-bar" class="bar"></div></div>
          </div>
        </div>

        <p id="message" class="message"></p>
      </main>

      <footer class="actions">
        <button id="start" class="btn btn-primary" type="button">Bắt đầu ghi</button>
        <button id="stop" class="btn btn-danger" type="button" hidden>Dừng ghi</button>
      </footer>
    </div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Thêm style của popup**

Tạo `entrypoints/popup/style.css`:

```css
@import '../../src/shared/theme.css';

* { box-sizing: border-box; }

body {
  margin: 0;
  width: 360px;
  font: 14px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: var(--ink);
  background: var(--surface);
}

.app { display: flex; flex-direction: column; }

.hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
}

.brand { font-weight: 600; }

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: var(--brand);
  white-space: nowrap;
}
.chip[data-degraded='true'] { background: var(--danger); }
.chip::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.body { padding: 16px; display: flex; flex-direction: column; gap: 14px; }

.clock {
  font-size: 34px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.5px;
  text-align: center;
  color: var(--ink);
}

.room { display: flex; justify-content: space-between; align-items: baseline; }
.room-label { color: var(--muted); font-size: 13px; }
.room-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

.levels { display: flex; flex-direction: column; gap: 9px; }
.level { display: flex; align-items: center; gap: 10px; }
.level-label { width: 66px; flex: none; font-size: 13px; color: var(--muted); }

.meter {
  flex: 1;
  height: 8px;
  border-radius: 999px;
  background: var(--line);
  overflow: hidden;
}

.bar {
  height: 100%;
  width: 0%;
  border-radius: 999px;
  background: var(--brand);
  transition: width 120ms linear;
}

.message { margin: 0; font-size: 13px; color: var(--muted); }
.message[data-tone='error'] { color: var(--danger); }
.message[data-tone='ok'] { color: var(--ok); }

.actions { padding: 0 16px 16px; }

.btn {
  width: 100%;
  padding: 11px 14px;
  border-radius: 8px;
  border: 1px solid transparent;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.btn:disabled { opacity: 0.45; cursor: default; }

.btn-primary { background: var(--brand); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--brand-dark); }

.btn-danger { background: var(--surface); color: var(--danger); border-color: var(--danger); }
.btn-danger:hover:not(:disabled) { background: #fef2f2; }
```

- [ ] **Step 4: Viết lại `entrypoints/popup/main.ts`**

Thay toàn bộ file:

```ts
import './style.css';
import { browser } from 'wxt/browser';
import type { Message, RecordingStateResponse } from '@/src/shared/messages';
import { getActiveTab } from '@/src/adapters/chrome-api';
import { createLogger } from '@/src/core/logger';
import { isMeetUrl, extractMeetingCode } from '@/src/core/meeting-code';
import { evaluateGuard } from '@/src/core/tab-guard';
import { formatClock } from '@/src/core/badge-format';
import { assertNever } from '@/src/core/assert';

const logger = createLogger('popup');

const el = {
  chip: document.querySelector<HTMLSpanElement>('#chip')!,
  clock: document.querySelector<HTMLDivElement>('#clock')!,
  room: document.querySelector<HTMLDivElement>('#room')!,
  roomCode: document.querySelector<HTMLSpanElement>('#room-code')!,
  levels: document.querySelector<HTMLDivElement>('#levels')!,
  micBar: document.querySelector<HTMLDivElement>('#mic-bar')!,
  tabBar: document.querySelector<HTMLDivElement>('#tab-bar')!,
  message: document.querySelector<HTMLParagraphElement>('#message')!,
  start: document.querySelector<HTMLButtonElement>('#start')!,
  stop: document.querySelector<HTMLButtonElement>('#stop')!,
};

type PopupView =
  | { kind: 'IDLE' }
  | { kind: 'STARTING' }
  | { kind: 'RECORDING'; sessionId: string; startedAtMs: number }
  | { kind: 'STOPPING'; sessionId: string };

type Tone = 'muted' | 'error' | 'ok';

let view: PopupView = { kind: 'IDLE' };
let guardAllowed = false;
let guardMessage = 'Đang kiểm tra tab này…';
let roomCode: string | null = null;
let notice: { text: string; tone: Tone } | null = null;
let degraded = false;
let clockIntervalId: ReturnType<typeof setInterval> | undefined;

function setMessage(text: string, tone: Tone): void {
  el.message.textContent = text;
  el.message.dataset.tone = tone;
}

/**
 * Đồng hồ chạy trong popup được, nhưng mốc bắt đầu thì không: nó tính từ
 * `startedAtMs` mà background persist, nên đóng rồi mở lại popup giữa buổi
 * vẫn ra đúng số chứ không đếm lại từ 0.
 */
function startClock(startedAtMs: number): void {
  stopClock();
  const tick = (): void => {
    el.clock.textContent = formatClock(Date.now() - startedAtMs);
  };
  tick();
  clockIntervalId = setInterval(tick, 1000);
}

function stopClock(): void {
  if (clockIntervalId !== undefined) clearInterval(clockIntervalId);
  clockIntervalId = undefined;
}

function render(): void {
  const recording = view.kind === 'RECORDING';

  el.chip.hidden = !recording && view.kind !== 'STARTING';
  el.chip.textContent = recording ? 'ĐANG GHI' : 'ĐANG BẮT ĐẦU';
  el.chip.dataset.degraded = String(degraded && recording);

  el.clock.hidden = !recording;
  el.levels.hidden = !recording;

  el.room.hidden = roomCode === null;
  if (roomCode) el.roomCode.textContent = roomCode;

  el.start.hidden = recording || view.kind === 'STOPPING';
  el.stop.hidden = !el.start.hidden;

  switch (view.kind) {
    case 'IDLE':
      el.start.disabled = !guardAllowed;
      el.start.textContent = 'Bắt đầu ghi';
      setMessage(notice?.text ?? guardMessage, notice?.tone ?? 'muted');
      return;
    case 'STARTING':
      el.start.disabled = true;
      el.start.textContent = 'Đang bắt đầu…';
      setMessage('Đang chuẩn bị ghi hình…', 'muted');
      return;
    case 'RECORDING':
      el.stop.disabled = false;
      el.stop.textContent = 'Dừng ghi';
      setMessage(notice?.text ?? '', notice?.tone ?? 'muted');
      return;
    case 'STOPPING':
      el.stop.disabled = true;
      el.stop.textContent = 'Đang dừng…';
      setMessage('Đang chốt file…', 'muted');
      return;
    default:
      return assertNever(view);
  }
}

function enterView(next: PopupView): void {
  view = next;
  if (next.kind === 'RECORDING') startClock(next.startedAtMs);
  else stopClock();
  render();
}

/** Đọc trạng thái phiên đã persist ở background thay vì tin vào một message một chiều. */
async function rehydrate(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage<Message, RecordingStateResponse | undefined>({
      type: 'GET_RECORDING_STATE',
    });
    const lastError = response?.lastError ?? null;
    notice = lastError ? { text: lastError, tone: 'error' } : null;
    const session = response?.session ?? null;
    if (!session) {
      enterView({ kind: 'IDLE' });
      return;
    }
    roomCode = session.meetingCode ?? roomCode;
    enterView(
      session.status === 'RECORDING'
        ? { kind: 'RECORDING', sessionId: session.sessionId, startedAtMs: session.startedAtMs }
        : { kind: 'STARTING' },
    );
  } catch (error) {
    logger.error('could not read recording state', { error: String(error) });
    enterView({ kind: 'IDLE' });
  }
}

async function applyGuard(): Promise<void> {
  const tab = await getActiveTab();
  const actualCode = tab ? extractMeetingCode(tab.url ?? '') : null;
  const guard = evaluateGuard(!!tab && isMeetUrl(tab.url ?? ''), actualCode, undefined);
  if (guard.allowed) {
    guardAllowed = true;
    roomCode = actualCode;
    guardMessage = 'Sẵn sàng ghi tab Meet này.';
    return;
  }
  guardAllowed = false;
  guardMessage =
    guard.reason === 'NOT_MEET_TAB'
      ? 'Mở tab Google Meet của lớp rồi bấm lại vào biểu tượng extension.'
      : `Mã phòng của tab này (${guard.actualCode}) không khớp lớp đã lên lịch. Xác nhận trước khi ghi.`;
}

function guardFailureText(message: Extract<Message, { type: 'GUARD_RESULT' }>): string {
  switch (message.reason) {
    case 'ALREADY_RECORDING':
      return 'Đang có một phiên ghi chạy. Bấm Dừng ghi để kết thúc phiên đó trước.';
    case 'NOT_MEET_TAB':
      return 'Mở tab Google Meet của lớp rồi bấm lại vào biểu tượng extension.';
    case 'MEETING_CODE_MISMATCH':
      return 'Mã phòng của tab này không khớp lớp đã lên lịch.';
    case 'START_FAILED':
      return `Không bắt đầu ghi được: ${message.detail ?? 'lỗi không xác định'}`;
    case 'MIC_PERMISSION_NEEDED':
      return 'Cấp quyền micro ở tab vừa mở, rồi bấm Bắt đầu ghi lại.';
    case 'MIC_PERMISSION_DENIED':
      return 'Quyền micro đang bị chặn. Mở chrome://settings/content/microphone để bỏ chặn rồi thử lại.';
    case 'LOW_DISK':
      return message.detail ?? 'Ổ đĩa sắp đầy — cần giải phóng dung lượng trước khi ghi.';
    case 'BACKLOG_HIGH':
      return (
        message.detail ??
        'Bản ghi cũ tồn đọng quá nhiều, chưa được tải lên — mở Chrome để tự động tải lên rồi thử lại.'
      );
    case undefined:
      return 'Không bắt đầu ghi được.';
    default:
      return assertNever(message.reason);
  }
}

el.start.addEventListener('click', () => {
  void (async () => {
    const tab = await getActiveTab();
    if (!tab) {
      notice = { text: 'Không tìm thấy tab đang mở.', tone: 'error' };
      render();
      return;
    }
    notice = null;
    enterView({ kind: 'STARTING' });
    await browser.runtime.sendMessage({ type: 'START_RECORDING', tabId: tab.id });
  })();
});

el.stop.addEventListener('click', () => {
  void (async () => {
    if (view.kind !== 'RECORDING') return;
    const { sessionId } = view;
    enterView({ kind: 'STOPPING', sessionId });
    // Chỉ gửi tới background. Background là context duy nhất chuyển lệnh dừng
    // vào offscreen, nên không có đường giao thứ hai.
    await browser.runtime.sendMessage({ type: 'STOP_RECORDING', sessionId });
  })();
});

browser.runtime.onMessage.addListener((message: Message) => {
  switch (message.type) {
    case 'AUDIO_LEVEL':
      el.micBar.style.width = `${message.mic}%`;
      el.tabBar.style.width = `${message.tab}%`;
      return;
    case 'AUDIO_ALERT':
      degraded = message.silent;
      notice = message.silent
        ? {
            text:
              message.source === 'mic'
                ? 'Không nghe thấy giọng bạn — kiểm tra micro.'
                : 'Không nghe thấy học sinh — kiểm tra âm thanh tab.',
            tone: 'error',
          }
        : null;
      render();
      return;
    case 'RECORDING_STATE':
      if (message.state === 'RECORDING') {
        notice = null;
        // Không tin elapsedMs của message: rehydrate lấy startedAtMs đã persist,
        // là mốc duy nhất sống sót qua việc đóng/mở popup và cái chết của
        // service worker.
        void rehydrate();
      } else if (message.state === 'FAILED') {
        notice = { text: message.error ?? 'Ghi hình thất bại.', tone: 'error' };
        degraded = false;
        enterView({ kind: 'IDLE' });
      } else if (message.state === 'FINALIZING') {
        notice = { text: 'Đã lưu bản ghi.', tone: 'ok' };
        degraded = false;
        enterView({ kind: 'IDLE' });
      }
      return;
    case 'GUARD_RESULT':
      if (message.allowed) return;
      notice = { text: guardFailureText(message), tone: 'error' };
      enterView({ kind: 'IDLE' });
      if (message.reason === 'ALREADY_RECORDING') {
        // Hiện lại phiên đang chạy để nút Dừng với tới được.
        void rehydrate();
      }
      return;
    // Gửi cho background, offscreen hoặc content script.
    case 'START_RECORDING':
    case 'STOP_RECORDING':
    case 'GET_RECORDING_STATE':
    case 'RECORDING_STARTED':
    case 'RECORDING_STOP':
    case 'GET_MIC_PERMISSION_STATE':
    case 'MIC_MUTE_CHANGED':
    case 'SET_MIC_MUTED':
    case 'STORAGE_GET':
    case 'STORAGE_SET':
    case 'VIDEO_STALLED':
    case 'VIDEO_RECOVERED':
    case 'STORAGE_ALERT':
    case 'RECORDING_ACTIVE':
      return;
    default:
      return assertNever(message);
  }
});

// Popup đóng là bị huỷ hẳn, nhưng clear interval tường minh vẫn đúng và rẻ.
window.addEventListener('unload', stopClock);

void (async () => {
  render();
  await rehydrate();
  await applyGuard();
  render();
})();
```

- [ ] **Step 5: Kiểm tra kiểu, test, build**

Run: `npm run compile && npm test && npm run build`
Expected: cả ba xanh.

- [ ] **Step 6: Kiểm chứng thủ công**

Reload extension.

1. Ở tab YouTube → bấm icon: nút "Bắt đầu ghi" mờ, hiện câu hướng dẫn mở tab Meet, không có đồng hồ, không có thanh mức âm.
2. Ở tab Meet → bấm icon: hiện mã phòng, nút cam sáng.
3. Bắt đầu ghi: chip "ĐANG GHI" cam, đồng hồ đếm từ `00:00`, hai thanh mức âm chạy khi có tiếng, nút chuyển thành "Dừng ghi" viền đỏ.
4. Đóng popup, đợi 30 giây, mở lại: đồng hồ hiện đúng khoảng `00:35`, **không** về `00:00`.
5. Rút micro, đợi ~70 giây: chip chuyển đỏ, hiện dòng "Không nghe thấy giọng bạn".
6. Bấm Dừng ghi: về trạng thái rảnh, hiện "Đã lưu bản ghi" màu xanh.

- [ ] **Step 7: Commit**

```bash
git add src/shared/theme.css entrypoints/popup/index.html entrypoints/popup/style.css entrypoints/popup/main.ts
git commit -m "feat: redesign the popup with an orange theme, elapsed clock and live audio meters"
```

---

### Task 8: Pill trạng thái trong tab Meet

**Files:**
- Create: `src/content-logic/status-pill.ts`
- Modify: `entrypoints/content.ts`

**Interfaces:**
- Consumes: `formatClock` từ Task 4; message `RECORDING_ACTIVE` có `startedAtMs` từ Task 2.
- Produces: `class StatusPill` với `mount(startedAtMs: number): void` · `setWarning(text: string | null): void` · `unmount(): void`.

- [ ] **Step 1: Viết component pill**

Tạo `src/content-logic/status-pill.ts`:

```ts
import { formatClock } from '../core/badge-format';

/**
 * Bản sao của các token trong src/shared/theme.css. Shadow root không kế thừa
 * stylesheet của trang, và content script không nạp được file CSS vào trong
 * shadow root một cách gọn gàng — nên hai nơi phải sửa cùng lúc khi đổi màu.
 */
const COLORS = {
  brand: '#f97316',
  danger: '#dc2626',
  ink: '#1f2937',
  surface: '#ffffff',
} as const;

const HOST_ID = 'onestudy-recorder-pill';

const STYLE = `
  :host { all: initial; }
  .pill {
    position: fixed;
    left: 16px;
    bottom: 16px;
    z-index: 2147483647;
    /* R12: không bao giờ chắn thao tác của giáo viên trong lớp. */
    pointer-events: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 320px;
    padding: 9px 14px;
    border-radius: 999px;
    border: 1px solid ${COLORS.brand};
    background: ${COLORS.surface};
    color: ${COLORS.ink};
    font: 13px/1.35 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.16);
  }
  .pill[data-warn='true'] { border-color: ${COLORS.danger}; border-radius: 14px; }

  .row { display: flex; align-items: center; gap: 8px; white-space: nowrap; }

  .dot {
    width: 8px; height: 8px; flex: none;
    border-radius: 50%;
    background: ${COLORS.brand};
  }
  .pill[data-warn='true'] .dot { background: ${COLORS.danger}; }

  .label { font-weight: 600; letter-spacing: 0.4px; }
  .clock { font-variant-numeric: tabular-nums; }

  .warn { color: ${COLORS.danger}; white-space: normal; }
  .warn:empty { display: none; }
`;

/**
 * Chỉ báo ghi hình trong tab Meet: chấm trạng thái, đồng hồ, và một dòng cảnh
 * báo nở thêm khi có sự cố. Gộp cả cảnh báo vào đây thay vì một banner riêng —
 * một bề mặt, một chỗ vỡ khi Meet đổi giao diện.
 */
export class StatusPill {
  private host: HTMLDivElement | undefined;
  private pill: HTMLDivElement | undefined;
  private clockNode: Text | undefined;
  private warnEl: HTMLDivElement | undefined;
  private intervalId: ReturnType<typeof setInterval> | undefined;

  /**
   * `startedAtMs` đến từ trạng thái phiên mà background persist, không phải từ
   * lúc script này chạy — nên reload tab giữa buổi thì đồng hồ chạy tiếp đúng
   * chứ không nhảy về 0.
   */
  mount(startedAtMs: number): void {
    if (this.host) {
      this.startClock(startedAtMs);
      return;
    }

    const host = document.createElement('div');
    host.id = HOST_ID;
    // Shadow root: CSS của Meet không chọc vào được, kể cả quy tắc !important.
    const root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = STYLE;

    const pill = document.createElement('div');
    pill.className = 'pill';
    pill.dataset.warn = 'false';

    const row = document.createElement('div');
    row.className = 'row';

    const dot = document.createElement('span');
    dot.className = 'dot';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'ĐANG GHI';

    const clock = document.createElement('span');
    clock.className = 'clock';
    const clockNode = document.createTextNode('00:00');
    clock.appendChild(clockNode);

    const warn = document.createElement('div');
    warn.className = 'warn';

    row.append(dot, label, clock);
    pill.append(row, warn);
    root.append(style, pill);
    document.body.appendChild(host);

    this.host = host;
    this.pill = pill;
    this.clockNode = clockNode;
    this.warnEl = warn;

    this.startClock(startedAtMs);
  }

  setWarning(text: string | null): void {
    if (!this.warnEl || !this.pill) return;
    this.warnEl.textContent = text ?? '';
    this.pill.dataset.warn = String(text !== null);
  }

  unmount(): void {
    this.stopClock();
    this.host?.remove();
    this.host = undefined;
    this.pill = undefined;
    this.clockNode = undefined;
    this.warnEl = undefined;
  }

  private startClock(startedAtMs: number): void {
    this.stopClock();
    const tick = (): void => {
      // Chỉ ghi vào text node, không dựng lại cây DOM — và không có quyết định
      // nào nằm ở đây, vì tab nền có thể bị bóp còn 1 lần/phút (R13).
      if (this.clockNode) this.clockNode.data = formatClock(Date.now() - startedAtMs);
    };
    tick();
    this.intervalId = setInterval(tick, 1000);
  }

  private stopClock(): void {
    if (this.intervalId !== undefined) clearInterval(this.intervalId);
    this.intervalId = undefined;
  }
}
```

- [ ] **Step 2: Viết lại `entrypoints/content.ts`**

Thay toàn bộ file. Giữ nguyên `watchMicMuteButton` (kèm cả comment giải thích), bỏ hàm banner và listener `visibilitychange`:

```ts
import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { createLogger } from '@/src/core/logger';
import { assertNever } from '@/src/core/assert';
import { StatusPill } from '@/src/content-logic/status-pill';
import type { Message, RecordingStateResponse } from '@/src/shared/messages';

const logger = createLogger('content');

// Nút mute của chính Meet. `data-is-muted` là thuộc tính trạng thái chức năng,
// không phải chữ hiển thị, nên khác với aria-label (bị dịch — Meet vẽ "Bật
// micrô" hay "Turn on microphone" tuỳ ngôn ngữ tài khoản) nó giữ nguyên bất kể
// ngôn ngữ. Vẫn đúng là loại selector sẽ vỡ khi Google ra bản Meet mới — không
// khác gì sự mong manh của phần phát hiện layout đã nêu ở Task 4.2 — nên cách
// chống cũng như vậy: không tìm thấy thì ghi hình chạy tiếp đúng như hiện tại,
// chỉ là không phát hiện được mute.
const MUTE_BUTTON_SELECTOR = 'button[data-is-muted]';

/**
 * Theo dõi nút mute của Meet, gọi `onChange` mỗi khi trạng thái mute đổi (một
 * lần ngay khi tìm thấy, rồi mỗi lần bật/tắt thật sự).
 *
 * Query lại nút trên từng lần mutation chứ không giữ một tham chiếu element —
 * kiểm chứng trên cuộc gọi Meet thật cho thấy click lần đầu log đúng một lần
 * rồi im, đó là dấu hiệu nút là một node DOM *mới* mỗi lần (SPA re-render tráo
 * element) chứ không phải thuộc tính của cùng một node đổi tại chỗ. Theo dõi
 * document.body cho cả `childList` (node bị tráo) lẫn `attributes`/
 * `data-is-muted` (thuộc tính đổi tại chỗ) phủ được cả hai, mà không cần biết
 * Meet thực sự làm cách nào.
 */
function watchMicMuteButton(onChange: (muted: boolean) => void): void {
  let lastMuted: boolean | undefined;

  function checkAndReport(): void {
    const button = document.querySelector(MUTE_BUTTON_SELECTOR);
    if (!button) return;
    const muted = button.getAttribute('data-is-muted') === 'true';
    if (muted === lastMuted) return;
    lastMuted = muted;
    onChange(muted);
  }

  checkAndReport();
  new MutationObserver(checkAndReport).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-is-muted'],
  });
}

export default defineContentScript({
  matches: ['*://meet.google.com/*'],
  main() {
    logger.info('content script loaded', { url: location.href });

    const pill = new StatusPill();
    let lastKnownMicMuted = false;

    watchMicMuteButton((muted) => {
      lastKnownMicMuted = muted;
      void browser.runtime.sendMessage({ type: 'MIC_MUTE_CHANGED', muted } satisfies Message);
    });

    // Hỏi trạng thái ngay khi nạp, để reload tab giữa buổi không làm mất pill
    // và không làm đồng hồ đếm lại từ đầu.
    void (async () => {
      try {
        const response = await browser.runtime.sendMessage<Message, RecordingStateResponse | undefined>({
          type: 'GET_RECORDING_STATE',
        });
        if (response?.activeForSenderTab && response.session) {
          pill.mount(response.session.startedAtMs);
        }
      } catch (error) {
        logger.debug('could not read recording state', { error: String(error) });
      }
    })();

    browser.runtime.onMessage.addListener((message: Message) => {
      switch (message.type) {
        case 'RECORDING_ACTIVE':
          if (message.active && message.startedAtMs !== null) {
            pill.mount(message.startedAtMs);
            // Mic của offscreen luôn khởi động ở trạng thái không mute bất kể
            // Meet đang thế nào (giáo viên thường mute từ trước khi bấm Bắt
            // đầu) — đồng bộ một lần, ngay lập tức.
            void browser.runtime.sendMessage({
              type: 'MIC_MUTE_CHANGED',
              muted: lastKnownMicMuted,
            } satisfies Message);
          } else {
            pill.unmount();
          }
          return;
        case 'AUDIO_ALERT':
          pill.setWarning(
            message.silent
              ? message.source === 'mic'
                ? '⚠ Không nghe thấy giọng bạn — kiểm tra micro'
                : '⚠ Không nghe thấy học sinh — kiểm tra âm thanh tab'
              : null,
          );
          return;
        case 'VIDEO_STALLED':
          pill.setWarning('⚠ Hình ảnh lớp học có thể đang bị đóng băng — đoạn này có thể không được ghi hình');
          return;
        case 'VIDEO_RECOVERED':
          pill.setWarning(null);
          return;
        case 'STORAGE_ALERT':
          pill.setWarning(
            !message.low
              ? null
              : message.reason === 'LOW_DISK'
                ? '⚠ Ổ đĩa sắp đầy — bản ghi có thể bị mất nếu không giải phóng dung lượng'
                : message.reason === 'BACKLOG_HIGH'
                  ? '⚠ Dữ liệu cũ tồn đọng quá nhiều — hãy mở Chrome để tự động tải lên'
                  : '⚠ Lỗi lưu trữ — bản ghi đang chuyển sang bộ nhớ tạm',
          );
          return;
        // Gửi cho background, popup hoặc offscreen. Content script chỉ nhận
        // được thứ background gửi bằng tabs.sendMessage, nhưng switch vẫn giữ
        // exhaustive để thêm message mới là lỗi biên dịch chứ không phải im
        // lặng bỏ qua.
        case 'START_RECORDING':
        case 'STOP_RECORDING':
        case 'GET_RECORDING_STATE':
        // Script này gửi MIC_MUTE_CHANGED chứ không nhận, và không bao giờ
        // thấy SET_MIC_MUTED (background → offscreen).
        case 'MIC_MUTE_CHANGED':
        case 'SET_MIC_MUTED':
        case 'RECORDING_STARTED':
        case 'RECORDING_STOP':
        case 'GET_MIC_PERMISSION_STATE':
        case 'STORAGE_GET':
        case 'STORAGE_SET':
        case 'RECORDING_STATE':
        case 'AUDIO_LEVEL':
        case 'GUARD_RESULT':
          return;
        default:
          return assertNever(message);
      }
    });
  },
});
```

Thông báo "Bạn đã rời tab lớp học X phút" bị bỏ cùng với `visibilitychange`: rời tab lâu giờ đồng nghĩa lớp kết thúc, và trường hợp đó đã dừng ghi từ Task 2.

- [ ] **Step 3: Kiểm tra kiểu, test, build**

Run: `npm run compile && npm test && npm run build`
Expected: cả ba xanh.

- [ ] **Step 4: Kiểm chứng thủ công**

Reload extension, mở một phòng Meet.

1. Bắt đầu ghi: pill hiện ở góc dưới-trái, chấm cam, chữ "ĐANG GHI", đồng hồ chạy từng giây.
2. Pill không che thanh điều khiển của Meet; rê chuột qua pill vẫn bấm được nút bên dưới nó (`pointer-events: none`).
3. Rút micro, đợi ~70 giây: pill chuyển viền đỏ, chấm đỏ, nở thêm dòng cảnh báo.
4. Cắm lại và nói: dòng cảnh báo biến mất, pill về cam.
5. **Reload tab giữa buổi (F5)**: pill hiện lại, đồng hồ tiếp tục đúng, **không** về `00:00`.
6. Ghi hơn 60 phút (hoặc sửa tạm `startedAtMs` để thử): pill hiện dạng `1:05:30`.
7. Dừng ghi: pill biến mất hẳn khỏi DOM.
8. Đóng tab Meet giữa buổi rồi mở lại một phòng Meet mới: không có pill nào sót lại.

- [ ] **Step 5: Chạy trọn vẹn một lượt hồi quy**

1. Ghi 3 phút ở một phòng Meet có ít nhất 2 người, layout Tiled.
2. Trong lúc ghi: mở popup kiểm tra thanh mức âm, xem badge trên icon, xem pill.
3. Bấm "Kết thúc cuộc gọi".
4. Mở file `.webm` tải về.

Kỳ vọng: video có đủ lưới camera, nghe rõ cả giáo viên lẫn học sinh, file dừng đúng lúc rời cuộc họp, không có đuôi ảnh đơ, badge và pill đều đã biến mất.

- [ ] **Step 6: Commit**

```bash
git add src/content-logic/status-pill.ts entrypoints/content.ts
git commit -m "feat: replace the in-tab warning banner with a shadow-DOM status pill and clock"
```
