// allowlist catalog of executable commands and external
// Temporal workflows for pipeline "command" steps.
//
// Stored at <TELEHARNESS_DATA_DIR>/temporal-commands.json (schema 1), written atomically.
// Missing file = empty valid catalog; corrupt JSON or schema mismatch = 503 on
// read/run so broken policy never silently downgrades.
import { accessSync, constants as fsConstants, readFileSync, realpathSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { writeJsonAtomic } from "../json-store.js";
import { isUnderAny } from "../paths.js";
import { DefinitionError } from "./definitions.js";
import { resolveTemporalCli } from "./cli.js";
import { slugify } from "./workspace.js";

const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const PARAM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ADDRESS_RE = /^[a-zA-Z0-9._:\-\[\]]{1,256}$/;
const NAMESPACE_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const SCHEDULE_ID_RE = /^[a-zA-Z0-9._:@/-]{1,256}$/;
const TASK_QUEUE_RE = /^[a-zA-Z0-9._-]{1,256}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ALLOWED_ROLES = new Set(["admin", "user"]);
const KINDS = new Set(["exec", "temporal-workflow"]);

const clone = (v) => structuredClone(v);

function realOrNorm(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function normalizeCommandId(raw, fallbackName = "") {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  const base = slugify(fallbackName).replace(/^[^a-z]+/, "");
  const slug = (base || "cmd").slice(0, 64).replace(/-+$/, "");
  return ID_RE.test(slug) ? slug : "cmd";
}

export function validateExecFile(file, allowedRoots, { checkFs = true } = {}) {
  if (typeof file !== "string" || !file.trim() || file.length > 2048) {
    return "Укажите абсолютный путь к исполняемому файлу";
  }
  if (!path.isAbsolute(file)) return "Путь к исполняемому файлу должен быть абсолютным";
  if (/[\x00-\x1f]/.test(file)) return "Путь содержит недопустимые управляющие символы";
  const roots = (allowedRoots ?? []).filter((r) => typeof r === "string" && r.trim());
  if (!roots.length) return "Не заданы разрешённые корневые каталоги команд (TELEHARNESS_TEMPORAL_COMMAND_ROOTS / TELEHARNESS_FILE_ROOTS)";

  if (!checkFs) {
    const norm = path.resolve(file);
    const normRoots = roots.map((r) => path.resolve(r));
    if (!isUnderAny(norm, normRoots)) return "Файл команды находится вне разрешённых корневых каталогов";
    return null;
  }

  let st;
  try {
    st = statSync(file);
  } catch {
    return `Файл команды не найден: ${file}`;
  }
  if (!st.isFile()) return "Путь exec.file должен указывать на обычный файл";
  try {
    accessSync(file, fsConstants.X_OK);
  } catch {
    return "У файла команды отсутствует право на исполнение (chmod +x)";
  }
  let real;
  try {
    real = realpathSync(file);
  } catch {
    return "Не удалось разрешить реальный путь файла команды";
  }
  const realRoots = roots.map(realOrNorm);
  if (!isUnderAny(real, realRoots)) {
    return "Реальный путь файла (с учётом симлинков) выходит за пределы разрешённых корней";
  }
  return null;
}

export function validateCommandEntry(raw, { allowedRoots = [], checkFs = true } = {}) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, errors: ["Запись команды должна быть объектом"] };
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!ID_RE.test(id)) errors.push("id должен соответствовать /^[a-z][a-z0-9-]{0,63}$/");

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > 160) errors.push("Укажите название команды (до 160 символов)");

  const description = raw.description == null ? "" : typeof raw.description === "string" ? raw.description.trim() : null;
  if (description === null || description.length > 1000) errors.push("Описание команды должно быть строкой до 1000 символов");

  const kind = raw.kind;
  if (!KINDS.has(kind)) errors.push("Тип команды должен быть exec или temporal-workflow");

  const timeoutSeconds = raw.timeoutSeconds === undefined ? 600 : raw.timeoutSeconds;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) {
    errors.push("timeoutSeconds должен быть целым числом от 1 до 86400");
  }

  const tenantSafe = raw.tenantSafe === undefined ? false : Boolean(raw.tenantSafe);

  // allow
  const rawAllow = raw.allow ?? { roles: ["admin"], users: [] };
  if (typeof rawAllow !== "object" || Array.isArray(rawAllow)) {
    errors.push("allow должен быть объектом { roles, users }");
  }
  const roles = Array.isArray(rawAllow?.roles) ? [...new Set(rawAllow.roles.map((r) => String(r).trim()).filter(Boolean))] : ["admin"];
  const users = Array.isArray(rawAllow?.users) ? [...new Set(rawAllow.users.map((u) => String(u).trim()).filter(Boolean))] : [];
  if (roles.some((r) => !ALLOWED_ROLES.has(r))) errors.push("allow.roles допускает только admin и user");
  if (!roles.length && !users.length) errors.push("Укажите хотя бы одну роль или пользователя в allow");

  // params
  const rawParams = raw.params === undefined ? [] : raw.params;
  const params = [];
  if (!Array.isArray(rawParams) || rawParams.length > 32) {
    errors.push("params должен быть массивом (до 32 параметров)");
  } else {
    const seen = new Set();
    for (const p of rawParams) {
      if (!p || typeof p !== "object" || Array.isArray(p)) {
        errors.push("Каждый параметр должен быть объектом");
        continue;
      }
      const pname = typeof p.name === "string" ? p.name.trim() : "";
      if (!PARAM_NAME_RE.test(pname) || FORBIDDEN_KEYS.has(pname)) {
        errors.push(`Некорректное имя параметра: ${pname || "(пусто)"}`);
        continue;
      }
      if (seen.has(pname)) {
        errors.push(`Дублирующийся параметр: ${pname}`);
        continue;
      }
      seen.add(pname);
      const required = Boolean(p.required);
      let pattern;
      if (p.pattern !== undefined && p.pattern !== null && p.pattern !== "") {
        if (typeof p.pattern !== "string" || p.pattern.length > 256) {
          errors.push(`Параметр ${pname}: pattern должен быть строкой до 256 символов`);
        } else {
          try {
            new RegExp(p.pattern);
            pattern = p.pattern;
          } catch {
            errors.push(`Параметр ${pname}: некорректное регулярное выражение pattern`);
          }
        }
      }
      const pdesc = p.description == null ? "" : typeof p.description === "string" ? p.description.trim() : null;
      if (pdesc === null || pdesc.length > 500) {
        errors.push(`Параметр ${pname}: описание должно быть строкой до 500 символов`);
      }
      params.push({
        name: pname,
        required,
        ...(pattern ? { pattern } : {}),
        ...(pdesc ? { description: pdesc } : {}),
      });
    }
  }

  let execBlock;
  let temporalBlock;

  if (kind === "exec") {
    const ex = raw.exec;
    if (!ex || typeof ex !== "object" || Array.isArray(ex)) {
      errors.push("Для команды exec требуется объект exec");
    } else {
      const fileErr = validateExecFile(ex.file, allowedRoots, { checkFs });
      if (fileErr) errors.push(fileErr);

      const argv = ex.argv === undefined ? [] : ex.argv;
      if (!Array.isArray(argv) || argv.length > 64 || argv.some((a) => typeof a !== "string" || a.length > 1024)) {
        errors.push("exec.argv должен быть массивом строк (до 64 элементов по ≤ 1024 символов)");
      }

      const rawEnv = ex.env === undefined ? {} : ex.env;
      const env = {};
      if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv)) {
        errors.push("exec.env должен быть объектом { KEY: VALUE }");
      } else {
        const entries = Object.entries(rawEnv);
        if (entries.length > 32) errors.push("exec.env допускает не более 32 переменных");
        for (const [k, v] of entries) {
          if (!ENV_KEY_RE.test(k) || FORBIDDEN_KEYS.has(k)) {
            errors.push(`Некорректное имя переменной окружения: ${k}`);
          } else if (typeof v !== "string" || v.length > 2048 || /[\x00]/.test(v)) {
            errors.push(`Некорректное значение переменной окружения: ${k}`);
          } else {
            env[k] = v;
          }
        }
      }

      let cwd;
      if (ex.cwd !== undefined && ex.cwd !== null && ex.cwd !== "") {
        if (typeof ex.cwd !== "string" || !path.isAbsolute(ex.cwd) || ex.cwd.length > 2048) {
          errors.push("exec.cwd должен быть абсолютным путём");
        } else if (checkFs) {
          try {
            const st = statSync(ex.cwd);
            if (!st.isDirectory()) errors.push("exec.cwd должен указывать на каталог");
            else if (!isUnderAny(realpathSync(ex.cwd), allowedRoots.map(realOrNorm))) {
              errors.push("exec.cwd выходит за пределы разрешённых корней");
            }
          } catch {
            errors.push(`Каталог exec.cwd не найден: ${ex.cwd}`);
          }
        }
        cwd = ex.cwd;
      }

      execBlock = {
        file: typeof ex.file === "string" ? ex.file.trim() : "",
        argv: Array.isArray(argv) ? [...argv] : [],
        env,
        ...(cwd ? { cwd } : {}),
      };
    }
  } else if (kind === "temporal-workflow") {
    const t = raw.temporal;
    if (!t || typeof t !== "object" || Array.isArray(t)) {
      errors.push("Для команды temporal-workflow требуется объект temporal");
    } else {
      const address = typeof t.address === "string" ? t.address.trim() : "";
      const namespace = typeof t.namespace === "string" ? t.namespace.trim() : "";
      const schedule = typeof t.schedule === "string" ? t.schedule.trim() : "";
      const workflow = typeof t.workflow === "string" ? t.workflow.trim() : "";
      const taskQueue = typeof t.taskQueue === "string" ? t.taskQueue.trim() : "";
      const uiBase = typeof t.uiBase === "string" ? t.uiBase.trim() : "";
      const cancelChild = t.cancelChild === undefined ? true : Boolean(t.cancelChild);

      if (!ADDRESS_RE.test(address)) errors.push("Укажите корректный адрес Temporal (например, 127.0.0.1:7233)");
      if (!NAMESPACE_RE.test(namespace)) errors.push("Укажите корректный namespace Temporal");

      const hasSchedule = Boolean(schedule);
      const hasWorkflow = Boolean(workflow || taskQueue);
      if (hasSchedule && hasWorkflow) {
        errors.push("Укажите либо temporal.schedule, либо пару temporal.workflow + temporal.taskQueue (не оба)");
      } else if (!hasSchedule && !hasWorkflow) {
        errors.push("Укажите temporal.schedule или пару temporal.workflow + temporal.taskQueue");
      } else if (hasSchedule) {
        if (!SCHEDULE_ID_RE.test(schedule)) errors.push("Некорректный temporal.schedule");
      } else {
        if (!workflow || workflow.length > 256 || /[\x00-\x1f]/.test(workflow)) {
          errors.push("Укажите корректное имя temporal.workflow");
        }
        if (!TASK_QUEUE_RE.test(taskQueue)) errors.push("Укажите корректную очередь temporal.taskQueue");
      }

      if (uiBase) {
        try {
          const u = new URL(uiBase);
          if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("proto");
        } catch {
          errors.push("temporal.uiBase должен быть корректным URL http:// или https://");
        }
      }

      temporalBlock = {
        address,
        namespace,
        schedule: schedule || null,
        workflow: workflow || null,
        taskQueue: taskQueue || null,
        uiBase: uiBase || null,
        cancelChild,
      };
    }
  }

  if (errors.length) return { valid: false, errors };
  const entry = {
    id,
    name,
    ...(description ? { description } : {}),
    kind,
    ...(execBlock ? { exec: execBlock } : {}),
    ...(temporalBlock ? { temporal: temporalBlock } : {}),
    params,
    timeoutSeconds,
    allow: { roles, users },
    tenantSafe,
  };
  return { valid: true, entry };
}

export function commandAllowed(entry, user) {
  if (!entry || !user?.id) return false;
  const roles = entry.allow?.roles ?? ["admin"];
  const users = entry.allow?.users ?? [];
  return roles.includes(user.role) || users.includes(user.id);
}

// Non-admin never sees exec.file / exec.argv / exec.env / temporal.address / temporal.namespace.
// Admin gets full entry fields for preview («Что запустится») and catalog editing.
export function projectCommand(entry, isAdmin = false) {
  const base = {
    id: entry.id,
    name: entry.name,
    description: entry.description ?? "",
    kind: entry.kind,
    params: clone(entry.params ?? []),
    timeoutSeconds: entry.timeoutSeconds,
  };
  if (!isAdmin) return base;
  return {
    ...base,
    allow: clone(entry.allow ?? { roles: ["admin"], users: [] }),
    tenantSafe: Boolean(entry.tenantSafe),
    ...(entry.kind === "exec" && entry.exec ? { exec: clone(entry.exec) } : {}),
    ...(entry.kind === "temporal-workflow" && entry.temporal ? { temporal: clone(entry.temporal) } : {}),
  };
}

function defaultExecute(cmd, args, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

function parseScheduleListOutput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // temporal CLI may output NDJSON (one JSON object per line)
    parsed = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.schedules) ? parsed.schedules : [parsed];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const scheduleId = row.scheduleId ?? row.schedule_id ?? row.id ?? row.spec?.scheduleId;
    if (typeof scheduleId !== "string" || !scheduleId) continue;
    const workflowType =
      row.info?.workflowType?.name ??
      row.action?.startWorkflow?.workflowType?.name ??
      row.workflowType?.name ??
      row.workflowType ??
      null;
    const paused = Boolean(row.info?.paused ?? row.state?.paused ?? row.paused);
    out.push({ scheduleId, workflowType: typeof workflowType === "string" ? workflowType : null, paused });
  }
  return out;
}

export class CommandCatalog {
  constructor({
    file,
    allowedRoots = [],
    write = writeJsonAtomic,
    checkFs = true,
    cli,
    address = "127.0.0.1:7233",
    namespace = "default",
    execute = defaultExecute,
  } = {}) {
    this.file = file;
    this.allowedRoots = (allowedRoots ?? []).filter((r) => typeof r === "string" && r.trim());
    this.write = write;
    this.checkFs = checkFs;
    this.cli = cli;
    this.defaultAddress = address;
    this.defaultNamespace = namespace;
    this.execute = execute;
    this._state = { status: "ok", items: [], byId: new Map(), error: null, errors: [] };
    this.reload();
  }

  reload() {
    if (!this.file) {
      this._state = { status: "ok", items: [], byId: new Map(), error: null, errors: [] };
      return { ok: true, items: [], errors: [] };
    }
    let rawText;
    try {
      rawText = readFileSync(this.file, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") {
        this._state = { status: "ok", items: [], byId: new Map(), error: null, errors: [] };
        return { ok: true, items: [], errors: [] };
      }
      this._state = {
        status: "corrupted",
        items: [],
        byId: new Map(),
        error: "Каталог команд повреждён — проверьте temporal-commands.json",
        errors: [err?.message ?? "Ошибка чтения файла каталога"],
      };
      return { ok: false, items: [], errors: this._state.errors };
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      this._state = {
        status: "corrupted",
        items: [],
        byId: new Map(),
        error: "Каталог команд повреждён — проверьте temporal-commands.json",
        errors: [`Невалидный JSON: ${err?.message ?? "синтаксическая ошибка"}`],
      };
      return { ok: false, items: [], errors: this._state.errors };
    }

    if (!parsed || typeof parsed !== "object" || parsed.schema !== 1 || !Array.isArray(parsed.items)) {
      this._state = {
        status: "corrupted",
        items: [],
        byId: new Map(),
        error: "Каталог команд повреждён — проверьте temporal-commands.json",
        errors: ["Ожидается объект { schema: 1, items: [...] }"],
      };
      return { ok: false, items: [], errors: this._state.errors };
    }

    const items = [];
    const byId = new Map();
    const errors = [];
    for (const [idx, rawItem] of parsed.items.entries()) {
      const res = validateCommandEntry(rawItem, { allowedRoots: this.allowedRoots, checkFs: this.checkFs });
      if (!res.valid) {
        errors.push(`items[${idx}]: ${res.errors.join("; ")}`);
        continue;
      }
      if (byId.has(res.entry.id)) {
        errors.push(`Дублирующийся id команды: ${res.entry.id}`);
        continue;
      }
      byId.set(res.entry.id, res.entry);
      items.push(res.entry);
    }

    if (errors.length) {
      this._state = {
        status: "corrupted",
        items: [],
        byId: new Map(),
        error: "Каталог команд повреждён — проверьте temporal-commands.json",
        errors,
      };
      return { ok: false, items: [], errors };
    }

    this._state = { status: "ok", items, byId, error: null, errors: [] };
    return { ok: true, items: clone(items), errors: [] };
  }

  status() {
    return {
      status: this._state.status,
      error: this._state.error,
      errors: [...this._state.errors],
      count: this._state.items.length,
      allowedRoots: [...this.allowedRoots],
    };
  }

  requireHealthy() {
    if (this._state.status !== "ok") {
      throw new DefinitionError(503, this._state.error || "Каталог команд повреждён — проверьте temporal-commands.json", this._state.errors);
    }
  }

  listForUser(user) {
    this.requireHealthy();
    const isAdmin = user?.role === "admin";
    return this._state.items.filter((e) => commandAllowed(e, user)).map((e) => projectCommand(e, isAdmin));
  }

  hasAnyForUser(user) {
    if (this._state.status !== "ok") return false;
    return this._state.items.some((e) => commandAllowed(e, user));
  }

  listAdmin() {
    return {
      status: this._state.status,
      ...(this._state.error ? { error: this._state.error, errors: [...this._state.errors] } : {}),
      allowedRoots: [...this.allowedRoots],
      items: this._state.items.map((e) => projectCommand(e, true)),
    };
  }

  get(id) {
    this.requireHealthy();
    const hit = this._state.byId.get(id);
    return hit ? clone(hit) : null;
  }

  validateExecNow(entry) {
    if (!entry || entry.kind !== "exec") return null;
    return validateExecFile(entry.exec?.file, this.allowedRoots, { checkFs: this.checkFs });
  }

  _persist(items) {
    if (!this.file) return;
    const ok = this.write(this.file, { schema: 1, items });
    if (!ok) throw new DefinitionError(503, "Не удалось сохранить каталог команд");
  }

  create(raw) {
    this.requireHealthy();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new DefinitionError(422, "Некорректное описание команды");
    }
    const candidate = { ...raw };
    if (!candidate.id || (typeof candidate.id === "string" && !candidate.id.trim())) {
      const base = normalizeCommandId("", candidate.name);
      let id = base;
      let n = 2;
      while (this._state.byId.has(id)) {
        id = `${base.slice(0, 58)}-${n++}`;
      }
      candidate.id = id;
    }
    const res = validateCommandEntry(candidate, { allowedRoots: this.allowedRoots, checkFs: this.checkFs });
    if (!res.valid) throw new DefinitionError(422, res.errors[0] || "Ошибка валидации команды", res.errors);
    if (this._state.byId.has(res.entry.id)) {
      throw new DefinitionError(409, `Команда с id «${res.entry.id}» уже существует`);
    }
    const next = [...this._state.items, res.entry];
    this._persist(next);
    const byId = new Map(this._state.byId);
    byId.set(res.entry.id, res.entry);
    this._state = { status: "ok", items: next, byId, error: null, errors: [] };
    return projectCommand(res.entry, true);
  }

  update(id, raw) {
    this.requireHealthy();
    if (!this._state.byId.has(id)) throw new DefinitionError(404, "Команда не найдена");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new DefinitionError(422, "Некорректное описание команды");
    }
    const candidate = { ...raw, id };
    const res = validateCommandEntry(candidate, { allowedRoots: this.allowedRoots, checkFs: this.checkFs });
    if (!res.valid) throw new DefinitionError(422, res.errors[0] || "Ошибка валидации команды", res.errors);
    const next = this._state.items.map((item) => (item.id === id ? res.entry : item));
    this._persist(next);
    const byId = new Map(this._state.byId);
    byId.set(id, res.entry);
    this._state = { status: "ok", items: next, byId, error: null, errors: [] };
    return projectCommand(res.entry, true);
  }

  remove(id) {
    this.requireHealthy();
    if (!this._state.byId.has(id)) throw new DefinitionError(404, "Команда не найдена");
    const next = this._state.items.filter((item) => item.id !== id);
    this._persist(next);
    const byId = new Map(this._state.byId);
    byId.delete(id);
    this._state = { status: "ok", items: next, byId, error: null, errors: [] };
    return { id, deleted: true };
  }

  async listExternalSchedules({ address, namespace } = {}) {
    const addr = String(address || this.defaultAddress || "").trim();
    const ns = String(namespace || this.defaultNamespace || "").trim();
    if (!ADDRESS_RE.test(addr)) throw new DefinitionError(422, "Некорректный адрес Temporal");
    if (!NAMESPACE_RE.test(ns)) throw new DefinitionError(422, "Некорректный namespace Temporal");
    const cliBin = resolveTemporalCli(this.cli);
    try {
      const stdout = await this.execute(cliBin, [
        "schedule",
        "list",
        "--address",
        addr,
        "--namespace",
        ns,
        "-o",
        "json",
      ]);
      return { items: parseScheduleListOutput(stdout), warning: null };
    } catch (err) {
      const msg = String(err?.stderr || err?.message || "Temporal недоступен").trim().slice(0, 300);
      return { items: [], warning: `Не удалось получить список расписаний (${addr}/${ns}): ${msg}` };
    }
  }
}
