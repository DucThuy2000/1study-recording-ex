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

  const onFrameCallback = () => {
    const event = detector.onFrame();
    if (event) onEvent(event);
    video.requestVideoFrameCallback(onFrameCallback);
  };
  video.requestVideoFrameCallback(onFrameCallback);

  const intervalId = setInterval(() => {
    const event = detector.checkForStall();
    if (event) onEvent(event);
  }, CONFIG.FRAME_MONITOR_POLL_MS);

  return () => {
    clearInterval(intervalId);
    video.pause();
    video.srcObject = null;
  };
}
