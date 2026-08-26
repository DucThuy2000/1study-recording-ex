import { browser } from 'wxt/browser';
import type { Message } from '@/src/shared/messages';
import { SessionRecorder } from '@/src/offscreen-logic/recorder';
import { mixTabAndMic } from '@/src/offscreen-logic/audio-mixer';
import { AudioLevelMonitor } from '@/src/offscreen-logic/audio-monitor';
import { EventReporter } from '@/src/core/event-reporter';
import { EventBus } from '@/src/core/event-bus';
import { SessionStateMachine } from '@/src/core/state-machine';
import { ChromeStorageAdapter } from '@/src/adapters/storage';
import { createLogger } from '@/src/core/logger';
import type { RecordingEvent } from '@/src/core/event-reporter';

const logger = createLogger('offscreen');
const bus = new EventBus<{ event: RecordingEvent }>();
const eventReporter = new EventReporter(new ChromeStorageAdapter(), bus, logger);

let activeRecorder: SessionRecorder | undefined;
let activeSessionId: string | undefined;
let activeStateMachine: SessionStateMachine | undefined;
let micMonitor: AudioLevelMonitor | undefined;
let tabMonitor: AudioLevelMonitor | undefined;

async function openTabStream(streamId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  } as MediaStreamConstraints);
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
      const tabStream = await openTabStream(message.streamId);
      const { mixedStream, ctx, tabSource, micSource } = await mixTabAndMic(tabStream);

      activeSessionId = message.sessionId;
      activeStateMachine = new SessionStateMachine(message.sessionId, new ChromeStorageAdapter(), logger);
      await activeStateMachine.transition('READY', 'preflight ok');
      await activeStateMachine.transition('RECORDING', 'start');
      activeRecorder = new SessionRecorder(message.sessionId, mixedStream, message.tier);
      activeRecorder.start();

      micMonitor = new AudioLevelMonitor(ctx, micSource, (event) => {
        if (event === 'ALERT') {
          void eventReporter.report('MIC_SILENT', { sessionId: message.sessionId });
        }
        void browser.runtime.sendMessage({
          type: 'AUDIO_ALERT',
          source: 'mic',
          silent: event === 'ALERT',
        } satisfies Message);
      });
      tabMonitor = new AudioLevelMonitor(ctx, tabSource, (event) => {
        if (event === 'ALERT') {
          void eventReporter.report('TAB_AUDIO_SILENT', { sessionId: message.sessionId });
        }
        void browser.runtime.sendMessage({
          type: 'AUDIO_ALERT',
          source: 'tab',
          silent: event === 'ALERT',
        } satisfies Message);
      });
      micMonitor.start();
      tabMonitor.start();

      logger.info('offscreen recording started', { sessionId: message.sessionId });
    })();
  }
  if (message.type === 'STOP_RECORDING' && activeRecorder && activeSessionId === message.sessionId) {
    void (async () => {
      micMonitor?.stop();
      tabMonitor?.stop();
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
