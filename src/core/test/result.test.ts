import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr } from '../result';

describe('Result', () => {
  it('ok() produces a value result recognized by isOk', () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (isOk(r)) expect(r.value).toBe(42);
  });

  it('err() produces an error result recognized by isErr', () => {
    const r = err('boom');
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
    if (isErr(r)) expect(r.error).toBe('boom');
  });
});
