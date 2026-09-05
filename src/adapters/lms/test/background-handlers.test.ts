import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import background from "@/entrypoints/background";
import type {
  ActiveSessionInfo,
  Message,
  MessageOf,
  LmsGuardResult,
} from "@/src/shared/messages";

describe("background LMS handlers", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers listeners when background main is called", () => {
    expect(typeof background.main).toBe("function");
    background.main();
  });

  it("handles LMS_GET_CONTEXT and replies via sendResponse", async () => {
    background.main();

    const mockContext = {
      classroomId: 999,
      className: "Math 101",
      scheduledStart: Math.floor(Date.now() / 1000) - 60,
      scheduledEnd: Math.floor(Date.now() / 1000) + 3600,
      classroomStatus: 1,
      sesskey: "mock-sesskey",
      recording: null,
      materials: [],
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: mockContext }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = (await fakeBrowser.runtime.sendMessage({
      type: "LMS_GET_CONTEXT",
      meetingCode: "abc-defg-hij",
    })) as LmsGuardResult;

    expect(result).toBeDefined();
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.context.classroomId).toBe(999);
      expect(result.context.className).toBe("Math 101");
    }
  });

  it("handles LMS_END_CLASS and replies via sendResponse", async () => {
    background.main();

    await fakeBrowser.storage.local.set({
      lmsCachedContext: {
        meetingCode: "abc-defg-hij",
        classroomId: 777,
        className: "Science 101",
        scheduledStart: 1000,
        scheduledEnd: 2000,
        classroomStatus: 1,
        materials: [],
        cachedAtMs: Date.now(),
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: { classroomId: 777, classroomStatus: 2 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = (await fakeBrowser.runtime.sendMessage({
      type: "LMS_END_CLASS",
    })) as { success: boolean };

    expect(result).toEqual({ success: true });

    const stored = await fakeBrowser.storage.local.get("lmsCachedContext");
    expect(stored.lmsCachedContext).toBeUndefined();
  });

  it("refuses START_RECORDING when tab is not a Meet URL", async () => {
    background.main();

    const tab = await fakeBrowser.tabs.create({ url: "https://example.com" });

    let receivedGuardResult: MessageOf<"GUARD_RESULT"> | undefined;
    fakeBrowser.runtime.onMessage.addListener((msg: Message) => {
      if (msg.type === "GUARD_RESULT") {
        receivedGuardResult = msg;
      }
      return false;
    });

    await fakeBrowser.runtime.sendMessage({
      type: "START_RECORDING",
      tabId: tab.id!,
    });

    // Wait a tick for async handleStart to execute
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(receivedGuardResult).toEqual({
      type: "GUARD_RESULT",
      allowed: false,
      reason: "NOT_MEET_TAB",
      detail: undefined,
    });
  });

  it("refuses START_RECORDING when LMS guard returns OUTSIDE_SCHEDULE", async () => {
    background.main();

    const tab = await fakeBrowser.tabs.create({
      url: "https://meet.google.com/abc-defg-hij",
    });

    const mockContext = {
      classroomId: 999,
      className: "Math 101",
      scheduledStart: Math.floor(Date.now() / 1000) + 7200, // 2 hours later
      scheduledEnd: Math.floor(Date.now() / 1000) + 10800,
      classroomStatus: 1,
      sesskey: "mock-sesskey",
      recording: null,
      materials: [],
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: mockContext }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    let receivedGuardResult: MessageOf<"GUARD_RESULT"> | undefined;
    fakeBrowser.runtime.onMessage.addListener((msg: Message) => {
      if (msg.type === "GUARD_RESULT") {
        receivedGuardResult = msg;
      }
      return false;
    });

    await fakeBrowser.runtime.sendMessage({
      type: "START_RECORDING",
      tabId: tab.id!,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(receivedGuardResult).toEqual({
      type: "GUARD_RESULT",
      allowed: false,
      reason: "OUTSIDE_SCHEDULE",
      detail: "Buổi học chưa bắt đầu hoặc đã kết thúc.",
    });
  });

  it("proceeds with START_RECORDING and attaches classroomId when LMS guard allows", async () => {
    background.main();

    const tab = await fakeBrowser.tabs.create({
      url: "https://meet.google.com/abc-defg-hij",
    });

    const nowSec = Math.floor(Date.now() / 1000);
    const mockContext = {
      classroomId: 888,
      className: "Physics 101",
      scheduledStart: nowSec - 60,
      scheduledEnd: nowSec + 3600,
      classroomStatus: 1,
      sesskey: "mock-sesskey",
      recording: null,
      materials: [],
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: mockContext }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    // Mock storage estimate
    Object.defineProperty(navigator, "storage", {
      value: {
        estimate: vi.fn().mockResolvedValue({
          quota: 10_000_000_000,
          usage: 1_000_000,
        }),
      },
      configurable: true,
    });

    // Mock offscreen and tabCapture
    vi.spyOn(fakeBrowser.offscreen, "hasDocument").mockImplementation(
      async () => true,
    );
    vi.spyOn(fakeBrowser.offscreen, "createDocument").mockImplementation(
      async () => undefined,
    );
    vi.spyOn(fakeBrowser.tabCapture, "getMediaStreamId").mockImplementation(
      async () => "mock-stream-id",
    );

    // Mock mic state response
    fakeBrowser.runtime.onMessage.addListener(
      (msg: Message, _sender, sendResponse) => {
        if (msg.type === "GET_MIC_PERMISSION_STATE") {
          sendResponse({ state: "granted" });
          return true;
        }
        return false;
      },
    );

    await fakeBrowser.runtime.sendMessage({
      type: "START_RECORDING",
      tabId: tab.id!,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const stored = (await fakeBrowser.storage.local.get("activeSession")) as {
      activeSession?: ActiveSessionInfo;
    };
    expect(stored.activeSession).toBeDefined();
    expect(stored.activeSession?.classroomId).toBe(888);
    expect(stored.activeSession?.meetingCode).toBe("abc-defg-hij");
    expect(stored.activeSession?.status).toBe("STARTING");
  });
});
