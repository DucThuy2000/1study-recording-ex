import { describe, it, expect } from 'vitest';
import { computeRms, isSilent, SILENCE_RMS_THRESHOLD } from '../rms';

describe('computeRms', () => {
  it('is zero for silence', () => {
    expect(computeRms(new Float32Array([0, 0, 0, 0]))).toBe(0);
  });

  it('computes the root-mean-square of the samples', () => {
    const samples = new Float32Array([1, -1, 1, -1]);
    expect(computeRms(samples)).toBeCloseTo(1, 5);
  });

  it('returns 0 for an empty buffer instead of NaN', () => {
    expect(computeRms(new Float32Array([]))).toBe(0);
  });
});

describe('isSilent', () => {
  it('is true below the threshold', () => {
    expect(isSilent(SILENCE_RMS_THRESHOLD / 2)).toBe(true);
  });

  it('is false at or above the threshold', () => {
    expect(isSilent(SILENCE_RMS_THRESHOLD)).toBe(false);
    expect(isSilent(SILENCE_RMS_THRESHOLD * 2)).toBe(false);
  });
});
