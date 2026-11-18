// FEAT-19.16 (U013 п.3): {{input.<name>}} and {{steps.<id>}} in step texts.
// Pure, shared by the editor (insert/preview) and the server (render before a step runs).
const RE = /\{\{\s*(input|steps)\.([a-zA-Z][a-zA-Z0-9_-]{0,63})\s*\}\}/g;
export function templateRefs(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(RE)) out.push({ kind: m[1], name: m[2], token: m[0] });
  return out;
}
// Unknown refs render as "" — publication validation rejects them before a run.
export function renderTemplate(text, { inputs = {}, steps = {} } = {}) {
  return String(text ?? "").replace(RE, (_, kind, name) => {
    const v = kind === "input" ? inputs[name] : steps[name];
    if (v === undefined || v === null) return "";
    return Array.isArray(v) ? v.join("\n") : String(v);
  });
}
export const inputToken = (name) => `{{input.${name}}}`;
export const stepToken = (id) => `{{steps.${id}}}`;
