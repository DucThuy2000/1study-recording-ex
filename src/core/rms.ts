import { CONFIG } from '../shared/config';

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples.length);
}

export function isSilent(rms: number): boolean {
  return rms < CONFIG.SILENCE_RMS_THRESHOLD;
}

/**
 * RMS → phần trăm cho thanh mức âm. Thang căn bậc hai chứ không tuyến tính:
 * tai người nghe theo lôgarit, và tuyến tính khiến giọng nói bình thường chỉ
 * nhúc nhích được vài phần trăm ở đáy thanh.
 */
export function levelToPercent(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const normalized = Math.min(rms / CONFIG.LEVEL_CEILING_RMS, 1);
  return Math.round(Math.sqrt(normalized) * 100);
}
