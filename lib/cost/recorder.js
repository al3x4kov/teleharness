// FEAT-20.6: точки записи журнала расхода.
//   observe(raw, dir) — поток событий хаба: `message.updated` готового ответа (time.completed) любого
//     движка — ответы opencode приходят из opencode, Claude/Codex — от раннера (lib/claude.js) тем же
//     событием. Повтор события (реконнект SSE, Relay) — тот же ключ (engine, id ответа): upsert.
//   service({engine, sid, user, model, result|info}) — служебные вызовы («Предложить сообщение»):
//     временная сессия opencode удаляется сразу, поэтому запись — до удаления (N-30).
// Владелец записи, проект, заголовок, родитель (субагент opencode) — из зависимостей сервера.
import { randomUUID } from "node:crypto";
import { engineOf, isRunnerEngine } from "../../shared/engine.js";
import { claudeUsageByModel, normalizeAnswer } from "./normalize.js";

// id ответа раннера Claude/Codex (lib/claude.js: shortId("msgc_a")).
const RUNNER_ID = /^msgc_/;

export function engineOfAnswer(info) {
  if (RUNNER_ID.test(String(info?.id ?? ""))) {
    const e = engineOf(info?.providerID);
    return isRunnerEngine(e) ? e : "claude";
  }
  return "opencode";
}

export class CostRecorder {
  #ledger;
  #d;
  constructor({ ledger, deps = {} }) {
    this.#ledger = ledger;
    // deps: ownerOf(sid, dir) → {id, name} | null; dirOf(sid); resolveDir(sid) → Promise<dir|null>;
    //   titleOf(sid); parentOf(sid) → sid | null;
    //   projectOf(sid, dir); onRecorded({row, alerts}); log(msg)
    this.#d = deps;
  }

  // opencode 2.2.6 (TELEHARNESS_OC_API=v2) не шлёт message.updated с токенами: шаг-ответ — session.step.started
  // (модель, id ответа) … session.step.ended (tokens, cost). Модель шага запоминается до его конца.
  #steps = new Map(); // assistantMessageID → {providerID, modelID, created, agent}

  observe(raw, dir = null) {
    let evt;
    try {
      evt = typeof raw === "string" ? (/"(message\.updated|session\.step\.(started|ended))"/.test(raw) ? JSON.parse(raw) : null) : raw;
    } catch {
      return null;
    }
    if (evt?.type === "session.step.started" || evt?.type === "session.step.ended") return this.#v2Step(evt, dir);
    if (evt?.type !== "message.updated") return null;
    const info = evt.properties?.info;
    if (info?.role !== "assistant" || !info.time?.completed || typeof info.id !== "string") return null;
    // Чат ещё не в индексе (только что создан) — папку (и владельца) берём у opencode, а не из
    // папки подписки потока: иначе ход тенанта записался бы на admin.
    const sid = info.sessionID ?? null;
    if (sid && this.#d.resolveDir && !this.#d.dirOf?.(sid)) {
      return this.#d.resolveDir(sid).then((d) => this.answer(info, { dir: d ?? dir }), () => this.answer(info, { dir }));
    }
    return this.answer(info, { dir });
  }

  #v2Step(evt, dir) {
    const p = evt.properties ?? evt.data ?? {};
    const id = p.assistantMessageID;
    if (typeof id !== "string" || !p.sessionID) return null;
    if (evt.type === "session.step.started") {
      if (this.#steps.size > 2000) this.#steps.delete(this.#steps.keys().next().value);
      this.#steps.set(id, { providerID: p.model?.providerID ?? null, modelID: p.model?.id ?? null, created: Number(p.started) || Date.now(), agent: p.agent ?? null });
      return null;
    }
    // запись шага остаётся (ограниченно): повтор события после реконнекта даст ту же модель
    const st = this.#steps.get(id) ?? this.#d.modelOf?.(p.sessionID) ?? {};
    const info = {
      id, sessionID: p.sessionID, role: "assistant", providerID: st.providerID ?? null, modelID: st.modelID ?? null,
      time: { created: st.created ?? Date.now(), completed: Date.now() },
      tokens: p.tokens && typeof p.tokens === "object" ? p.tokens : undefined, cost: typeof p.cost === "number" ? p.cost : 0,
      ...(p.finish ? { finish: p.finish } : {}),
    };
    return this.observe({ type: "message.updated", properties: { sessionID: p.sessionID, info } }, dir ?? evt.directory ?? null);
  }

  // Готовый ответ модели → запись (live). Ошибки не выходят наружу (ход не ломается, кр. 16).
  answer(info, { dir = null, source = "live", kind = null, parentSid = null, owner = null } = {}) {
    try {
      const engine = engineOfAnswer(info);
      const sid = info.sessionID ?? null;
      const d = this.#d;
      const directory = d.dirOf?.(sid) ?? dir ?? null;
      const parent = parentSid ?? d.parentOf?.(sid) ?? null;
      const who = owner ?? d.ownerOf?.(sid, directory) ?? null;
      const out = this.#ledger.record({
        engine,
        answerId: info.id,
        userId: who?.id ?? null,
        userName: who?.name ?? null,
        sid,
        parentSid: parent,
        title: d.titleOf?.(parent ?? sid) ?? null,
        project: d.projectOf?.(sid, directory) ?? directory,
        directory,
        kind: kind ?? (parent ? "subagent" : "chat"),
        providerId: info.providerID ?? null,
        modelId: info.modelID ?? null,
        startedAt: info.time?.created,
        completedAt: info.time?.completed,
        norm: normalizeAnswer(engine, info),
        source,
      });
      if (out && !out.skipped) d.onRecorded?.(out);
      return out;
    } catch (err) {
      this.#d.log?.(`[teleharness-cost] record failed: ${err?.message ?? err}`);
      return null;
    }
  }

  // Служебный вызов чата sid. Claude/Codex: запись `result` CLI; opencode: info ответа временной сессии.
  service({ engine, sid, user, model = null, result = null, info = null }) {
    try {
      const now = Date.now();
      let a = info;
      if (!a && result) {
        const by = claudeUsageByModel({ sinceLast: result.model_usage_since_last_result, usage: result.usage });
        const u = result.usage ?? {};
        a = {
          id: `msgc_svc_${randomUUID()}`,
          sessionID: sid,
          role: "assistant",
          providerID: model?.providerID ?? (engine === "codex" ? "openai-codex" : engine === "acp" ? "acp-antigravity" : "anthropic"),
          modelID: model?.modelID ?? Object.keys(result.model_usage_since_last_result ?? result.modelUsage ?? {})[0] ?? null,
          time: { created: now - (Number(result.duration_ms) || 0), completed: now },
          tokens: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: 0, cache: { read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0 } },
          ...(by ? { usageByModel: by.byModel } : {}),
          ...(result.is_error ? { turnError: true } : {}),
        };
        // `-p --output-format json` одного вызова: modelUsage = этот вызов (процесс без истории)
        if (!by && result.modelUsage && typeof result.modelUsage === "object") {
          const once = claudeUsageByModel({ sinceLast: result.modelUsage, usage: result.usage });
          if (once) a.usageByModel = once.byModel;
        }
      }
      if (!a) return null;
      const fixed = engine === "opencode" ? { ...a, id: `svc_${a.id}` } : { ...a, id: RUNNER_ID.test(a.id) ? a.id : `msgc_svc_${a.id}` };
      if (engine === "codex") fixed.providerID = "openai-codex";
      return this.answer({ ...fixed, sessionID: a.sessionID ?? sid }, { kind: "service", parentSid: sid, owner: user ? { id: user.id, name: user.name } : null });
    } catch (err) {
      this.#d.log?.(`[teleharness-cost] service record failed: ${err?.message ?? err}`);
      return null;
    }
  }
}
