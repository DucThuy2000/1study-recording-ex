import { describe, it, expect } from 'vitest';
import { computeRms, isSilent, levelToPercent } from '../rms';
import { CONFIG } from '../../shared/config';

const SILENCE_RMS_THRESHOLD = CONFIG.SILENCE_RMS_THRESHOLD;

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
    expect(levelToPercent(SILENCE_RMS_THRESHOLD)).toBeGreaterThan(15);
  });

  it('never returns a value outside 0-100', () => {
    for (const rms of [0, 0.001, 0.05, 0.25, 1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const percent = levelToPercent(rms);
      expect(percent).toBeGreaterThanOrEqual(0);
      expect(percent).toBeLessThanOrEqual(100);
    }
  });
});
