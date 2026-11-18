// FEAT-19.16 (U013 п.3): run inputs, checked against the pinned version.
import { DefinitionError } from "./definitions.js";

export function cleanInputs(declared = [], raw = {}) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new DefinitionError(400, "Некорректные входы запуска");
  const known = new Map(declared.map((i) => [i.name, i]));
  for (const k of Object.keys(raw)) if (!known.has(k)) throw new DefinitionError(400, `Неизвестный вход «${k}»`);
  const out = {};
  for (const input of declared) {
    let v = raw[input.name];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
    if (empty) {
      if (input.required) throw new DefinitionError(400, `Заполните вход «${input.name}»`);
      continue;
    }
    if (input.type === "string") {
      if (typeof v !== "string" || v.length > 20000) throw new DefinitionError(400, `Вход «${input.name}»: текст до 20000 символов`);
    } else if (input.type === "number") {
      v = typeof v === "string" ? Number(v.replace(",", ".")) : v;
      if (!Number.isFinite(v)) throw new DefinitionError(400, `Вход «${input.name}»: нужно число`);
    } else if (input.type === "boolean") {
      if (typeof v !== "boolean") throw new DefinitionError(400, `Вход «${input.name}»: да или нет`);
    } else if (input.type === "array") {
      if (typeof v === "string") v = v.split("\n").map((x) => x.trim()).filter(Boolean);
      if (!Array.isArray(v) || v.length > 200 || v.some((x) => typeof x !== "string" || x.length > 2000)) throw new DefinitionError(400, `Вход «${input.name}»: список строк`);
    }
    out[input.name] = v;
  }
  return out;
}
export const hasRequiredInputs = (definition) => (definition.inputs ?? []).some((i) => i.required);
