"use client";
import * as React from "react";

interface RecognitionEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

/** Browser speech input/output for the test console (Web Speech API). Fully optional; text works everywhere. */
export function useSpeech(onFinal: (text: string) => void) {
  const [supported, setSupported] = React.useState(false);
  const [listening, setListening] = React.useState(false);
  const rec = React.useRef<Recognition | null>(null);
  const cb = React.useRef(onFinal);
  React.useEffect(() => {
    cb.current = onFinal;
  });

  React.useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(!!Ctor && "speechSynthesis" in window);
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = "en-US";
    r.interimResults = false;
    r.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript;
      if (text) cb.current(text);
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r;
    return () => r.stop();
  }, []);

  const listen = React.useCallback(() => {
    if (!rec.current) return;
    window.speechSynthesis?.cancel();
    try {
      rec.current.start();
      setListening(true);
    } catch {
      /* already started */
    }
  }, []);
  const stop = React.useCallback(() => rec.current?.stop(), []);
  const speak = React.useCallback((text: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    window.speechSynthesis.speak(u);
  }, []);
  const silence = React.useCallback(() => window.speechSynthesis?.cancel(), []);

  return { supported, listening, listen, stop, speak, silence };
}
