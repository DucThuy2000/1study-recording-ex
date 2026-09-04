import { computeRms, isSilent } from "../shared/utils";
import { SilenceTracker, type SilenceEvent } from "../core/silence-tracker";
import { CONFIG } from "../shared/config";

export class AudioLevelMonitor {
  private readonly analyser: AnalyserNode;
  private readonly buffer: Float32Array<ArrayBuffer>;
  private readonly tracker: SilenceTracker;
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private levelIntervalId: ReturnType<typeof setInterval> | undefined;

  constructor(
    ctx: AudioContext,
    source: MediaStreamAudioSourceNode,
    private readonly onEvent: (event: SilenceEvent) => void,
    private readonly onLevel?: (rms: number) => void,
  ) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buffer = new Float32Array(this.analyser.fftSize);
    source.connect(this.analyser);
    this.tracker = new SilenceTracker(
      CONFIG.SILENCE_ALERT_SECONDS,
      CONFIG.SILENCE_CHECK_INTERVAL_SECONDS,
    );
  }

  private sample(): number {
    this.analyser.getFloatTimeDomainData(this.buffer);
    return computeRms(this.buffer);
  }

  start(): void {
    this.intervalId = setInterval(() => {
      const event = this.tracker.observe(isSilent(this.sample()));
      if (event !== "NONE") this.onEvent(event);
    }, CONFIG.SILENCE_CHECK_INTERVAL_SECONDS * 1000);

    const onLevel = this.onLevel;
    if (!onLevel) return;
    this.levelIntervalId = setInterval(
      () => onLevel(this.sample()),
      CONFIG.LEVEL_SAMPLE_MS,
    );
  }

  stop(): void {
    if (this.intervalId !== undefined) clearInterval(this.intervalId);
    if (this.levelIntervalId !== undefined) clearInterval(this.levelIntervalId);
    this.intervalId = undefined;
    this.levelIntervalId = undefined;
  }
}
