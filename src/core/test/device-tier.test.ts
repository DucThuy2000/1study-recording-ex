import { describe, it, expect } from 'vitest';
import { pickDeviceTier } from '../device-tier';

describe('pickDeviceTier', () => {
  it('is LOW when concurrency is at or below 4', () => {
    expect(pickDeviceTier({ hardwareConcurrency: 4, deviceMemoryGb: 8 })).toBe('LOW');
  });

  it('is LOW when memory is at or below 4GB even with many cores', () => {
    expect(pickDeviceTier({ hardwareConcurrency: 16, deviceMemoryGb: 4 })).toBe('LOW');
  });

  it('is HIGH only when both concurrency >= 8 and memory >= 8', () => {
    expect(pickDeviceTier({ hardwareConcurrency: 8, deviceMemoryGb: 8 })).toBe('HIGH');
  });

  it('is MID when it is neither the LOW nor the HIGH case', () => {
    expect(pickDeviceTier({ hardwareConcurrency: 6, deviceMemoryGb: 8 })).toBe('MID');
    expect(pickDeviceTier({ hardwareConcurrency: 8, deviceMemoryGb: 6 })).toBe('MID');
  });

  it('treats missing deviceMemory as 4GB, not as automatically LOW', () => {
    expect(pickDeviceTier({ hardwareConcurrency: 6, deviceMemoryGb: undefined })).toBe('MID');
  });
});
