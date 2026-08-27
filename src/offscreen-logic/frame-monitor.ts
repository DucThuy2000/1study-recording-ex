import { StallDetector, type StallEvent } from '../core/stall-detector';
import { CONFIG } from '../shared/config';

/**
 * Watches a media stream's video track for frame stalls (R13). Runs a hidden
 * <video> element to receive `requestVideoFrameCallback` ticks, plus a
 * `CONFIG.FRAME_MONITOR_POLL_MS` `setInterval` (safe here because this runs
 * inside the offscreen document,
 * which Chrome does not throttle the way it throttles backgrounded tabs) to
 * catch a stall that's already in progress even if no frame ever arrives to
 * trigger `onFrame`.
 */
export function startFrameMonitor(stream: MediaStream, onEvent: (event: StallEvent) => void): () => void {
  const video = document.createElement('video');
  video.srcObject = new MediaStream([stream.getVideoTracks()[0]!]);
  video.muted = true;
  void video.play();

  const detector = new StallDetector(CONFIG.STALL_GAP_MS, () => Date.now());
  let intervalId: ReturnType<typeof setInterval> | undefined;

  const onFrameCallback = () => {
    const event = detector.onFrame();
    if (event) onEvent(event);
    if (intervalId === undefined) {
      // Deliberately not started until the *first* real frame has arrived.
      // Decoding the very first frame of a fresh tabCapture MediaStream has
      // its own warm-up latency (observed: a few seconds), and the detector's
      // clock starts ticking at construction time, before any frame exists —
      // starting this check immediately reads that warm-up gap as a stall
      // that never actually happened, every single time.
      intervalId = setInterval(() => {
        const stallEvent = detector.checkForStall();
        if (stallEvent) onEvent(stallEvent);
      }, CONFIG.FRAME_MONITOR_POLL_MS);
    }
    video.requestVideoFrameCallback(onFrameCallback);
  };
  video.requestVideoFrameCallback(onFrameCallback);

  return () => {
    if (intervalId !== undefined) clearInterval(intervalId);
    video.pause();
    video.srcObject = null;
  };
}
