import { describe, it, expect } from 'vitest';
import { assertNever } from './assert-never';

describe('assertNever', () => {
  it('throws with the unhandled value in the message', () => {
    // @ts-expect-error: deliberately calling with a non-never value to test the runtime guard
    expect(() => assertNever({ type: 'UNEXPECTED' })).toThrow(/UNEXPECTED/);
  });
});
