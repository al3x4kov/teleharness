// FEAT-11.18 / FEAT-18.6: Relay words shared by the client (the «Продолжить в …»
// button) and the server (auto-relay on a limit) — the new engine is asked to
// go on with exactly the same text either way. Pure, zero dependencies.

// The prompt the SERVER sends right after an automatic relay of a turn cut off
// by a limit (the client sends the same words in the UI language:
// store.relay.resumePrompt).
export const RELAY_RESUME_TEXT = "Continue from where the previous turn stopped.";

// Relay mark reasons (lib/relay.js relayMark → teleharness.relays[].reason).
export const RELAY_REASON_LIMIT = "limit";
export const RELAY_REASON_AUTO = "limit-auto"; // FEAT-18.6: передано автоматически по лимиту

