import { CONFIG, type TierName } from '../shared/config';

export interface DeviceHints {
  hardwareConcurrency: number;
  deviceMemoryGb: number | undefined;
}

export function pickDeviceTier(hints: DeviceHints): TierName {
  const { hardwareConcurrency, deviceMemoryGb } = hints;
  const { lowMaxCores, lowMaxMemoryGb, highMinCores, highMinMemoryGb } = CONFIG.DEVICE_TIER_THRESHOLDS;
  // A confirmed low-memory reading is always LOW, even before defaulting.
  if (hardwareConcurrency <= lowMaxCores || (deviceMemoryGb !== undefined && deviceMemoryGb <= lowMaxMemoryGb)) {
    return 'LOW';
  }
  // navigator.deviceMemory is unsupported in some browsers; treat "unknown" as
  // the low/mid boundary so a missing reading can't be mistaken for a HIGH-tier device.
  const memory = deviceMemoryGb ?? lowMaxMemoryGb;
  if (hardwareConcurrency >= highMinCores && memory >= highMinMemoryGb) return 'HIGH';
  return 'MID';
}
