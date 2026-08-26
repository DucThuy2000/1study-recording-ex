import type { TierName } from '../shared/config';

export interface DeviceHints {
  hardwareConcurrency: number;
  deviceMemoryGb: number | undefined;
}

export function pickDeviceTier(hints: DeviceHints): TierName {
  const { hardwareConcurrency, deviceMemoryGb } = hints;
  // A confirmed low-memory reading is always LOW, even before defaulting.
  if (hardwareConcurrency <= 4 || (deviceMemoryGb !== undefined && deviceMemoryGb <= 4)) {
    return 'LOW';
  }
  // navigator.deviceMemory is unsupported in some browsers; treat "unknown" as
  // the 4GB midpoint so a missing reading can't be mistaken for a HIGH-tier device.
  const memory = deviceMemoryGb ?? 4;
  if (hardwareConcurrency >= 8 && memory >= 8) return 'HIGH';
  return 'MID';
}
