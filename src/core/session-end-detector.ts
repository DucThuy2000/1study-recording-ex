import type { ActiveSessionInfo } from "../shared/messages";
import { extractMeetingCode } from "./meeting-code";

export type SessionEndReason = "TAB_CLOSED" | "MEETING_LEFT" | "USER_STOPPED";

export function evaluateTabRemoved(
  active: ActiveSessionInfo | null,
  closedTabId: number,
): SessionEndReason | null {
  if (!active) return null;
  return active.tabId === closedTabId ? "TAB_CLOSED" : null;
}

export function evaluateTabUrlChange(
  active: ActiveSessionInfo | null,
  tabId: number,
  newUrl: string | undefined,
): SessionEndReason | null {
  if (!active || active.tabId !== tabId) return null;
  if (!active.meetingCode) return null;
  if (newUrl === undefined) return null;
  return extractMeetingCode(newUrl) === active.meetingCode
    ? null
    : "MEETING_LEFT";
}
