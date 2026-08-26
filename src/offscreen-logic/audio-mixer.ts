export interface MixResult {
  mixedStream: MediaStream;
  ctx: AudioContext;
  tabSource: MediaStreamAudioSourceNode;
  micSource: MediaStreamAudioSourceNode;
}

export async function mixTabAndMic(tabStream: MediaStream): Promise<MixResult> {
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

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
