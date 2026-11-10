// BUG-188: слэш-команды opencode в GLM-чатах не раскрываются. Раньше их
// раскрывал хук auto-slash-command из oh-my-opencode; в slim (FEAT-16.2)
// такого хука нет, и текст «/as-spec …» уходил модели буквально. Портал сам
// распознаёт команду и зовёт upstream POST /session/:id/command — здесь
// только чистые функции разбора и сборки тела; маршрутизация в server.js.
//
// Zero runtime dependencies - node stdlib only.
import { GLM_VARIANTS, isGlm53 } from "./glm-variant.js";

export { GLM_VARIANTS };

// Имя команды после «/»: латиница, цифры, точка, подчёркивание, дефис
// (opencode так и генерирует имена из файлов команд; «/привет» — не команда).
const SLASH_RE = /^\/([A-Za-z0-9._-]+)(?=\s|$)/;

// Pure: текст одного текстового parts-элемента → { name, arguments } | null.
// arguments — остаток после имени, trim; «/имя» без аргументов → "".
// Имя обязано быть в списке команд папки (names: Set или Array), иначе текст
// уходит обычным prompt — так же ведёт себя и сам opencode.
export function parseSlash(text, names) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  const m = SLASH_RE.exec(t);
  if (!m) return null;
  const name = m[1];
  const known = names instanceof Set ? names.has(name) : Array.isArray(names) && names.includes(name);
  if (!known) return null;
  return { name, arguments: t.slice(m[0].length).trim() };
}

// Pure: тело upstream POST /session/:id/command (opencode 1.19.5, GET /doc:
// {command, arguments} обязательны, model — СТРОКА «providerID/modelID»,
// agent/variant опциональны, additionalProperties:false — поля system/parts
// текстом туда не пройти). variant ставится по тому же правилу BUG-180, что
// для prompt-тел (GLM-5.3 без явного варианта → ZAI_GLM_VARIANT).
export function commandBody(opts = {}) {
  const { arguments: args, agent = null, model = null, variantSetting = null } = opts ?? {};
  const command = opts?.command;
  if (!command || typeof command !== "string") return null;
  const out = { command, arguments: typeof args === "string" ? args : "" };
  if (typeof agent === "string" && agent.trim()) out.agent = agent.trim();
  const providerID = typeof model?.providerID === "string" ? model.providerID.trim() : "";
  const modelID = typeof model?.modelID === "string" ? model.modelID.trim() : "";
  if (providerID && modelID) out.model = `${providerID}/${modelID}`;
  if (GLM_VARIANTS.includes(variantSetting) && variantSetting !== "off" && isGlm53({ providerID, modelID })) {
    out.variant = variantSetting;
  }
  return out;
}
