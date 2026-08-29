import { browser } from "wxt/browser";
import type {
  Message,
  MessageOf,
  MicPermissionStateResponse,
} from "@/src/shared/messages";
import { CONFIG, type TierName } from "@/src/shared/config";
import { SessionRecorder } from "@/src/offscreen-logic/recorder";
import {
  mixTabAndMic,
  type MixResult,
} from "@/src/offscreen-logic/audio-mixer";
import { AudioLevelMonitor } from "@/src/offscreen-logic/audio-monitor";
import { startFrameMonitor } from "@/src/offscreen-logic/frame-monitor";
import { EventReporter } from "@/src/core/event-reporter";
import { EventBus } from "@/src/core/event-bus";
import {
  SessionStateMachine,
  type SessionState,
} from "@/src/core/state-machine";
import { MessagingStorageAdapter } from "@/src/adapters/messaging-storage";
import { createLogger } from "@/src/core/logger";
import { pickDeviceTier } from "@/src/core/device-tier";
import { assertNever } from "@/src/core/assert";
import { isErr, type Result } from "@/src/core/result";
import type { RecordingEvent } from "@/src/core/event-reporter";
import { SessionLedger } from "@/src/core/session-ledger";
import {
  evaluateStorageGuard,
  sumBacklogBytes,
} from "@/src/core/storage-guard";

const logger = createLogger("offscreen");
const bus = new EventBus<{ event: RecordingEvent }>();
// The offscreen document can use only chrome.runtime — chrome.storage does
// not exist here at all (Chrome's own docs: "The runtime API is the only
// extensions API supported by offscreen documents") — so persistence is
// proxied through background via MessagingStorageAdapter, never a direct
// ChromeStorageAdapter.
const eventReporter = new EventReporter(
  new MessagingStorageAdapter(),
  bus,
  logger,
);
const sessionLedger = new SessionLedger(new MessagingStorageAdapter());

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
let micMuted = false;
let storageCheckIntervalId: ReturnType<typeof setInterval> | undefined;
let storageAlerting = false;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs a handler's async body without letting a rejection escape as an unhandled promise. */
function run(task: Promise<void>, label: string): void {
  void task.catch((error: unknown) =>
    logger.error(`${label} failed`, { error: describeError(error) }),
  );
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
    logger.debug("no receiver for message", {
      type: message.type,
      error: describeError(error),
    });
  }
}

async function reportEvent(
  type: RecordingEvent["type"],
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await eventReporter.report(type, payload);
  } catch (error) {
    logger.error("failed to queue event", {
      type,
      error: describeError(error),
    });
  }
}

/** `transition()` returns a Result rather than throwing — a rejected transition is a bug, so say so. */
function logTransition(result: Result<SessionState, string>): void {
  if (isErr(result))
    logger.error("state transition rejected", { error: result.error });
}

async function openTabStream(
  streamId: string,
  tier: TierName,
): Promise<MediaStream> {
  // The tier's resolution/fps have to be requested here, on the tab stream
  // itself — MediaRecorder only controls bitrate, so without these a LOW-tier
  // machine would still capture and encode at the tab's native size (R11).
  const { width, height, fps } = CONFIG.TIERS[tier];
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
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
  const a = document.createElement("a");
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
  if (storageCheckIntervalId !== undefined)
    clearInterval(storageCheckIntervalId);
  storageCheckIntervalId = undefined;
  storageAlerting = false;
  activeMix?.micSource.mediaStream.getTracks().forEach((track) => track.stop());
  activeTabStream?.getTracks().forEach((track) => track.stop());
  const ctx = activeMix?.ctx;
  if (ctx) {
    void ctx.close().catch((error: unknown) =>
      logger.debug("AudioContext already closed", {
        error: describeError(error),
      }),
    );
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
  micMuted = false;
}

async function startRecording(
  message: MessageOf<"RECORDING_STARTED">,
): Promise<void> {
  const { sessionId, streamId } = message;
  if (activeSessionId !== undefined) {
    logger.warn("refused a second concurrent session", {
      activeSessionId,
      sessionId,
    });
    await notify({
      type: "RECORDING_STATE",
      sessionId,
      state: "FAILED",
      elapsedMs: 0,
      error: "A recording is already running.",
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
      deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number })
        .deviceMemory,
    });

    activeTabStream = await openTabStream(streamId, tier);
    activeMix = await mixTabAndMic(activeTabStream);
    const { mixedStream, ctx, tabSource, micSource } = activeMix;

    activeStateMachine = new SessionStateMachine(
      sessionId,
      new MessagingStorageAdapter(),
      logger,
    );
    logTransition(await activeStateMachine.transition("READY", "preflight ok"));
    logTransition(await activeStateMachine.transition("RECORDING", "start"));

    activeRecorder = new SessionRecorder(sessionId, mixedStream, tier, {
      onChunkWritten: (_index, bytes) =>
        sessionLedger.recordChunk(sessionId, bytes),
      onStorageDegraded: (error) => {
        const machine = activeStateMachine;
        if (machine) {
          run(
            machine
              .transition("DEGRADED", "opfs failed")
              .then((result) => logTransition(result)),
            "storage degraded transition",
          );
        }
        void reportEvent("OPFS_ERROR", { sessionId, error: String(error) });
        void notify({ type: "STORAGE_ALERT", low: true, reason: "OPFS_ERROR" });
      },
      onMemoryBufferFull: () => {
        void reportEvent("OPFS_ERROR", {
          sessionId,
          reason: "memory_buffer_full",
        });
        void notify({ type: "STORAGE_ALERT", low: true, reason: "OPFS_ERROR" });
      },
    });
    activeRecorder.start();

    stopFrameMonitor = startFrameMonitor(mixedStream, (event) => {
      if (event.type === "STALLED") {
        void reportEvent("VIDEO_STALLED", {
          sessionId,
          gapMs: event.gapMs,
          atMs: event.atMs,
        });
        void notify({
          type: "VIDEO_STALLED",
          sessionId,
          gapMs: event.gapMs,
          atMs: event.atMs,
        });
        return;
      }
      // R13(b): without the recovery timestamp there is no way to bound which
      // segment of the recording was actually lost.
      void reportEvent("VIDEO_RECOVERED", { sessionId, atMs: event.atMs });
      void notify({ type: "VIDEO_RECOVERED", sessionId, atMs: event.atMs });
    });

    micMonitor = new AudioLevelMonitor(ctx, micSource, (event) => {
      // A deliberate Meet-mute is not a mic problem — the detector still runs
      // (so it's caught up whenever the teacher unmutes), it just doesn't
      // surface anything while muted.
      if (micMuted) return;
      if (event === "ALERT") void reportEvent("MIC_SILENT", { sessionId });
      void notify({
        type: "AUDIO_ALERT",
        source: "mic",
        silent: event === "ALERT",
      });
    });
    tabMonitor = new AudioLevelMonitor(ctx, tabSource, (event) => {
      if (event === "ALERT")
        void reportEvent("TAB_AUDIO_SILENT", { sessionId });
      void notify({
        type: "AUDIO_ALERT",
        source: "tab",
        silent: event === "ALERT",
      });
    });
    micMonitor.start();
    tabMonitor.start();

    storageCheckIntervalId = setInterval(() => {
      run(
        (async () => {
          const { quota, usage } = await navigator.storage.estimate();
          const freeBytes = (quota ?? 0) - (usage ?? 0);
          const backlogBytes = sumBacklogBytes(await sessionLedger.list());
          const outcome = evaluateStorageGuard(freeBytes, backlogBytes);
          const wasAlerting = storageAlerting;
          storageAlerting = !outcome.allowed;
          if (storageAlerting === wasAlerting) return;
          if (outcome.allowed) {
            await notify({ type: "STORAGE_ALERT", low: false });
            return;
          }
          await reportEvent(
            outcome.reason,
            outcome.reason === "LOW_DISK"
              ? { freeBytes: outcome.freeBytes }
              : { backlogBytes: outcome.backlogBytes },
          );
          await notify({
            type: "STORAGE_ALERT",
            low: true,
            reason: outcome.reason,
          });
        })(),
        "storage check",
      );
    }, CONFIG.DISK_CHECK_INTERVAL_MS);

    logger.info("offscreen recording started", { sessionId, tier });
    await notify({
      type: "RECORDING_STATE",
      sessionId,
      state: "RECORDING",
      elapsedMs: 0,
    });
  } catch (error) {
    const detail = describeError(error);
    logger.error("failed to start recording", { sessionId, error: detail });
    if (activeStateMachine?.getState() === "RECORDING") {
      logTransition(
        await activeStateMachine.transition("FINALIZING", "start failed"),
      );
    }
    if (activeStateMachine?.getState() === "FINALIZING") {
      logTransition(
        await activeStateMachine.transition("FAILED", "start failed"),
      );
    }
    releaseSessionHandles();
    await notify({
      type: "RECORDING_STATE",
      sessionId,
      state: "FAILED",
      elapsedMs: 0,
      error: detail,
    });
  }
}

/**
 * `navigator.permissions.query` reflects the extension origin's grant, so it
 * doesn't matter that this runs in the offscreen document rather than wherever
 * the grant was actually obtained (the permission page, `entrypoints/permission/`).
 */
async function getMicPermissionState(): Promise<MicPermissionStateResponse> {
  const { state } = await navigator.permissions.query({ name: "microphone" });
  return { state };
}

async function stopRecording(
  message: MessageOf<"RECORDING_STOP">,
): Promise<void> {
  const { sessionId } = message;
  const recorder = activeRecorder;
  if (!recorder || activeSessionId !== sessionId) {
    logger.warn("ignoring stop for an unknown session", {
      sessionId,
      activeSessionId,
    });

    if (activeSessionId === undefined) window.close();
    return;
  }

  const elapsedMs = Date.now() - (activeStartedAtMs ?? Date.now());
  const stateMachine = activeStateMachine;

  try {
    micMonitor?.stop();
    tabMonitor?.stop();
    stopFrameMonitor?.();

    if (stateMachine) {
      logTransition(
        await stateMachine.transition("FINALIZING", "stop requested"),
      );
    }

    const { blob, missingChunkIndices } = await recorder.stop();
    if (missingChunkIndices.length > 0) {
      await reportEvent("OPFS_ERROR", { sessionId, missingChunkIndices });
    }

    triggerDownload(blob, sessionId);

    logger.info("offscreen recording stopped, file downloaded", {
      sessionId,
      elapsedMs,
    });
    await notify({
      type: "RECORDING_STATE",
      sessionId,
      state: "FINALIZING",
      elapsedMs,
    });
  } catch (error) {
    const detail = describeError(error);
    logger.error("failed to finalize recording", { sessionId, error: detail });
    await reportEvent("OPFS_ERROR", { sessionId, error: detail });
    if (stateMachine?.getState() === "FINALIZING") {
      logTransition(await stateMachine.transition("FAILED", "finalize failed"));
    }
    await notify({
      type: "RECORDING_STATE",
      sessionId,
      state: "FAILED",
      elapsedMs,
      error: detail,
    });
  } finally {
    releaseSessionHandles();
    // Non-negotiable: the document — and with it the live microphone and the
    // tab capture — has to close even if anything above threw. window.close(),
    // not the chrome.offscreen adapter (see the other close site above).
    window.close();
  }
}

browser.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse: (response?: unknown) => void) => {
    switch (message.type) {
      case "RECORDING_STARTED":
        run(startRecording(message), "start recording");
        return false;
      case "RECORDING_STOP":
        // The only path into the stop sequence. The popup's own STOP_RECORDING is
        // deliberately a different type tag, so its broadcast — which this
        // document also receives — can never race this relay (C2).
        run(stopRecording(message), "stop recording");
        return false;
      case "GET_MIC_PERMISSION_STATE":
        // Async response, so the channel has to be held open with `return true`.
        run(
          getMicPermissionState().then((response) => sendResponse(response)),
          "mic permission query",
        );
        return true;
      case "SET_MIC_MUTED":
        const muted = message.muted;
        micMuted = muted;
        if (activeMix) activeMix.micGain.gain.value = muted ? 0 : 1;
        logger.info("Muted mic: ", { muted });
        return false;

      case "START_RECORDING":
      case "STOP_RECORDING":
      case "GET_RECORDING_STATE":
      // Sent by the content script, addressed to background — this document
      // never sees it directly.
      case "MIC_MUTE_CHANGED":
      // This document emits STORAGE_GET/STORAGE_SET (via MessagingStorageAdapter)
      // rather than consuming them — background answers them.
      case "STORAGE_GET":
      case "STORAGE_SET":
      case "RECORDING_STATE":
      case "AUDIO_ALERT":
      case "VIDEO_STALLED":
      case "VIDEO_RECOVERED":
      case "STORAGE_ALERT":
      case "RECORDING_ACTIVE":
      case "GUARD_RESULT":
        return false;
      default:
        return assertNever(message);
    }
  },
);
