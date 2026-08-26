import { describe, it, expect } from 'vitest';
import { evaluateGuard } from '../tab-guard';

describe('evaluateGuard', () => {
  it('allows a Meet tab with a valid code when there is no scheduled code to check', () => {
    expect(evaluateGuard(true, 'abc-defg-hij', undefined)).toEqual({ allowed: true });
  });

  it('blocks a non-Meet tab', () => {
    expect(evaluateGuard(false, null, undefined)).toEqual({ allowed: false, reason: 'NOT_MEET_TAB' });
  });

  it('blocks a Meet URL with no extractable code', () => {
    expect(evaluateGuard(true, null, undefined)).toEqual({ allowed: false, reason: 'NOT_MEET_TAB' });
  });

  it('blocks when the actual code does not match the scheduled code', () => {
    expect(evaluateGuard(true, 'abc-defg-hij', 'xyz-wxyz-xyz')).toEqual({
      allowed: false,
      reason: 'MEETING_CODE_MISMATCH',
      actualCode: 'abc-defg-hij',
    });
  });

  it('allows when the actual code matches the scheduled code', () => {
    expect(evaluateGuard(true, 'abc-defg-hij', 'abc-defg-hij')).toEqual({ allowed: true });
  });
});
