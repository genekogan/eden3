"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DurableDictationSession,
  MAX_DICTATION_MS,
  type DictationTransport,
} from "@/lib/dictation-session";
import {
  currentDictationPurgeFence,
  DictationDraftStore,
  purgeDictationDraftsBeforeSignOut,
  subscribeDictationPurgeFence,
} from "@/lib/dictation-storage";
import { edenDictationTransport } from "@/lib/dictation-transport";
import { PcmRecorder } from "@/lib/pcm-recorder";
import type { ViewerPhase } from "@/components/shell/selected-agent-context";

const DEFAULT_DICTATION_TRANSPORT = edenDictationTransport();

export type DictationPhase =
  | "idle"
  | "requesting"
  | "recording"
  | "retrying"
  | "transcribing"
  | "recovering"
  | "error";

export interface DictationState {
  phase: DictationPhase;
  elapsedMs: number;
  message: string | null;
}

export function appendTranscript(current: string, transcript: string): string {
  const clean = transcript.trim();
  if (!clean) return current;
  if (!current.trim()) return clean;
  const separator = /\s$/.test(current) ? "" : " ";
  return `${current}${separator}${clean}`;
}

export function formatDictationTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function dictationRecoveryDisposition(
  ownerPhase: ViewerPhase,
  ownerId: string | null,
): "recover" | "purge" | "wait" {
  if (ownerPhase === "signed_out") return "purge";
  if (ownerPhase === "ready" && ownerId) return "recover";
  return "wait";
}

interface UseDictationOptions {
  ownerId: string | null;
  ownerPhase: ViewerPhase;
  onTranscript: (transcript: string) => void;
  transport?: DictationTransport;
}

export function useDictation({
  ownerId,
  ownerPhase,
  onTranscript,
  transport = DEFAULT_DICTATION_TRANSPORT,
}: UseDictationOptions) {
  const [state, setState] = useState<DictationState>({
    phase: "idle",
    elapsedMs: 0,
    message: null,
  });
  const [supported, setSupported] = useState(false);
  const storeRef = useRef<DictationDraftStore | null>(null);
  const recorderRef = useRef<PcmRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<DurableDictationSession | null>(null);
  const settlingRef = useRef<Promise<void> | null>(null);
  const appendChainRef = useRef<Promise<void>>(Promise.resolve());
  const startedAtRef = useRef(0);
  const cancelRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const store = useCallback(() => {
    storeRef.current ??= new DictationDraftStore();
    return storeRef.current;
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const releaseStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    clearTimer();
  }, [clearTimer]);

  const settleRecorder = useCallback(async () => {
    if (settlingRef.current) return settlingRef.current;
    const settlement = (async () => {
      const session = sessionRef.current;
      releaseStream();
      if (!session) return;
      try {
        await appendChainRef.current;
        if (cancelRef.current) {
          await session.cancel();
          if (mountedRef.current) {
            setState({ phase: "idle", elapsedMs: 0, message: null });
          }
          return;
        }
        if (mountedRef.current) {
          setState((current) => ({ ...current, phase: "transcribing", message: null }));
        }
        await session.finish();
        if (mountedRef.current) {
          const accepted = await session.consume();
          if (accepted !== null) onTranscript(accepted);
          setState({ phase: "idle", elapsedMs: 0, message: null });
        }
      } catch (error) {
        if (mountedRef.current) {
          setState((current) => ({
            ...current,
            phase: "error",
            message: error instanceof Error ? error.message : "Dictation failed.",
          }));
        }
      } finally {
        sessionRef.current = null;
        cancelRef.current = false;
        recorderRef.current = null;
      }
    })();
    settlingRef.current = settlement.finally(() => {
      settlingRef.current = null;
    });
    return settlingRef.current;
  }, [onTranscript, releaseStream]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    setState((current) => ({ ...current, phase: "transcribing", message: null }));
    await recorder.stop();
    await settleRecorder();
  }, [settleRecorder]);

  const cancel = useCallback(async () => {
    cancelRef.current = true;
    const recorder = recorderRef.current;
    if (recorder) await recorder.stop();
    await sessionRef.current?.cancel();
    if (sessionRef.current) await settleRecorder();
  }, [settleRecorder]);

  const start = useCallback(async () => {
    if (state.phase !== "idle" && state.phase !== "error") return;
    if (ownerPhase !== "ready" || !ownerId) {
      setState({ phase: "error", elapsedMs: 0, message: "Sign in before using dictation." });
      return;
    }
    if (currentDictationPurgeFence()) {
      setState({ phase: "error", elapsedMs: 0, message: "Finish signing out before starting dictation." });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !PcmRecorder.supported()) {
      setState({
        phase: "error",
        elapsedMs: 0,
        message: "This browser does not support microphone dictation.",
      });
      return;
    }
    setState({ phase: "requesting", elapsedMs: 0, message: null });
    cancelRef.current = false;
    appendChainRef.current = Promise.resolve();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const session = await DurableDictationSession.create({
          ownerId,
          store: store(),
          transport,
          onNetworkPhase: (phase) => {
            if (!mountedRef.current) return;
            setState((current) => {
              if (current.phase !== "recording" && current.phase !== "retrying") return current;
              return {
                ...current,
                phase: phase === "retrying" ? "retrying" : "recording",
                message: phase === "retrying" ? "Connection interrupted — recording safely on this device." : null,
              };
            });
          },
        });
      sessionRef.current = session;
      const recorder = new PcmRecorder(
        stream,
        (chunk) => {
          if (cancelRef.current) return;
          appendChainRef.current = appendChainRef.current.then(() =>
            session.append(chunk.audio, chunk.durationMs),
          );
        },
        () => {
          if (!mountedRef.current) return;
          setState((current) => ({
            ...current,
            message: "The microphone stopped unexpectedly. Recovering what was recorded…",
          }));
          void stop();
        },
      );
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      await recorder.start();
      setState({ phase: "recording", elapsedMs: 0, message: null });
      timerRef.current = setInterval(() => {
        const elapsedMs = Date.now() - startedAtRef.current;
        setState((current) => ({ ...current, elapsedMs }));
        if (elapsedMs >= MAX_DICTATION_MS) void stop();
      }, 250);
    } catch (error) {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) await recorder.stop().catch(() => undefined);
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) await session.cancel().catch(() => undefined);
      releaseStream();
      const permissionDenied =
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "SecurityError");
      setState({
        phase: "error",
        elapsedMs: 0,
        message: permissionDenied
          ? "Microphone access is off. Allow it in your browser, then try again."
          : error instanceof Error
            ? error.message
            : "Eden could not start dictation.",
      });
    }
  }, [ownerId, ownerPhase, releaseStream, state.phase, stop, store, transport]);

  useEffect(() => subscribeDictationPurgeFence(() => {
    // localStorage's storage event reaches sibling tabs; the custom event
    // reaches this tab. Both stop custody before any more chunks can commit.
    void cancel();
  }), [cancel]);

  // A refresh cannot keep the physical microphone open, but every completed
  // short PCM chunk is durable. On return, finish the interrupted recording
  // and restore its transcript instead of silently losing it.
  useEffect(() => {
    mountedRef.current = true;
    setSupported(
      Boolean(navigator.mediaDevices?.getUserMedia) &&
        PcmRecorder.supported(),
    );
    let disposed = false;
    void (async () => {
      try {
        // Let a previous SPA instance flush its final audio-worklet chunk
        // sequence. A hard refresh kills that instance; the durable draft is
        // still here when this short grace period ends.
        await new Promise((resolve) => setTimeout(resolve, 1_250));
        const disposition = dictationRecoveryDisposition(ownerPhase, ownerId);
        if (disposition === "purge") {
          await purgeDictationDraftsBeforeSignOut(() => store().purgeAll());
          return;
        }
        if (disposition !== "recover" || !ownerId) return;
        const [draft] = await store().recoverableDrafts(ownerId);
        if (!draft || disposed || sessionRef.current) return;
        setState({ phase: "recovering", elapsedMs: draft.durationMs, message: "Recovering your recording…" });
        const recovered = await DurableDictationSession.recover(draft, { ownerId, store: store(), transport });
        if (disposed || sessionRef.current) return;
        sessionRef.current = recovered;
        await recovered.finish();
        if (!disposed) {
          const accepted = await recovered.consume();
          if (accepted !== null) onTranscript(accepted);
          setState({ phase: "idle", elapsedMs: 0, message: null });
        }
      } catch (error) {
        if (!disposed) {
          setState((current) => ({
            ...current,
            phase: "error",
            message: error instanceof Error ? error.message : "Eden could not recover the recording.",
          }));
        }
      } finally {
        sessionRef.current = null;
      }
    })();
    return () => {
      disposed = true;
      mountedRef.current = false;
      const recorder = recorderRef.current;
      if (recorder) {
        void recorder.stop().then(settleRecorder);
      }
      clearTimer();
    };
  }, [clearTimer, onTranscript, ownerId, ownerPhase, settleRecorder, store, transport]);

  return {
    state,
    supported,
    start,
    stop,
    cancel,
  };
}
