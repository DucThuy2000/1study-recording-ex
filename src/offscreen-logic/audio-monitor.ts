import { computeRms, isSilent } from '../core/rms';
import { SilenceTracker, type SilenceEvent } from '../core/silence-tracker';
import { CONFIG } from '../shared/config';

export class AudioLevelMonitor {
  private readonly analyser: AnalyserNode;
  private readonly buffer: Float32Array<ArrayBuffer>;
  private readonly tracker: SilenceTracker;
  private intervalId: ReturnType<typeof setInterval> | undefined;

  constructor(
    ctx: AudioContext,
    source: MediaStreamAudioSourceNode,
    private readonly onEvent: (event: SilenceEvent) => void,
  ) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buffer = new Float32Array(this.analyser.fftSize);
    source.connect(this.analyser);
    this.tracker = new SilenceTracker(CONFIG.SILENCE_ALERT_SECONDS, CONFIG.SILENCE_CHECK_INTERVAL_SECONDS);
  }

  start(): void {
    this.intervalId = setInterval(() => {
      this.analyser.getFloatTimeDomainData(this.buffer);
      const rms = computeRms(this.buffer);
      const event = this.tracker.observe(isSilent(rms));
      if (event !== 'NONE') this.onEvent(event);
    }, CONFIG.SILENCE_CHECK_INTERVAL_SECONDS * 1000);
  }

  stop(): void {
    if (this.intervalId !== undefined) clearInterval(this.intervalId);
  }
}
