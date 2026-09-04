/**
 * Shared util functions that is shared using for all contexts (background, popup, content, offscreen..)
 * These functions are cheap, no need to create multiple files, separate them multiple places.
 */

import { CONFIG } from "./config";

// === CONSTANTS
const MEET_URL_PATTERN =
  /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#].*)?$/i;
const MEET_URL_PREFIX = "https://meet.google.com/";

// Meeting extraction
export const extractMeetingCode = (url: string) => {
  const match = MEET_URL_PATTERN.exec(url);
  const code = match?.[1]; // e.g: abc-xyz-iop
  return code ? code.toLocaleLowerCase() : null;
};

export const isMeetUrl = (url: string) => url.startsWith(MEET_URL_PREFIX);

// Audio
export const computeRms = (samples: Float32Array) => {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples.length);
};

export const isSilent = (rms: number) => {
  return rms < CONFIG.SILENCE_RMS_THRESHOLD;
};

export const levelToPercent = (rms: number) => {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const normalized = Math.min(rms / CONFIG.LEVEL_CEILING_RMS, 1);
  return Math.round(Math.sqrt(normalized) * 100);
};
