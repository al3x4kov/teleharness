// FEAT-01.77: общий секундный тик ленты (design §5 subagents-in-chat).
// Один таймер на всё приложение, заводится только пока у открытого чата есть
// активные запуски агентов; без них now — момент последнего изменения.
// Карточки (AgentRuns), подпись прелоадера и полоса фоновых агентов читают
// agentNow — своих таймеров у них нет.
import { effect, signal } from "@preact/signals";
import { agentsBusy } from "./store/childfeeds.js";

export const agentNow = signal(Date.now());

effect(() => {
  if (!agentsBusy.value) return undefined;
  const t = setInterval(() => {
    agentNow.value = Date.now();
  }, 1000);
  return () => {
    clearInterval(t);
    agentNow.value = Date.now();
  };
});
