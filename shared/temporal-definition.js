// FEAT-19.4: portable definition validation; never evaluates code or expressions.
import { templateRefs } from "./temporal-template.js";
export const STEP_TYPES = ["model", "approval", "timer", "condition", "parallel", "artifact", "pull_request"];
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const reserved = new Set(["__proto__", "prototype", "constructor"]);
const key = v => typeof v === "string" && ID.test(v) && !reserved.has(v);
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v,max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const integer = (v,min,max) => Number.isSafeInteger(v) && v >= min && v <= max;

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

// Messages (Russian; the server and its tests use them as is). The client passes
// { tr } = i18n t() → tr("temporal.v.<key>", params) with the same {param} names.
export const VALIDATION_MESSAGES = {
  notDefinition: "Ожидается определение пайпа",
  name: "Название: от 1 до 160 символов",
  directory: "Укажите папку проекта",
  unknownFields: "Неизвестные поля определения",
  inputsMax: "Допускается до 32 входов",
  inputNames: "Имена входов должны быть уникальными идентификаторами",
  inputType: "Некорректный тип или обязательность входа",
  stepsCount: "Добавьте от 1 до 64 шагов",
  stepIds: "Идентификаторы шагов должны быть уникальны",
  stepType: "Неизвестный тип шага",
  stepName: "Укажите название шага",
  dependsOn: "Некорректные зависимости",
  engine: "Выберите движок",
  modelInstruction: "Укажите модель и инструкцию до 16000 символов",
  modelLimits: "Время шага 1–86400 секунд, попытки 1–10",
  worktree: "Отдельная рабочая копия: включите или выключите",
  timer: "Таймер: 1–2592000 секунд",
  join: "Выберите правило объединения ветвей",
  when: "Условие должно сравнивать объявленный вход со значением",
  conditionMissing: "Укажите условие шага",
  cycle: "Циклическая зависимость шагов",
  missingDep: "Зависимость ссылается на отсутствующий шаг",
  mapping: "Некорректная передача данных",
  mappingPrior: "Данные можно читать только из предыдущих шагов",
  mappingFallback: "Для условной ветви нужно значение по умолчанию",
  checkShape: "Условие: выберите что проверять и как",
  checkInput: "Условие ссылается на несуществующий вход",
  checkStep: "Условие проверяет ответ шага, который идёт раньше",
  checkValue: "Условие: укажите значение",
  artifactSource: "Артефакт: выберите шаг, ответ которого сохранить (он должен идти раньше)",
  artifactFile: "Артефакт: имя файла с расширением .md, .txt, .json, .csv или .html",
  refInput: "Нет входа «{name}» для {token}",
  refStep: "{token}: можно ссылаться только на шаги, после которых идёт этот",
  reworkTarget: "Доработка: укажите предыдущий модельный шаг",
  maxReworks: "Лимит доработок: от 1 до 3",
  prSource: "PR: выберите модельный шаг, который идёт раньше — его ответ станет описанием PR",
  prMode: "PR: режим «новая ветка» или «та же ветка»",
  prFields: "PR: ветка, база и заголовок — строки до 200 символов",
  prRefInput: "PR: нет входа «{name}» для {token}",
  prRefStep: "PR: в ветке и заголовке допустимы только входы ({token} — нет)",
};
const fill = (s, params) => s.replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));

export function validateDefinition(value, { tr } = {}) {
  const msg = (k, params = {}) => (tr ? tr("temporal.v." + k, params) : fill(VALIDATION_MESSAGES[k], params));
  const errors = [];
  const error = (field,message) => errors.push({field,message});
  if (!object(value)) return {valid:false,errors:[{field:"definition",message:msg("notDefinition")}]};
  if (!text(value.name,160)) error("name",msg("name"));
  if (!text(value.directory,2048)) error("directory",msg("directory"));
  const allowed = new Set(["name","directory","inputs","steps"]);
  if (Object.keys(value).some(k=>!allowed.has(k))) error("definition",msg("unknownFields"));
  const inputs = Array.isArray(value.inputs) ? value.inputs : [];
  if (!Array.isArray(value.inputs) || inputs.length > 32) error("inputs",msg("inputsMax"));
  const inputNames=new Set();
  for (const input of inputs) {
    if (!object(input) || !key(input.name) || inputNames.has(input.name)) {error("inputs",msg("inputNames"));continue;}
    inputNames.add(input.name);
    if (!["string","number","boolean","array"].includes(input.type) || typeof input.required !== "boolean") error("inputs",msg("inputType"));
  }
  const steps=Array.isArray(value.steps)?value.steps:[];
  if (steps.length < 1 || steps.length > 64) error("steps",msg("stepsCount"));
  const byId = new Map();
  for (const step of steps) {
    if (!object(step) || !key(step.id) || byId.has(step.id)) {error("steps",msg("stepIds"));continue;}
    byId.set(step.id,step);
    if (!STEP_TYPES.includes(step.type)) error(step.id,msg("stepType"));
    if (!text(step.name,160)) error(step.id,msg("stepName"));
    if (!Array.isArray(step.dependsOn) || step.dependsOn.length > 64 || step.dependsOn.some(d=>!key(d)) || new Set(step.dependsOn).size !== step.dependsOn.length) error(step.id,msg("dependsOn"));
    if (step.type === "model") {
      if (!["opencode","claude","codex","acp"].includes(step.engine)) error(step.id,msg("engine"));
      if (!text(step.model,160) || !text(step.instruction,16000)) error(step.id,msg("modelInstruction"));
      if (!integer(step.timeoutSeconds,1,86400) || !integer(step.maxAttempts,1,10)) error(step.id,msg("modelLimits"));
      // FEAT-20.7: «Отдельная рабочая копия» — одна копия запуска для всех шагов с галочкой
      if (step.worktree !== undefined && typeof step.worktree !== "boolean") error(step.id,msg("worktree"));
    }
    if (step.type === "timer" && !integer(step.seconds,1,2592000)) error(step.id,msg("timer"));
    if (step.type === "parallel" && !["all-success","collect-results"].includes(step.join)) error(step.id,msg("join"));
    if (step.when !== undefined && (!object(step.when) || !inputNames.has(step.when.input) || !Object.hasOwn(step.when,"equals") || !["string","number","boolean"].includes(typeof step.when.equals))) error(step.id,msg("when"));
    if (step.type === "condition" && !step.when && !step.check) error(step.id,msg("conditionMissing"));
  }
  const visiting=new Set(),visited=new Set();
  function visit(id) {
    if (visiting.has(id)) {error("steps",msg("cycle"));return;}
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of Array.isArray(byId.get(id)?.dependsOn)?byId.get(id).dependsOn:[]) {
      if (!byId.has(dep)) error(id,msg("missingDep"));
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
    if (!object(step.mapping) || Object.keys(step.mapping).length > 32) {error(id,msg("mapping"));continue;}
    const prior=ancestors(id);
    for (const [name,source] of Object.entries(step.mapping)) {
      if (!key(name) || !object(source) || !prior.has(source.step) || source.step === id) {error(id,msg("mappingPrior"));continue;}
      if (byId.get(source.step)?.when && !Object.hasOwn(source,"fallback")) error(id,msg("mappingFallback"));
    }
  }
  // FEAT-19.16: condition / artifact / {{refs}} — only declared inputs and earlier steps.
  const OPS=["equals","contains","not_contains","yes","no"];
  for (const [id,step] of byId) {
    const prior=ancestors(id);
    const texts=[step.instruction,step.check?.value].filter(t=>typeof t==="string");
    for (const ref of texts.flatMap(templateRefs)) {
      if (ref.kind==="input" && !inputNames.has(ref.name)) error(id,msg("refInput",{name:ref.name,token:ref.token}));
      if (ref.kind==="steps" && !prior.has(ref.name)) error(id,msg("refStep",{token:ref.token}));
    }
    if (step.type==="condition" && step.check!==undefined) {
      const c=step.check;
      if (!object(c) || !["input","step"].includes(c.source) || !key(c.ref) || !OPS.includes(c.op)) error(id,msg("checkShape"));
      else {
        if (c.source==="input" && !inputNames.has(c.ref)) error(id,msg("checkInput"));
        if (c.source==="step" && !prior.has(c.ref)) error(id,msg("checkStep"));
        if (["equals","contains","not_contains"].includes(c.op) && !text(c.value,500)) error(id,msg("checkValue"));
      }
    }
    if (step.type==="artifact") {
      if (!key(step.source) || !prior.has(step.source)) error(id,msg("artifactSource"));
      if (typeof step.filename!=="string" || !/^[^\\/:*?"<>|\u0000-\u001f]{1,100}\.(md|txt|json|csv|html)$/i.test(step.filename) || step.filename.startsWith(".")) error(id,msg("artifactFile"));
    }
    if (step.type==="approval") {
      if (step.reworkTarget !== undefined && (!key(step.reworkTarget) || !prior.has(step.reworkTarget) || byId.get(step.reworkTarget)?.type !== "model")) {
        error(id, msg("reworkTarget"));
      }
      if (step.maxReworks !== undefined && !integer(step.maxReworks, 1, 3)) {
        error(id, msg("maxReworks"));
      }
    }
    if (step.type==="pull_request") {
      if (!key(step.source) || !prior.has(step.source) || byId.get(step.source)?.type!=="model") error(id,msg("prSource"));
      if (step.mode!==undefined && !["new","same-branch"].includes(step.mode)) error(id,msg("prMode"));
      const branchFields=[step.branch,step.base,step.title].filter((v)=>v!==undefined);
      for (const v of branchFields) if (typeof v!=="string" || v.length>200) { error(id,msg("prFields")); break; }
      for (const ref of branchFields.filter((v)=>typeof v==="string").flatMap(templateRefs)) {
        if (ref.kind==="input" && !inputNames.has(ref.name)) error(id,msg("prRefInput",{name:ref.name,token:ref.token}));
        if (ref.kind==="steps") error(id,msg("prRefStep",{token:ref.token}));
      }
    }
  }
  return {valid:errors.length===0,errors};
}

// BUG-259: a version equal to the draft (key order ignored) is not published again.
const canon = (v) => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v);
export const sameDefinition = (a, b) => canon(a) === canon(b);
