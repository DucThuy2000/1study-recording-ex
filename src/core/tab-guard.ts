export type GuardResult =
  | { allowed: true }
  | { allowed: false; reason: "NOT_MEET_TAB" }
  | { allowed: false; reason: "MEETING_CODE_MISMATCH"; actualCode: string };

export function evaluateGuard(
  isMeet: boolean,
  actualCode: string | null,
  scheduledCode: string | undefined,
): GuardResult {
  if (!isMeet || !actualCode) return { allowed: false, reason: "NOT_MEET_TAB" };
  if (scheduledCode && actualCode !== scheduledCode) {
    return { allowed: false, reason: "MEETING_CODE_MISMATCH", actualCode };
  }
  return { allowed: true };
}
