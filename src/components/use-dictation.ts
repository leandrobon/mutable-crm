"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * Dictation via the browser's Web Speech API.
 *
 * The transcript is put in the textarea rather than sent. Recognition mangles
 * exactly the words this app cares about — "snake_case", "numeric", column
 * names — and a wrong transcript that goes straight to the model costs a call
 * and produces a proposal you then have to reject.
 *
 * TypeScript 5.9's lib.dom does not declare this API, so the slice we use is
 * declared below rather than pulled in as a dependency.
 */

type SpeechRecognitionAlternative = { transcript: string };

type SpeechRecognitionResult = {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
};

type SpeechRecognitionEvent = {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResult;
  };
};

type SpeechRecognitionErrorEvent = { readonly error: string };

type SpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognition;

function getConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Errors worth stopping for. Chrome fires `no-speech` whenever you pause, and
 * `aborted` when we stop on purpose — restarting through those is what makes
 * continuous dictation work, so only these end the session.
 */
const FATAL = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);

function messageFor(error: string): string {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was blocked. Allow it in your browser to dictate.";
    case "audio-capture":
      return "No microphone found.";
    case "network":
      return "Speech recognition could not reach the network.";
    default:
      return `Dictation stopped: ${error}.`;
  }
}

export type Dictation = {
  /** False in browsers without the API — Firefox, mainly. Hide the button. */
  supported: boolean;
  listening: boolean;
  error: string | null;
  /** What has been heard so far this session, final and in-progress. */
  transcript: string;
  start: () => void;
  stop: () => void;
};

/** Whether the browser has the API at all — it never changes, so nothing ever
 *  needs to be notified of a change. */
const subscribeToNothing = () => () => {};

export function useDictation(): Dictation {
  // Read through useSyncExternalStore rather than an effect: the server has no
  // Web Speech API and must render the button as unsupported, while the client
  // knows the answer on the first render. This gives each side its own snapshot
  // with no hydration mismatch and no state to set after mount.
  const supported = useSyncExternalStore(
    subscribeToNothing,
    () => getConstructor() !== null,
    () => false,
  );

  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");

  const recognition = useRef<SpeechRecognition | null>(null);
  // Chrome ends the session on its own after a pause. This says whether that
  // was us or not, so we can start it again and let someone think mid-sentence.
  const wanted = useRef(false);
  const settled = useRef("");

  useEffect(() => {
    return () => {
      wanted.current = false;
      recognition.current?.abort();
    };
  }, []);

  const start = useCallback(() => {
    const Recognition = getConstructor();
    if (!Recognition || wanted.current) return;

    const instance = new Recognition();
    // The app is English throughout — see the conventions in AGENTS.md.
    instance.lang = "en-US";
    instance.continuous = true;
    instance.interimResults = true;

    instance.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) settled.current += text;
        else interim += text;
      }
      setTranscript((settled.current + interim).trimStart());
    };

    instance.onerror = (event) => {
      if (!FATAL.has(event.error)) return;
      wanted.current = false;
      setError(messageFor(event.error));
      setListening(false);
    };

    instance.onend = () => {
      // A pause, not a stop: pick it back up.
      if (wanted.current) {
        try {
          instance.start();
          return;
        } catch {
          // Already restarting, or the browser refused. Fall through to done.
        }
      }
      setListening(false);
    };

    settled.current = "";
    wanted.current = true;
    setTranscript("");
    setError(null);

    try {
      instance.start();
      recognition.current = instance;
      setListening(true);
    } catch {
      wanted.current = false;
      setError("Dictation could not start.");
    }
  }, []);

  const stop = useCallback(() => {
    wanted.current = false;
    if (recognition.current) {
      // `stop` flushes whatever is pending, so the last word still arrives.
      // `listening` is left for `onend` to clear: turning it off here would
      // close the session before that final result lands, and drop it.
      recognition.current.stop();
    } else {
      setListening(false);
    }
  }, []);

  return { supported, listening, error, transcript, start, stop };
}
