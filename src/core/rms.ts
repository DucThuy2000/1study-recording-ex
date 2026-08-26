export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples.length);
}

export const SILENCE_RMS_THRESHOLD = 0.01;

export function isSilent(rms: number): boolean {
  return rms < SILENCE_RMS_THRESHOLD;
}
