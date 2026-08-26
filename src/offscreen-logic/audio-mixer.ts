export interface MixResult {
  mixedStream: MediaStream;
  ctx: AudioContext;
  tabSource: MediaStreamAudioSourceNode;
  micSource: MediaStreamAudioSourceNode;
}

/**
 * Thrown when the teacher's microphone can't be opened. An offscreen document
 * has no visible surface, so it can never show the permission prompt itself —
 * a denied or missing grant here is a hard start failure that has to be
 * surfaced in the popup, not an unhandled rejection (R4/R6).
 */
export class MicrophoneAccessError extends Error {
  constructor(override readonly cause: unknown) {
    super(MicrophoneAccessError.describe(cause));
    this.name = 'MicrophoneAccessError';
  }

  private static describe(cause: unknown): string {
    const name = cause instanceof Error ? cause.name : '';
    switch (name) {
      case 'NotAllowedError':
        return 'Microphone access was denied. Open the extension popup and allow the microphone, then start again.';
      case 'NotFoundError':
        return 'No microphone was found. Plug in a headset or microphone, then start again.';
      case 'NotReadableError':
        return 'The microphone is in use by another application. Close it, then start again.';
      default:
        return `Could not open the microphone: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
}

async function openMicStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (error) {
    throw new MicrophoneAccessError(error);
  }
}

export async function mixTabAndMic(tabStream: MediaStream): Promise<MixResult> {
  const micStream = await openMicStream();

  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const tabSource = ctx.createMediaStreamSource(tabStream);
  const micSource = ctx.createMediaStreamSource(micStream);

  const tabGain = ctx.createGain();
  tabGain.gain.value = 1.0;
  const micGain = ctx.createGain();
  micGain.gain.value = 1.0;

  tabSource.connect(tabGain).connect(dest);
  micSource.connect(micGain).connect(dest);
  tabSource.connect(ctx.destination); // required so the teacher still hears students (R4/R5)

  const mixedStream = new MediaStream([tabStream.getVideoTracks()[0]!, dest.stream.getAudioTracks()[0]!]);

  return { mixedStream, ctx, tabSource, micSource };
}
