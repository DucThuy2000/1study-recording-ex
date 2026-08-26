import { browser } from 'wxt/browser';
import type { Message } from '@/src/shared/messages';
import { SessionRecorder } from '@/src/offscreen-logic/recorder';
import { createLogger } from '@/src/core/logger';
import { SessionStateMachine } from '@/src/core/state-machine';
import { ChromeStorageAdapter } from '@/src/adapters/storage';

const logger = createLogger('offscreen');
let activeRecorder: SessionRecorder | undefined;
let activeSessionId: string | undefined;
let activeStateMachine: SessionStateMachine | undefined;

async function openTabStream(streamId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  } as MediaStreamConstraints);
}

function playTabAudioLocally(stream: MediaStream): void {
  // Without this, tabCapture silently stops the tab's audio from reaching the
  // teacher's speakers — they'd be recording a class they can no longer hear (R4/R5).
  const ctx = new AudioContext();
  ctx.createMediaStreamSource(stream).connect(ctx.destination);
}

function triggerDownload(blob: Blob, sessionId: string): void {
  // Task-0.2 smoke-test aid only; replaced by OPFS-session + upload in Phase 1/2.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sessionId}.webm`;
  a.click();
  URL.revokeObjectURL(url);
}

browser.runtime.onMessage.addListener((message: Message) => {
  if (message.type === 'RECORDING_STARTED') {
    void (async () => {
      const stream = await openTabStream(message.streamId);
      playTabAudioLocally(stream);
      activeSessionId = message.sessionId;
      activeStateMachine = new SessionStateMachine(message.sessionId, new ChromeStorageAdapter(), logger);
      await activeStateMachine.transition('READY', 'preflight ok');
      await activeStateMachine.transition('RECORDING', 'start');
      activeRecorder = new SessionRecorder(message.sessionId, stream, message.tier);
      activeRecorder.start();
      logger.info('offscreen recording started', { sessionId: message.sessionId });
    })();
  }
  if (message.type === 'STOP_RECORDING' && activeRecorder && activeSessionId === message.sessionId) {
    void (async () => {
      const blob = await activeRecorder!.stop();
      triggerDownload(blob, message.sessionId);
      await activeStateMachine?.transition('FINALIZING', 'stop requested');
      activeStateMachine = undefined;
      activeRecorder = undefined;
      activeSessionId = undefined;
      logger.info('offscreen recording stopped, file downloaded', { sessionId: message.sessionId });
      await chrome.offscreen.closeDocument();
    })();
  }
});
