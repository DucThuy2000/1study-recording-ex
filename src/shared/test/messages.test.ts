import { describe, it, expect } from "vitest";
import type { Message, MessageOf, GuardFailureReason, LmsGuardResult } from "../messages";

describe("messages", () => {
  it("supports LMS_GET_CONTEXT message", () => {
    const msg: MessageOf<"LMS_GET_CONTEXT"> = {
      type: "LMS_GET_CONTEXT",
      meetingCode: "abc-defg-hij",
    };
    const genericMsg: Message = msg;
    expect(genericMsg.type).toBe("LMS_GET_CONTEXT");
    if (genericMsg.type === "LMS_GET_CONTEXT") {
      expect(genericMsg.meetingCode).toBe("abc-defg-hij");
    }
  });

  it("supports LMS_END_CLASS message", () => {
    const msg: MessageOf<"LMS_END_CLASS"> = {
      type: "LMS_END_CLASS",
    };
    const genericMsg: Message = msg;
    expect(genericMsg.type).toBe("LMS_END_CLASS");
  });

  it("allows all GuardFailureReason variants", () => {
    const reasons: GuardFailureReason[] = [
      "NOT_MEET_TAB",
      "NOT_LOGGED_IN",
      "NO_ACTIVE_CLASS",
      "NOT_YOUR_CLASS",
      "OUTSIDE_SCHEDULE",
      "NETWORK_ERROR",
      "ALREADY_RECORDING",
      "START_FAILED",
      "MIC_PERMISSION_DENIED",
      "MIC_PERMISSION_NEEDED",
      "LOW_DISK",
      "BACKLOG_HIGH",
    ];

    expect(reasons).toHaveLength(12);
    for (const reason of reasons) {
      const guardMsg: Message = {
        type: "GUARD_RESULT",
        allowed: false,
        reason,
      };
      expect(guardMsg.type).toBe("GUARD_RESULT");
    }
  });

  it("exports LmsGuardResult type", () => {
    const allowedResult: LmsGuardResult = {
      allowed: true,
      context: {
        meetingCode: "abc-defg-hij",
        classroomId: 123,
        className: "Math 101",
        scheduledStart: 1000,
        scheduledEnd: 2000,
        classroomStatus: 1,
        materials: [],
        cachedAtMs: 1234567,
      },
    };
    expect(allowedResult.allowed).toBe(true);

    const rejectedResult: LmsGuardResult = {
      allowed: false,
      reason: "NOT_LOGGED_IN",
      detail: "Session expired",
    };
    expect(rejectedResult.allowed).toBe(false);
  });

  it("supports ActiveSessionInfo with classroomId", () => {
    const session: import("../messages").ActiveSessionInfo = {
      sessionId: "session-123",
      tabId: 1,
      meetingCode: "abc-defg-hij",
      status: "STARTING",
      startedAtMs: 123456,
      classroomId: 456,
    };
    expect(session.classroomId).toBe(456);
  });
});
