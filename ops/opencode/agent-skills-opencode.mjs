// agent-skills (addyosmani/agent-skills) for opencode — admin chats of the portal.
// Since 1.15.0 (FEAT-16.2) opencode runs oh-my-opencode-slim, which (unlike OmO)
// does not load Claude plugins, so the plugin is installed natively:
//   skills/<name>/      → <config>/skills/<name>/         (plain names, as the upstream opencode setup)
//   references/         → <config>/references/            (skills link ../../references/*.md)
//   agents/<name>.md    → <config>/agents/as-<name>.md    (mode: subagent)
//   .claude/commands/*  → <config>/commands/as-<name>.md  (/review is taken; build/plan are agent names)
// Tenants never get them: Sandbox has skill {"*":"deny","zai-*":"allow"} and task: deny,
// vault-cache.ts allows only zai-* skills, policy.tenantAgents hides subagents.
//   node ops/opencode/agent-skills-opencode.mjs <plugin root> <opencode config dir>
//   plugin root: %USERPROFILE%\.claude\plugins\cache\addy-agent-skills\agent-skills\<version>
import { readdirSync, readFileSync, writeFileSync, cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const [src, cfg] = process.argv.slice(2);
if (!src || !cfg || !existsSync(path.join(src, "skills"))) {
  console.error("usage: node agent-skills-opencode.mjs <plugin root> <opencode config dir>");
  process.exit(2);
}
const PERSONAS = readdirSync(path.join(src, "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));

// → {meta: {key: raw value}, body}
function split(text, file) {
  const m = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("no frontmatter: " + file);
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}
const q = (s) => JSON.stringify(String(s ?? "").replace(/^["']|["']$/g, ""));
// Claude names → opencode names: «agent-skills:<skill>» → «<skill>», persona «<p>» → «as-<p>».
function localize(text) {
  let t = text.replace(/agent-skills:([a-z0-9-]+)/g, "$1");
  for (const p of PERSONAS) t = t.replace(new RegExp("`" + p + "`", "g"), "`as-" + p + "`");
  return t;
}
const NOTE = `\n\n---\nopencode (zai): skills load with the \`skill\` tool by plain name (e.g. \`spec-driven-development\`); the personas are subagents ${PERSONAS.map((p) => "`as-" + p + "`").join(", ")} — call them with the \`task\` tool where the text says Agent tool / subagent_type.\n`;

const out = { skills: 0, agents: 0, commands: 0 };
for (const d of readdirSync(path.join(src, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory())) {
  const to = path.join(cfg, "skills", d.name);
  if (d.name.startsWith("zai-")) throw new Error("refusing to overwrite tenant skill " + d.name);
  rmSync(to, { recursive: true, force: true });
  cpSync(path.join(src, "skills", d.name), to, { recursive: true });
  out.skills++;
}
rmSync(path.join(cfg, "references"), { recursive: true, force: true });
cpSync(path.join(src, "references"), path.join(cfg, "references"), { recursive: true });

mkdirSync(path.join(cfg, "agents"), { recursive: true });
for (const p of PERSONAS) {
  const { meta, body } = split(readFileSync(path.join(src, "agents", p + ".md"), "utf8"), p);
  writeFileSync(path.join(cfg, "agents", "as-" + p + ".md"), `---\ndescription: ${q("[agent-skills] " + meta.description)}\nmode: subagent\n---\n\n${localize(body)}\n`);
  out.agents++;
}

mkdirSync(path.join(cfg, "commands"), { recursive: true });
const cdir = path.join(src, ".claude", "commands");
for (const f of readdirSync(cdir).filter((f) => f.endsWith(".md"))) {
  const { meta, body } = split(readFileSync(path.join(cdir, f), "utf8"), f);
  writeFileSync(path.join(cfg, "commands", "as-" + f), `---\ndescription: ${q("[agent-skills] " + meta.description)}\n---\n\n${localize(body)}${NOTE}`);
  out.commands++;
}
writeFileSync(path.join(cfg, "references", ".agent-skills-source"), `${src}\n${new Date().toISOString()}\n`);
console.log(JSON.stringify(out));
