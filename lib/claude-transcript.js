// FEAT-13.19: one Claude turn as opencode-shaped message parts. The claude
// CLI's stream-json (main conversation only) becomes the same parts opencode
// serve 1.19.5 sends — step-start / reasoning / tool / text — so the client
// renders a Claude turn step by step with its existing components
// (Reasoning, ToolCard, AgentCard, «Шаг N») and the history keeps them.
//
// Pure: no I/O. feed(evt) returns ops for the runner to broadcast:
//   { op: "updated", part }                      → message.part.updated
//   { op: "delta", partID, field: "text", delta } → message.part.delta
//   { op: "removed", partID }                    → message.part.removed
// Shapes verified against claude CLI 2.1.316 (spike 2026-11-03,
// tests/fixtures/claude-stream-2.1.316.jsonl).

export const OUTPUT_CAP = 16_000;
export const INPUT_CAP = 4_000;
// FEAT-01.77: работа субагента в части Task — шаги и итог в zaiRun
export const ZAI_STEP_MAX = 40;
export const ZAI_OUTPUT_CAP = 2_000;

// CLI tool name → opencode tool name (ToolCard labels, AgentCard, the
// liveness line and artifact previews key on these).
const TOOL_NAMES = {
  bash: "bash",
  powershell: "bash", // the Windows CLI runs commands through PowerShell
  read: "read",
  write: "write",
  edit: "edit",
  multiedit: "edit",
  glob: "glob",
  grep: "grep",
  ls: "list",
  webfetch: "webfetch",
  websearch: "websearch",
  todowrite: "todowrite",
  task: "task",
  agent: "task",
};

export function toolName(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return "tool";
  return TOOL_NAMES[raw.toLowerCase()] ?? raw;
}

export function clip(s, cap) {
  const str = String(s ?? "");
  return str.length > cap ? `${str.slice(0, cap)}\n… [обрезано: ещё ${str.length - cap} симв.]` : str;
}

function clipInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") out[k] = clip(v, INPUT_CAP);
    else if (v && typeof v === "object") {
      const json = JSON.stringify(v);
      out[k] = json.length > INPUT_CAP ? clip(json, INPUT_CAP) : v;
    } else out[k] = v;
  }
  return out;
}

// tool_result content: a string, or blocks [{type:"text"|"image", ...}].
// Pictures are never kept (BUG-13.6: base64 bloats the history).
export function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : b?.type === "image" ? "[изображение]" : ""))
    .filter(Boolean)
    .join("\n");
}

const copy = (p) => structuredClone(p);

export class ClaudeTranscript {
  #sid;
  #mid;
  #now;
  #newId;
  #parts = []; // ordered parts (the message as stored)
  #meta = new Map(); // part id -> { msg, final }
  #blocks = new Map(); // `${msg}:${index}` -> part (open stream blocks)
  #calls = new Map(); // tool_use id -> part
  #authCount = new Map(); // msg -> count of authoritative text blocks seen
  #taskTool = new Map(); // FEAT-01.77: task_id -> tool_use_id (task_updated несёт только task_id)
  #cur = null; // current model message id (step)
  #seq = 0;

  constructor({ sessionID, messageID, now = () => Date.now(), newId } = {}) {
    this.#sid = sessionID ?? null;
    this.#mid = messageID ?? null;
    this.#now = now;
    let n = 0;
    this.#newId = newId ?? (() => `prt_c${Date.now().toString(36)}${(n++).toString(36)}`);
  }

  #add(type, msg, fields) {
    const part = { id: this.#newId(), sessionID: this.#sid, messageID: this.#mid, type, ...fields };
    this.#parts.push(part);
    this.#meta.set(part.id, { msg, final: false });
    return part;
  }

  #step(msg) {
    this.#cur = msg;
    return { op: "updated", part: copy(this.#add("step-start", msg, {})) };
  }

  #msgOf(evt) {
    const id = evt?.message?.id;
    return typeof id === "string" && id ? id : this.#cur ?? "m0";
  }

  #partsOf(msg, type) {
    return this.#parts.filter((p) => p.type === type && this.#meta.get(p.id)?.msg === msg);
  }

  // Every op for one parsed stream-json line.
  feed(evt) {
    if (!evt || typeof evt !== "object") return [];
    // FEAT-01.77: трафик субагента достраивает часть инструмента, которым он
    // запущен (design §4) — в ответ основной беседы он по-прежнему не попадает
    if (evt.parent_tool_use_id) return this.#subagent(evt);
    if (evt.type === "stream_event") return this.#stream(evt.event ?? {});
    if (evt.type === "assistant") return this.#assistant(evt);
    if (evt.type === "user") return this.#user(evt);
    if (evt.type === "system") return this.#sysTask(evt);
    return [];
  }

  // --- FEAT-01.77: запуск агента в state.metadata.zaiRun части инструмента ----

  // zaiRun части (лениво): { status, startedAt, endedAt, steps, output }
  #zai(part) {
    const st = (part.state ??= {});
    st.metadata ??= {};
    return (st.metadata.zaiRun ??= { status: "running", startedAt: null, endedAt: null, steps: [], output: null });
  }

  // Короткий объект шага (до 120 знаков): путь файла / команда / шаблон —
  // как транскрипт строит вход обычных инструментов, только короче
  #stepObject(input) {
    if (!input || typeof input !== "object") return "";
    for (const key of ["file_path", "path", "command", "pattern", "query", "url", "notebook_path", "description"]) {
      const v = input[key];
      if (typeof v === "string" && v.trim()) return clip(v.trim().replace(/\s+/g, " "), 120);
    }
    return "";
  }

  // assistant/user субагента: tool_use → шаг running, tool_result → done/error,
  // текст → zaiRun.output (последний). stream_event субагента состояние не
  // меняет — шаги приходят целыми блоками assistant.
  #subagent(evt) {
    const id = typeof evt.parent_tool_use_id === "string" ? evt.parent_tool_use_id : null;
    const part = id ? this.#calls.get(id) : null;
    if (!part) return [];
    const z = this.#zai(part);
    z.startedAt ??= this.#now();
    let changed = false;
    const blocks = Array.isArray(evt.message?.content) ? evt.message.content : [];
    if (evt.type === "assistant") {
      for (const b of blocks) {
        if (b?.type === "tool_use" && typeof b.id === "string" && b.id) {
          const tool = toolName(b.name);
          const object = this.#stepObject(b.input);
          const step = z.steps.find((s) => s.id === b.id);
          if (step) {
            if (step.tool !== tool || step.object !== object) {
              step.tool = tool;
              step.object = object;
              changed = true;
            }
          } else if (z.steps.length < ZAI_STEP_MAX) {
            z.steps.push({ id: b.id, kind: "tool", tool, object, status: "running" });
            changed = true;
          } else {
            z.stepsDropped = (z.stepsDropped ?? 0) + 1; // потолок шагов — считаем сброс
            changed = true;
          }
        } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          const out = clip(b.text, ZAI_OUTPUT_CAP);
          if (z.output !== out) {
            z.output = out;
            changed = true;
          }
        }
      }
    } else if (evt.type === "user") {
      for (const b of blocks) {
        if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const step = z.steps.find((s) => s.id === b.tool_use_id);
        if (!step) continue;
        const status = b.is_error === true ? "error" : "done";
        if (step.status !== status) {
          step.status = status;
          changed = true;
        }
      }
    }
    return changed ? [{ op: "updated", part: copy(part), zai: true }] : [];
  }

  // Системные события основной беседы о запущенных агентах: task_started /
  // task_updated / task_notification ведут zaiRun своей части. task_progress и
  // прочие состояния не меняют.
  #sysTask(evt) {
    const sub = evt.subtype;
    if (sub === "task_started") {
      const tuid = typeof evt.tool_use_id === "string" ? evt.tool_use_id : null;
      if (typeof evt.task_id === "string" && tuid) this.#taskTool.set(evt.task_id, tuid);
      const part = tuid ? this.#calls.get(tuid) : null;
      if (!part) return [];
      const z = this.#zai(part);
      if (z.startedAt != null) return []; // повторный task_started
      z.startedAt = this.#now();
      return [{ op: "updated", part: copy(part), zai: true }];
    }
    if (sub === "task_updated" || sub === "task_notification") {
      const tuid = typeof evt.tool_use_id === "string" ? evt.tool_use_id : (this.#taskTool.get(evt.task_id) ?? null);
      const part = tuid ? this.#calls.get(tuid) : null;
      if (!part) return [];
      const raw = sub === "task_updated" ? evt.patch?.status : evt.status;
      if (raw == null || raw === "running") return []; // не завершение
      const z = this.#zai(part);
      const status = raw === "failed" || raw === "error" ? "failed" : raw === "stopped" || raw === "cancelled" || raw === "killed" ? "stopped" : "completed";
      const tokNew = Number(evt.usage?.total_tokens);
      if (z.status === status && z.endedAt != null) {
        // завершение уже учтено (task_updated пришёл раньше) — уведомление доносит только расход
        if (Number.isFinite(tokNew) && tokNew > 0 && z.tokens !== tokNew) {
          z.tokens = tokNew;
          return [{ op: "updated", part: copy(part), zai: true }];
        }
        return [];
      }
      const ended = sub === "task_updated" ? evt.patch?.end_time : null;
      z.status = status;
      z.endedAt = Number.isFinite(ended) ? ended : this.#now();
      // TASK-01.81: расход агента (task_notification.usage.total_tokens) — строка «токены» карточки
      const tok = Number(evt.usage?.total_tokens);
      if (Number.isFinite(tok) && tok > 0) z.tokens = tok;
      return [{ op: "updated", part: copy(part), zai: true }];
    }
    return [];
  }

  // FEAT-01.77: ход прерван («Стоп», таймаут, падение) — субагенты погибли
  // вместе с процессом CLI; незавершённые запуски честно получают stopped.
  // BUG-229: части запусков без статуса задачи тоже получают определённый
  // итог — уведомления по ним не придёт. Жёсткий конец: субагенты погибли,
  // поэтому completed — только блокирующий запуск с результатом части (его
  // вывод и берём); у фонового результат части — служебный ack запуска, он
  // и всякий вызов без результата получают stopped.
  stopRuns() {
    const now = this.#now();
    const ops = [];
    for (const p of this.#parts) {
      if (p.type !== "tool") continue;
      const z = p.state?.metadata?.zaiRun;
      if (z?.status === "running") {
        z.status = "stopped";
        z.endedAt = now;
        ops.push({ op: "updated", part: copy(p) });
      } else if (p.tool === "task" && !z && p.state?.status !== "error") {
        const background = p.state?.input?.run_in_background === true || p.state?.input?.background === true;
        const done = p.state?.status === "completed" && !background;
        const started = Number(p.state?.time?.start) > 0 ? Number(p.state.time.start) : null;
        const ended = done && Number(p.state?.time?.end) > 0 ? Number(p.state.time.end) : now;
        const output = done && typeof p.state?.output === "string" && p.state.output ? p.state.output.slice(0, ZAI_OUTPUT_CAP) : null;
        p.state.metadata ??= {};
        p.state.metadata.zaiRun = { status: done ? "completed" : "stopped", startedAt: started, endedAt: ended, steps: [], output };
        ops.push({ op: "updated", part: copy(p) });
      }
    }
    return ops;
  }

  // FEAT-01.77: есть ли незавершённый запуск агента (чат занят и после `result`)
  hasRunningZaiRun() {
    return this.#parts.some((p) => p.type === "tool" && p.state?.metadata?.zaiRun?.status === "running");
  }

  #stream(e) {
    const now = this.#now();
    if (e.type === "message_start") {
      const id = typeof e.message?.id === "string" && e.message.id ? e.message.id : `m${++this.#seq}`;
      return [this.#step(id)];
    }
    const msg = this.#cur ?? "m0";
    const key = `${msg}:${e.index ?? 0}`;
    if (e.type === "content_block_start") {
      const b = e.content_block ?? {};
      if (b.type === "thinking" || b.type === "redacted_thinking") {
        const part = this.#add("reasoning", msg, { text: "", time: { start: now } });
        this.#blocks.set(key, part);
        return [{ op: "updated", part: copy(part) }];
      }
      if (b.type === "text") {
        const part = this.#add("text", msg, { text: typeof b.text === "string" ? b.text : "" });
        this.#blocks.set(key, part);
        return [{ op: "updated", part: copy(part) }];
      }
      if (b.type === "tool_use") {
        const part = this.#add("tool", msg, {
          callID: typeof b.id === "string" ? b.id : null,
          tool: toolName(b.name),
          state: { status: "pending", input: {}, time: { start: now } },
        });
        if (part.callID) this.#calls.set(part.callID, part);
        this.#blocks.set(key, part);
        return [{ op: "updated", part: copy(part) }];
      }
      return [];
    }
    if (e.type === "content_block_delta") {
      const d = e.delta ?? {};
      if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
        let part = this.#blocks.get(key);
        const ops = [];
        if (part?.type !== "text") {
          // A delta without its block start (older CLIs, test fakes): extend
          // the step's open text part, else open one.
          const last = this.#parts.at(-1);
          if (last?.type === "text" && this.#meta.get(last.id)?.msg === msg && !this.#meta.get(last.id).final) part = last;
          else {
            part = this.#add("text", msg, { text: "" });
            ops.push({ op: "updated", part: copy(part) });
          }
        }
        part.text += d.text;
        ops.push({ op: "delta", partID: part.id, field: "text", delta: d.text });
        return ops;
      }
      if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
        const part = this.#blocks.get(key);
        if (part?.type !== "reasoning") return [];
        part.text += d.thinking;
        return [{ op: "delta", partID: part.id, field: "text", delta: d.thinking }];
      }
      return [];
    }
    if (e.type === "content_block_stop") {
      const part = this.#blocks.get(key);
      this.#blocks.delete(key);
      if (part?.type === "reasoning" && part.time.end == null) {
        part.time.end = now;
        return [{ op: "updated", part: copy(part) }];
      }
      return [];
    }
    return [];
  }

  #assistant(evt) {
    const msg = this.#msgOf(evt);
    const ops = [];
    if (!this.#parts.some((p) => this.#meta.get(p.id)?.msg === msg)) ops.push(this.#step(msg));
    const blocks = Array.isArray(evt.message?.content) ? evt.message.content : [];
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string" && b.text) ops.push(...this.#authText(msg, b.text));
      else if ((b?.type === "thinking" || b?.type === "redacted_thinking") && typeof b.thinking === "string" && b.thinking) {
        const part = this.#partsOf(msg, "reasoning").find((p) => !this.#meta.get(p.id).final && b.thinking.length >= p.text.length);
        if (part) {
          this.#meta.get(part.id).final = true;
          if (part.text !== b.thinking) {
            part.text = b.thinking;
            ops.push({ op: "updated", part: copy(part) });
          }
        } else if (!this.#partsOf(msg, "reasoning").some((p) => p.text === b.thinking)) {
          const now = this.#now();
          const p = this.#add("reasoning", msg, { text: b.thinking, time: { start: now, end: now } });
          this.#meta.get(p.id).final = true;
          ops.push({ op: "updated", part: copy(p) });
        }
      } else if (b?.type === "tool_use") {
        const id = typeof b.id === "string" ? b.id : null;
        let part = id ? this.#calls.get(id) : null;
        if (!part) {
          // No stream events for it: the latest pending call of the step, or new.
          part = id ? null : this.#partsOf(msg, "tool").find((p) => p.state.status === "pending");
          if (!part) {
            part = this.#add("tool", msg, { callID: id, tool: toolName(b.name), state: { status: "pending", input: {}, time: { start: this.#now() } } });
            if (id) this.#calls.set(id, part);
          }
        }
        if (part.state.status === "pending") part.state.status = "running";
        part.state.input = clipInput(b.input);
        const desc = typeof b.input?.description === "string" ? b.input.description.trim() : "";
        if (desc) part.state.title = clip(desc, 200);
        ops.push({ op: "updated", part: copy(part) });
      }
    }
    return ops;
  }

  // k-th new text block of a step = k-th text part of the step (the CLI
  // sends one block per assistant line); a re-sent text is ignored.
  #authText(msg, text) {
    const texts = this.#partsOf(msg, "text");
    if (texts.some((p) => this.#meta.get(p.id).final && p.text === text)) return [];
    const k = this.#authCount.get(msg) ?? 0;
    this.#authCount.set(msg, k + 1);
    const part = texts[k];
    if (part) {
      this.#meta.get(part.id).final = true;
      if (part.text === text) return [];
      part.text = text;
      return [{ op: "updated", part: copy(part) }];
    }
    const p = this.#add("text", msg, { text });
    this.#meta.get(p.id).final = true;
    return [{ op: "updated", part: copy(p) }];
  }

  #user(evt) {
    const blocks = Array.isArray(evt.message?.content) ? evt.message.content : [];
    const ops = [];
    for (const b of blocks) {
      if (b?.type !== "tool_result") continue;
      const id = typeof b.tool_use_id === "string" ? b.tool_use_id : null;
      const part =
        (id && this.#calls.get(id)) ||
        (!id ? this.#parts.find((p) => p.type === "tool" && (p.state.status === "running" || p.state.status === "pending")) : null);
      if (!part) continue;
      const output = clip(resultText(b.content), OUTPUT_CAP);
      part.state.status = b.is_error === true ? "error" : "completed";
      part.state.output = output;
      if (b.is_error === true) part.state.error = output;
      part.state.time.end = this.#now();
      ops.push({ op: "updated", part: copy(part) });
    }
    return ops;
  }

  // Close everything still open (turn ended: done, stopped, failed).
  finish() {
    const now = this.#now();
    const ops = [];
    for (const p of this.#parts) {
      if (p.type === "reasoning" && p.time?.end == null) {
        p.time.end = now;
        ops.push({ op: "updated", part: copy(p) });
      } else if (p.type === "tool" && (p.state.status === "pending" || p.state.status === "running")) {
        p.state.status = "error";
        p.state.error = "Прервано: ход завершился раньше, чем инструмент ответил";
        p.state.time.end = now;
        ops.push({ op: "updated", part: copy(p) });
      }
    }
    this.#blocks.clear();
    return ops;
  }

  // Drop every text part (an error result replaces the answer text).
  dropText() {
    const gone = this.#parts.filter((p) => p.type === "text");
    this.#parts = this.#parts.filter((p) => p.type !== "text");
    return gone.map((p) => ({ op: "removed", partID: p.id }));
  }

  // A trailing text part (error, interruption mark, empty-answer note).
  addText(text) {
    const p = this.#add("text", this.#cur ?? "m0", { text });
    this.#meta.get(p.id).final = true;
    return { op: "updated", part: copy(p) };
  }

  hasText() {
    return this.#parts.some((p) => p.type === "text" && p.text.trim());
  }

  // The answer text (all text parts) — for callers that need plain text.
  text() {
    return this.#parts
      .filter((p) => p.type === "text" && p.text.trim())
      .map((p) => p.text)
      .join("\n\n");
  }

  // What the history stores: empty text parts dropped.
  parts() {
    return this.#parts.filter((p) => p.type !== "text" || p.text.trim()).map(copy);
  }
}
