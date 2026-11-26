// portable definition validation; never evaluates code or expressions.
import { templateRefs } from "./temporal-template.js";
export const STEP_TYPES = ["model", "approval", "timer", "condition", "parallel", "artifact", "pull_request", "command"];
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const CMD_ID = /^[a-z][a-z0-9-]{0,63}$/;
const reserved = new Set(["__proto__", "prototype", "constructor"]);
const key = v => typeof v === "string" && ID.test(v) && !reserved.has(v);
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v,max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const integer = (v,min,max) => Number.isSafeInteger(v) && v >= min && v <= max;

function resolveCatalogEntry(catalog, id) {
  if (!catalog) return undefined;
  if (typeof catalog.get === "function") return catalog.get(id);
  if (Array.isArray(catalog)) return catalog.find((c) => c?.id === id) ?? null;
  if (typeof catalog === "object") return Object.hasOwn(catalog, id) ? catalog[id] : null;
  return null;
}

// Drafts may have unfinished instructions, missing edges and cycles, but must
// remain renderable. Publication performs the separate semantic validation.
export function validDraftShape(value) {
  const string = (v,max=160) => typeof v === "string" && v.length <= max;
  if (!object(value) || !text(value.name,160) || !text(value.directory,2048) || Object.keys(value).some(k=>!["name","directory","inputs","steps"].includes(k))) return false;
  if (!Array.isArray(value.inputs) || value.inputs.length>32 || !Array.isArray(value.steps) || value.steps.length>64) return false;
  if (value.inputs.some(i=>!object(i) || !string(i.name,64) || !["string","number","boolean","array"].includes(i.type) || typeof i.required!=="boolean")) return false;
  const ids=new Set();
  for (const s of value.steps) {
    if (!object(s) || !key(s.id) || ids.has(s.id) || !STEP_TYPES.includes(s.type) || !string(s.name) || !Array.isArray(s.dependsOn) || s.dependsOn.length>64 || s.dependsOn.some(d=>!string(d,64))) return false;
    ids.add(s.id);
    if (s.type==="model" && (!string(s.engine) || !string(s.model) || !string(s.instruction,16000) || !Number.isFinite(s.timeoutSeconds) || !Number.isFinite(s.maxAttempts))) return false;
    if (s.type==="command") {
      if (!string(s.command ?? "", 64)) return false;
      if (s.args !== undefined && (!object(s.args) || Object.keys(s.args).length > 32 || Object.values(s.args).some(v => typeof v !== "string" || v.length > 500))) return false;
      if (s.timeoutSeconds !== undefined && !Number.isFinite(s.timeoutSeconds)) return false;
      if (s.maxAttempts !== undefined && !Number.isFinite(s.maxAttempts)) return false;
      if (s.successWhen !== undefined && !string(s.successWhen, 16)) return false;
    }
    if (s.type==="timer" && !Number.isFinite(s.seconds)) return false;
    if (s.type==="parallel" && !string(s.join)) return false;
    if (s.when!==undefined && (!object(s.when) || !string(s.when.input,64) || !["string","number","boolean"].includes(typeof s.when.equals))) return false;
    if (s.mapping!==undefined && (!object(s.mapping) || Object.keys(s.mapping).length>32)) return false;
    if (s.check!==undefined && (!object(s.check) || !string(s.check.source,16) || !string(s.check.ref,64) || !string(s.check.op,16) || (s.check.value!==undefined && !string(s.check.value,500)))) return false;
    if (s.source!==undefined && !string(s.source,64)) return false;
    if (s.filename!==undefined && !string(s.filename,100)) return false;
  }
  return true;
}

export function validateDefinition(value, options = {}) {
  const { catalog } = options ?? {};
  const errors = [];
  const error = (field,message) => errors.push({field,message});
  if (!object(value)) return {valid:false,errors:[{field:"definition",message:"Ожидается определение пайпа"}]};
  if (!text(value.name,160)) error("name","Название: от 1 до 160 символов");
  if (!text(value.directory,2048)) error("directory","Укажите папку проекта");
  const allowed = new Set(["name","directory","inputs","steps"]);
  if (Object.keys(value).some(k=>!allowed.has(k))) error("definition","Неизвестные поля определения");
  const inputs = Array.isArray(value.inputs) ? value.inputs : [];
  if (!Array.isArray(value.inputs) || inputs.length > 32) error("inputs","Допускается до 32 входов");
  const inputNames=new Set();
  for (const input of inputs) {
    if (!object(input) || !key(input.name) || inputNames.has(input.name)) {error("inputs","Имена входов должны быть уникальными идентификаторами");continue;}
    inputNames.add(input.name);
    if (!["string","number","boolean","array"].includes(input.type) || typeof input.required !== "boolean") error("inputs","Некорректный тип или обязательность входа");
  }
  const steps=Array.isArray(value.steps)?value.steps:[];
  if (steps.length < 1 || steps.length > 64) error("steps","Добавьте от 1 до 64 шагов");
  const byId = new Map();
  for (const step of steps) {
    if (!object(step) || !key(step.id) || byId.has(step.id)) {error("steps","Идентификаторы шагов должны быть уникальны");continue;}
    byId.set(step.id,step);
    if (!STEP_TYPES.includes(step.type)) error(step.id,"Неизвестный тип шага");
    if (!text(step.name,160)) error(step.id,"Укажите название шага");
    if (!Array.isArray(step.dependsOn) || step.dependsOn.length > 64 || step.dependsOn.some(d=>!key(d)) || new Set(step.dependsOn).size !== step.dependsOn.length) error(step.id,"Некорректные зависимости");
    if (step.type === "model") {
      if (!["opencode","claude","codex","acp"].includes(step.engine)) error(step.id,"Выберите движок");
      if (!text(step.model,160) || !text(step.instruction,16000)) error(step.id,"Укажите модель и инструкцию до 16000 символов");
      if (!integer(step.timeoutSeconds,1,86400) || !integer(step.maxAttempts,1,10)) error(step.id,"Время шага 1–86400 секунд, попытки 1–10");
      // «Отдельная рабочая копия» — одна копия запуска для всех шагов с галочкой
      if (step.worktree !== undefined && typeof step.worktree !== "boolean") error(step.id,"Отдельная рабочая копия: включите или выключите");
    }
    if (step.type === "command") {
      const cmdOk = typeof step.command === "string" && CMD_ID.test(step.command);
      if (!cmdOk) error(step.id, "Выберите команду из каталога");
      if (step.timeoutSeconds !== undefined && !integer(step.timeoutSeconds, 1, 86400)) error(step.id, "Время шага команды: 1–86400 секунд");
      if (step.maxAttempts !== undefined && !integer(step.maxAttempts, 1, 10)) error(step.id, "Попытки шага команды: 1–10");
      if (step.successWhen !== undefined && !["exit0", "always"].includes(step.successWhen)) error(step.id, "Условие успеха команды: exit0 или always");
      const argsObj = step.args === undefined ? {} : step.args;
      if (!object(argsObj) || Object.keys(argsObj).length > 32) {
        error(step.id, "Аргументы команды должны быть объектом (до 32 параметров)");
      } else {
        for (const [k, v] of Object.entries(argsObj)) {
          if (!key(k) || typeof v !== "string" || v.length > 500) {
            error(step.id, `Некорректный параметр команды «${k}»`);
          }
        }
      }
      if (cmdOk && catalog !== undefined) {
        const entry = resolveCatalogEntry(catalog, step.command);
        if (!entry) {
          error(step.id, "Команда не найдена в каталоге");
        } else {
          const declared = new Map((entry.params ?? []).map((p) => [p.name, p]));
          if (object(argsObj)) {
            for (const k of Object.keys(argsObj)) {
              if (!declared.has(k)) error(step.id, `Неизвестный параметр команды: «${k}»`);
            }
            for (const [pname, pspec] of declared) {
              if (pspec.required && (typeof argsObj[pname] !== "string" || !argsObj[pname].trim())) {
                error(step.id, `Заполните обязательный параметр «${pname}»`);
              }
            }
          }
        }
      }
    }
    if (step.type === "timer" && !integer(step.seconds,1,2592000)) error(step.id,"Таймер: 1–2592000 секунд");
    if (step.type === "parallel" && !["all-success","collect-results"].includes(step.join)) error(step.id,"Выберите правило объединения ветвей");
    if (step.when !== undefined && (!object(step.when) || !inputNames.has(step.when.input) || !Object.hasOwn(step.when,"equals") || !["string","number","boolean"].includes(typeof step.when.equals))) error(step.id,"Условие должно сравнивать объявленный вход со значением");
    if (step.type === "condition" && !step.when && !step.check) error(step.id,"Укажите условие шага");
  }
  const visiting=new Set(),visited=new Set();
  function visit(id) {
    if (visiting.has(id)) {error("steps","Циклическая зависимость шагов");return;}
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of Array.isArray(byId.get(id)?.dependsOn)?byId.get(id).dependsOn:[]) {
      if (!byId.has(dep)) error(id,"Зависимость ссылается на отсутствующий шаг");
      else visit(dep);
    }
    visiting.delete(id);visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  function ancestors(id, found=new Set()) {
    for (const dep of Array.isArray(byId.get(id)?.dependsOn)?byId.get(id).dependsOn:[]) if (!found.has(dep)) {found.add(dep);ancestors(dep,found);}
    return found;
  }
  for (const [id,step] of byId) {
    if (step.mapping === undefined) continue;
    if (!object(step.mapping) || Object.keys(step.mapping).length > 32) {error(id,"Некорректная передача данных");continue;}
    const prior=ancestors(id);
    for (const [name,source] of Object.entries(step.mapping)) {
      if (!key(name) || !object(source) || !prior.has(source.step) || source.step === id) {error(id,"Данные можно читать только из предыдущих шагов");continue;}
      if (byId.get(source.step)?.when && !Object.hasOwn(source,"fallback")) error(id,"Для условной ветви нужно значение по умолчанию");
    }
  }
  // FEAT-19.16: condition / artifact / {{refs}} — only declared inputs and earlier steps.
  const OPS=["equals","contains","not_contains","yes","no"];
  for (const [id,step] of byId) {
    const prior=ancestors(id);
    const argTexts = step.type === "command" && object(step.args) ? Object.values(step.args) : [];
    const texts=[step.instruction,step.check?.value,...argTexts].filter(t=>typeof t==="string");
    for (const ref of texts.flatMap(templateRefs)) {
      if (ref.kind==="input" && !inputNames.has(ref.name)) error(id,`Нет входа «${ref.name}» для ${ref.token}`);
      if (ref.kind==="steps" && !prior.has(ref.name)) error(id,`${ref.token}: можно ссылаться только на шаги, после которых идёт этот`);
    }
    if (step.type==="condition" && step.check!==undefined) {
      const c=step.check;
      if (!object(c) || !["input","step"].includes(c.source) || !key(c.ref) || !OPS.includes(c.op)) error(id,"Условие: выберите что проверять и как");
      else {
        if (c.source==="input" && !inputNames.has(c.ref)) error(id,"Условие ссылается на несуществующий вход");
        if (c.source==="step" && !prior.has(c.ref)) error(id,"Условие проверяет ответ шага, который идёт раньше");
        if (["equals","contains","not_contains"].includes(c.op) && !text(c.value,500)) error(id,"Условие: укажите значение");
      }
    }
    if (step.type==="artifact") {
      if (!key(step.source) || !prior.has(step.source)) error(id,"Артефакт: выберите шаг, ответ которого сохранить (он должен идти раньше)");
      if (typeof step.filename!=="string" || !/^[^\\/:*?"<>|\u0000-\u001f]{1,100}\.(md|txt|json|csv|html)$/i.test(step.filename) || step.filename.startsWith(".")) error(id,"Артефакт: имя файла с расширением .md, .txt, .json, .csv или .html");
    }
    if (step.type==="approval") {
      // optional rework loop (<= 3 cycles)
      if (step.reworkTarget !== undefined && (!key(step.reworkTarget) || !prior.has(step.reworkTarget) || byId.get(step.reworkTarget)?.type !== "model")) {
        error(id, "Доработка: укажите предыдущий модельный шаг");
      }
      if (step.maxReworks !== undefined && !integer(step.maxReworks, 1, 3)) {
        error(id, "Лимит доработок: от 1 до 3");
      }
    }
    if (step.type==="pull_request") {
      // FEAT-20.3 (1.12): описание PR — ответ модельного шага, который идёт раньше.
      if (!key(step.source) || !prior.has(step.source) || byId.get(step.source)?.type!=="model") error(id,"PR: выберите модельный шаг, который идёт раньше — его ответ станет описанием PR");
      if (step.mode!==undefined && !["new","same-branch"].includes(step.mode)) error(id,"PR: режим «новая ветка» или «та же ветка»");
      if (step.repo!==undefined && (typeof step.repo!=="string" || step.repo.length>200 || !/^[^\s/]+\/[^\s/]+$/.test(step.repo.trim()))) error(id,"PR: репозиторий должен быть в виде owner/name");
      const branchFields=[step.branch,step.base,step.title].filter((v)=>v!==undefined);
      for (const v of branchFields) if (typeof v!=="string" || v.length>200) { error(id,"PR: ветка, база и заголовок — строки до 200 символов"); break; }
      for (const ref of branchFields.filter((v)=>typeof v==="string").flatMap(templateRefs)) {
        if (ref.kind==="input" && !inputNames.has(ref.name)) error(id,`PR: нет входа «${ref.name}» для ${ref.token}`);
        if (ref.kind==="steps") error(id,`PR: в ветке и заголовке допустимы только входы (${ref.token} — нет)`);
      }
    }
  }
  return {valid:errors.length===0,errors};
}

// BUG-259: a version equal to the draft (key order ignored) is not published again.
const canon = (v) => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v);
export const sameDefinition = (a, b) => canon(a) === canon(b);
