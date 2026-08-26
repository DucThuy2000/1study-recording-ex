export type SilenceEvent = 'ALERT' | 'RECOVERED' | 'NONE';

export class SilenceTracker {
  private silentSeconds = 0;
  private alerting = false;

  constructor(
    private readonly alertAfterSeconds: number,
    private readonly windowSeconds: number,
  ) {}

  observe(silent: boolean): SilenceEvent {
    if (silent) {
      this.silentSeconds += this.windowSeconds;
      if (!this.alerting && this.silentSeconds >= this.alertAfterSeconds) {
        this.alerting = true;
        return 'ALERT';
      }
      return 'NONE';
    }
    this.silentSeconds = 0;
    if (this.alerting) {
      this.alerting = false;
      return 'RECOVERED';
    }
    return 'NONE';
  }
}
