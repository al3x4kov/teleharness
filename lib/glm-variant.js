// BUG-180 (BUG-11.16): explicit reasoning effort for GLM-5.3 turns.
//
// opencode builds the variants of zai-coding-plan/glm-5.3* from models.dev
// (`reasoning_options: effort low|high|max`) and sends `reasoning_effort` only
// when the prompt names a variant. The portal sends the model alone, so the
// effort silently followed the provider's default (max today) and the OmO
// `reasoning` of the agent never applied to a portal-chosen model. Here a GLM
// turn without `variant` gets ZAI_GLM_VARIANT (default max, "off" disables).
// An explicit variant and every other model are left alone.

export const GLM_VARIANTS = ["off", "low", "high", "max"];

const isGlm53 = (m) => m?.providerID === "zai-coding-plan" && typeof m.modelID === "string" && /^glm-5\.3(?:$|-)/.test(m.modelID);

// BUG-188 (lib/slash.js): тот же предикат нужен сборке тела /command.
export { isGlm53 };

// Pure: a prompt body object → the same object, or a copy with `variant`.
export function withGlmVariant(body, setting) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  if (!GLM_VARIANTS.includes(setting) || setting === "off") return body;
  if ("variant" in body && body.variant != null && body.variant !== "") return body;
  if (!isGlm53(body.model)) return body;
  return { ...body, variant: setting };
}

// A prompt_async body (Buffer/string) → Buffer; rewritten only when needed.
export function withGlmVariantBody(out, setting) {
  const buf = Buffer.isBuffer(out) ? out : Buffer.from(String(out));
  let obj = null;
  try {
    obj = JSON.parse(buf.toString("utf8"));
  } catch {
    return buf;
  }
  const next = withGlmVariant(obj, setting);
  return next === obj ? buf : Buffer.from(JSON.stringify(next), "utf8");
}
