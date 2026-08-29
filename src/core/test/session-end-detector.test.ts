import { describe, it, expect } from "vitest";
import {
  evaluateTabRemoved,
  evaluateTabUrlChange,
} from "../session-end-detector";
import type { ActiveSessionInfo } from "../../shared/messages";

function session(
  overrides: Partial<ActiveSessionInfo> = {},
): ActiveSessionInfo {
  return {
    sessionId: "s1",
    tabId: 42,
    meetingCode: "abc-defg-hij",
    status: "RECORDING",
    startedAtMs: 0,
    ...overrides,
  };
}

describe("evaluateTabRemoved", () => {
  it("ends the session when the recorded tab is the one closed", () => {
    expect(evaluateTabRemoved(session(), 42)).toBe("TAB_CLOSED");
  });

  it("ignores another tab closing", () => {
    expect(evaluateTabRemoved(session(), 99)).toBeNull();
  });

  it("ignores everything when no session is active", () => {
    expect(evaluateTabRemoved(null, 42)).toBeNull();
  });

  it("still fires for a pre-upgrade session that has no meetingCode", () => {
    const legacy = {
      ...session(),
      meetingCode: undefined,
    } as unknown as ActiveSessionInfo;
    expect(evaluateTabRemoved(legacy, 42)).toBe("TAB_CLOSED");
  });
});

describe("evaluateTabUrlChange", () => {
  it("ends the session when the URL leaves the recorded meeting code", () => {
    expect(
      evaluateTabUrlChange(session(), 42, "https://meet.google.com/"),
    ).toBe("MEETING_LEFT");
  });

  it("ends the session when the tab navigates off Meet entirely", () => {
    expect(evaluateTabUrlChange(session(), 42, "https://www.google.com/")).toBe(
      "MEETING_LEFT",
    );
  });

  it("ends the session when the URL moves to a different meeting", () => {
    expect(
      evaluateTabUrlChange(
        session(),
        42,
        "https://meet.google.com/zzz-zzzz-zzz",
      ),
    ).toBe("MEETING_LEFT");
  });

  it("keeps recording when the URL changes but the meeting code is unchanged", () => {
    expect(
      evaluateTabUrlChange(
        session(),
        42,
        "https://meet.google.com/abc-defg-hij?authuser=1",
      ),
    ).toBeNull();
  });

  it("ignores a URL change in a tab that is not the one being recorded", () => {
    expect(
      evaluateTabUrlChange(session(), 99, "https://www.google.com/"),
    ).toBeNull();
  });

  it("ignores an onUpdated event that carried no URL", () => {
    expect(evaluateTabUrlChange(session(), 42, undefined)).toBeNull();
  });

  it("ignores everything when no session is active", () => {
    expect(
      evaluateTabUrlChange(null, 42, "https://www.google.com/"),
    ).toBeNull();
  });

  it("refuses to conclude anything for a pre-upgrade session with no meetingCode", () => {
    const legacy = {
      ...session(),
      meetingCode: undefined,
    } as unknown as ActiveSessionInfo;
    expect(
      evaluateTabUrlChange(legacy, 42, "https://www.google.com/"),
    ).toBeNull();
  });
});

/** MutationObserver delivers asynchronously; let the microtask queue drain. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
