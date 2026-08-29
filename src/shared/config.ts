export const CONFIG = {
  CHUNK_MS: 5000,
  UPLOAD_RATE_IN_CLASS_BPS: 900_000,
  UPLOAD_RATE_MAX_BPS: 1_500_000,
  DISK_MIN_FREE_BYTES: 3 * 1024 ** 3,
  BACKLOG_MAX_BYTES: 5 * 1024 ** 3,
  DISK_CHECK_INTERVAL_MS: 60_000,
  SILENCE_ALERT_SECONDS: 60,
  SILENCE_CHECK_INTERVAL_SECONDS: 10,
  HEARTBEAT_INTERVAL_MS: 30_000,
  MEMORY_BUFFER_MAX_BYTES: 200 * 1024 ** 2,
  AUDIO_BITRATE: 64_000,
  STALL_GAP_MS: 3000,
  FRAME_MONITOR_POLL_MS: 1000,
  SILENCE_RMS_THRESHOLD: 0.01,
  LEVEL_SAMPLE_MS: 250,
  /**
   * Trần RMS ánh xạ thành 100% trên thanh mức âm. Giọng nói bình thường qua
   * micro có xử lý nằm khoảng 0.01–0.25; lấy trần cao hơn nữa thì thanh dính
   * đáy và giáo viên tưởng máy không nghe thấy mình.
   */
  LEVEL_CEILING_RMS: 0.25,
  EVENT_QUEUE_MAX_PENDING: 500,
  STARTING_ACK_TIMEOUT_MS: 15_000,
  BADGE_TICK_ALARM_MINUTES: 1,
  BADGE_COLOR_RECORDING: "#F97316",
  BADGE_COLOR_DEGRADED: "#DC2626",
  DEVICE_TIER_THRESHOLDS: {
    lowMaxCores: 4,
    lowMaxMemoryGb: 4,
    highMinCores: 8,
    highMinMemoryGb: 8,
  },
  TIERS: {
    LOW: {
      width: 854,
      height: 480,
      fps: 12,
      bitrate: 600_000,
      codecs: ["vp8"],
    },
    MID: {
      width: 1280,
      height: 720,
      fps: 15,
      bitrate: 1_200_000,
      codecs: ["vp9", "vp8"],
    },
    HIGH: {
      width: 1280,
      height: 720,
      fps: 24,
      bitrate: 1_800_000,
      codecs: ["vp9", "vp8"],
    },
  },
} as const;

export type TierName = keyof typeof CONFIG.TIERS;

export function pickMimeType(codecs: readonly string[]): string {
  const candidates = [
    ...codecs.map((c) => `video/webm;codecs=${c},opus`),
    "video/webm",
  ];
  const found = candidates.find((t) => MediaRecorder.isTypeSupported(t));
  if (!found) throw new Error("No supported WebM codec found");
  return found;
}
