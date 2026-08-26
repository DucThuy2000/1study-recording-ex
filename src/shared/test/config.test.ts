import { describe, it, expect, vi, afterEach } from 'vitest';
import { CONFIG, pickMimeType } from '../config';

describe('CONFIG', () => {
  it('defines the three device tiers from the spec', () => {
    expect(CONFIG.TIERS.LOW.codecs).toEqual(['vp8']);
    expect(CONFIG.TIERS.MID.codecs).toEqual(['vp9', 'vp8']);
    expect(CONFIG.TIERS.HIGH.codecs).toEqual(['vp9', 'vp8']);
  });
});

describe('pickMimeType', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('picks the first supported codec in order', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: (t: string) => t === 'video/webm;codecs=vp8,opus',
    });
    expect(pickMimeType(['vp9', 'vp8'])).toBe('video/webm;codecs=vp8,opus');
  });

  it('falls back to plain video/webm when no codec-specific type is supported', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: (t: string) => t === 'video/webm',
    });
    expect(pickMimeType(['vp9', 'vp8'])).toBe('video/webm');
  });

  it('throws when nothing is supported', () => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => false });
    expect(() => pickMimeType(['vp9'])).toThrow();
  });
});
