import { browser } from 'wxt/browser';
import type { Message, MessageOf, MicPermissionStateResponse } from '@/src/shared/messages';
import { CONFIG, type TierName } from '@/src/shared/config';
import { SessionRecorder } from '@/src/offscreen-logic/recorder';
import { mixTabAndMic, type MixResult } from '@/src/offscreen-logic/audio-mixer';
import { AudioLevelMonitor } from '@/src/offscreen-logic/audio-monitor';
import { startFrameMonitor } from '@/src/offscreen-logic/frame-monitor';
import { EventReporter } from '@/src/core/event-reporter';
import { EventBus } from '@/src/core/event-bus';
import { SessionStateMachine, type SessionState } from '@/src/core/state-machine';
import { ChromeStorageAdapter } from '@/src/adapters/storage';
import { ChromeOffscreenApi } from '@/src/adapters/chrome-api';
import { createLogger } from '@/src/core/logger';
import { pickDeviceTier } from '@/src/core/device-tier';
import { assertNever } from '@/src/core/assert';
import { isErr, type Result } from '@/src/core/result';
import type { RecordingEvent } from '@/src/core/event-reporter';

const logger = createLogger('offscreen');
const bus = new EventBus<{ event: RecordingEvent }>();
const eventReporter = new EventReporter(new ChromeStorageAdapter(), bus, logger);
const offscreenApi = new ChromeOffscreenApi();

// Per-session handles for the in-flight recording. These are transient wiring
// state, not business logic — every decision lives in an injected, unit-tested
// class (see the SDD ledger's Ruling 2).
let activeRecorder: SessionRecorder | undefined;
let activeSessionId: string | undefined;
let activeStartedAtMs: number | undefined;
let activeStateMachine: SessionStateMachine | undefined;
let activeTabStream: MediaStream | undefined;
let activeMix: MixResult | undefined;
let micMonitor: AudioLevelMonitor | undefined;
let tabMonitor: AudioLevelMonitor | undefined;
let stopFrameMonitor: (() => void) | undefined;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs a handler's async body without letting a rejection escape as an unhandled promise. */
function run(task: Promise<void>, label: string): void {
  void task.catch((error: unknown) => logger.error(`${label} failed`, { error: describeError(error) }));
}

/**
 * Offscreen never broadcasts blind: every message here is addressed to
 * background, which is the only context that can route on to a content script.
 * Sending fails harmlessly when no extension page is listening.
 */
async function notify(message: Message): Promise<void> {
  try {
    await browser.runtime.sendMessage(message);
  } catch (error) {
    logger.debug('no receiver for message', { type: message.type, error: describeError(error) });
  }
}

async function reportEvent(type: RecordingEvent['type'], payload: Record<string, unknown>): Promise<void> {
  try {
    await eventReporter.report(type, payload);
  } catch (error) {
    logger.error('failed to queue event', { type, error: describeError(error) });
  }
}

/** `transition()` returns a Result rather than throwing — a rejected transition is a bug, so say so. */
function logTransition(result: Result<SessionState, string>): void {
  if (isErr(result)) logger.error('state transition rejected', { error: result.error });
}

async function openTabStream(streamId: string, tier: TierName): Promise<MediaStream> {
  // The tier's resolution/fps have to be requested here, on the tab stream
  // itself — MediaRecorder only controls bitrate, so without these a LOW-tier
  // machine would still capture and encode at the tab's native size (R11).
  const { width, height, fps } = CONFIG.TIERS[tier];
  return navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: width,
        maxHeight: height,
        maxFrameRate: fps,
      },
    },
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

/**
 * Drops every per-session handle and releases the media devices behind them.
 * Safe to call at any point in a session's construction, so a start that fails
 * halfway never leaves a live microphone or a half-built recorder behind.
 */
function releaseSessionHandles(): void {
  micMonitor?.stop();
  tabMonitor?.stop();
  stopFrameMonitor?.();
  activeMix?.micSource.mediaStream.getTracks().forEach((track) => track.stop());
  activeTabStream?.getTracks().forEach((track) => track.stop());
  const ctx = activeMix?.ctx;
  if (ctx) {
    void ctx.close().catch((error: unknown) => logger.debug('AudioContext already closed', { error: describeError(error) }));
  }
  micMonitor = undefined;
  tabMonitor = undefined;
  stopFrameMonitor = undefined;
  activeMix = undefined;
  activeTabStream = undefined;
  activeRecorder = undefined;
  activeStateMachine = undefined;
  activeSessionId = undefined;
  activeStartedAtMs = undefined;
}

async function startRecording(message: MessageOf<'RECORDING_STARTED'>): Promise<void> {
  const { sessionId, streamId } = message;
  if (activeSessionId !== undefined) {
    logger.warn('refused a second concurrent session', { activeSessionId, sessionId });
    await notify({
      type: 'RECORDING_STATE',
      sessionId,
      state: 'FAILED',
      elapsedMs: 0,
      error: 'A recording is already running.',
    });
    return;
  }

  activeSessionId = sessionId;
  activeStartedAtMs = Date.now();

  try {
    // Tier first: it decides the capture constraints, so it cannot be computed
    // after the stream is already open.
    const tier = pickDeviceTier({
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    });

    activeTabStream = await openTabStream(streamId, tier);
    activeMix = await mixTabAndMic(activeTabStream);
    const { mixedStream, ctx, tabSource, micSource } = activeMix;

    activeStateMachine = new SessionStateMachine(sessionId, new ChromeStorageAdapter(), logger);
    logTransition(await activeStateMachine.transition('READY', 'preflight ok'));
    logTransition(await activeStateMachine.transition('RECORDING', 'start'));

    activeRecorder = new SessionRecorder(sessionId, mixedStream, tier);
    activeRecorder.start();

    stopFrameMonitor = startFrameMonitor(mixedStream, (event) => {
      if (event.type === 'STALLED') {
        void reportEvent('VIDEO_STALLED', { sessionId, gapMs: event.gapMs, atMs: event.atMs });
        void notify({ type: 'VIDEO_STALLED', sessionId, gapMs: event.gapMs, atMs: event.atMs });
        return;
      }
      // R13(b): without the recovery timestamp there is no way to bound which
      // segment of the recording was actually lost.
      void reportEvent('VIDEO_RECOVERED', { sessionId, atMs: event.atMs });
      void notify({ type: 'VIDEO_RECOVERED', sessionId, atMs: event.atMs });
    });

    micMonitor = new AudioLevelMonitor(ctx, micSource, (event) => {
      if (event === 'ALERT') void reportEvent('MIC_SILENT', { sessionId });
      void notify({ type: 'AUDIO_ALERT', source: 'mic', silent: event === 'ALERT' });
    });
    tabMonitor = new AudioLevelMonitor(ctx, tabSource, (event) => {
      if (event === 'ALERT') void reportEvent('TAB_AUDIO_SILENT', { sessionId });
      void notify({ type: 'AUDIO_ALERT', source: 'tab', silent: event === 'ALERT' });
    });
    micMonitor.start();
    tabMonitor.start();

    logger.info('offscreen recording started', { sessionId, tier });
    // The start ack. Until background sees this it treats the session as
    // tentative, so the popup can show "Starting…" instead of a lie.
    await notify({ type: 'RECORDING_STATE', sessionId, state: 'RECORDING', elapsedMs: 0 });
  } catch (error) {
    const detail = describeError(error);
    logger.error('failed to start recording', { sessionId, error: detail });
    if (activeStateMachine?.getState() === 'RECORDING') {
      logTransition(await activeStateMachine.transition('FINALIZING', 'start failed'));
    }
    if (activeStateMachine?.getState() === 'FINALIZING') {
      logTransition(await activeStateMachine.transition('FAILED', 'start failed'));
    }
    releaseSessionHandles();
    await notify({ type: 'RECORDING_STATE', sessionId, state: 'FAILED', elapsedMs: 0, error: detail });
  }
}

/**
 * `navigator.permissions.query` reflects the extension origin's grant, so it
 * doesn't matter that this runs in the offscreen document rather than wherever
 * the grant was actually obtained (the permission page, `entrypoints/permission/`).
 */
async function getMicPermissionState(): Promise<MicPermissionStateResponse> {
  const { state } = await navigator.permissions.query({ name: 'microphone' });
  return { state };
}

async function stopRecording(message: MessageOf<'RECORDING_STOP'>): Promise<void> {
  const { sessionId } = message;
  const recorder = activeRecorder;
  if (!recorder || activeSessionId !== sessionId) {
    logger.warn('ignoring stop for an unknown session', { sessionId, activeSessionId });
    // Nothing is running here, so this document is dead weight (a start that
    // failed, or a stop replayed after a service-worker restart). Close it
    // rather than leaving an idle offscreen document behind.
    if (activeSessionId === undefined) await offscreenApi.closeDocument();
    return;
  }

  const elapsedMs = Date.now() - (activeStartedAtMs ?? Date.now());
  const stateMachine = activeStateMachine;

  try {
    micMonitor?.stop();
    tabMonitor?.stop();
    stopFrameMonitor?.();
    if (stateMachine) logTransition(await stateMachine.transition('FINALIZING', 'stop requested'));

    const { blob, missingChunkIndices } = await recorder.stop();
    if (missingChunkIndices.length > 0) {
      await reportEvent('OPFS_ERROR', { sessionId, missingChunkIndices });
    }
    triggerDownload(blob, sessionId);
    logger.info('offscreen recording stopped, file downloaded', { sessionId, elapsedMs });
    await notify({ type: 'RECORDING_STATE', sessionId, state: 'FINALIZING', elapsedMs });
  } catch (error) {
    const detail = describeError(error);
    logger.error('failed to finalize recording', { sessionId, error: detail });
    await reportEvent('OPFS_ERROR', { sessionId, error: detail });
    if (stateMachine?.getState() === 'FINALIZING') {
      logTransition(await stateMachine.transition('FAILED', 'finalize failed'));
    }
    await notify({ type: 'RECORDING_STATE', sessionId, state: 'FAILED', elapsedMs, error: detail });
  } finally {
    releaseSessionHandles();
    // Non-negotiable: the document — and with it the live microphone and the
    // tab capture — has to close even if anything above threw.
    await offscreenApi.closeDocument();
  }
}

browser.runtime.onMessage.addListener((message: Message, _sender, sendResponse: (response?: unknown) => void) => {
  switch (message.type) {
    case 'RECORDING_STARTED':
      run(startRecording(message), 'start recording');
      return false;
    case 'RECORDING_STOP':
      // The only path into the stop sequence. The popup's own STOP_RECORDING is
      // deliberately a different type tag, so its broadcast — which this
      // document also receives — can never race this relay (C2).
      run(stopRecording(message), 'stop recording');
      return false;
    case 'GET_MIC_PERMISSION_STATE':
      // Async response, so the channel has to be held open with `return true`.
      run(
        getMicPermissionState().then((response) => sendResponse(response)),
        'mic permission query',
      );
      return true;
    // Addressed to background, the popup or a content script. Named explicitly
    // rather than omitted so the switch stays exhaustive: a new message type is
    // then a compile error here instead of a silent drop.
    case 'START_RECORDING':
    case 'STOP_RECORDING':
    case 'GET_RECORDING_STATE':
    case 'RECORDING_STATE':
    case 'AUDIO_ALERT':
    case 'VIDEO_STALLED':
    case 'VIDEO_RECOVERED':
    case 'RECORDING_ACTIVE':
    case 'GUARD_RESULT':
      return false;
    default:
      return assertNever(message);
  }
});
