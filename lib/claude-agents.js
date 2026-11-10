// Claude agents catalog (FEAT-13.17): markdown files with a tiny frontmatter,
// compiled into the JSON the claude CLI takes via `--agents <file>`.
//
//   shared/claude-agents/<id>.md  shipped with the portal (git)
//   data/claude-agents/<id>.md    the owner's local agents (not in git); same id
//                                 overrides the shipped file, `disabled: true`
//                                 hides it
//
// File format (same shape as Claude Code's .claude/agents/*.md):
//   ---
//   name: Workflow            display name (required)
//   description: …            one line, shown in the sheet (required)
//   tools: Read, Edit, Bash   optional, passed to the CLI as is
//   model: …                  optional, RESERVED: never passed to the CLI
//   disabled: true            optional: hide the agent (data/ override)
//   ---
//   <prompt>
//
// id = file name (^[a-z][a-z0-9-]{0,31}$): the key in --agents and the value
// of --agent, so it can never look like a CLI option. The catalog is re-read
// when any source file changes (mtime/size signature): a new file shows up
// without a portal restart. A broken file is skipped with a log line.
//
// Zero runtime dependencies - node stdlib only.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CLAUDE_AGENT_ID, isClaudeAgentId } from "../shared/engine.js";
import { writeJsonAtomic } from "./json-store.js";

export { CLAUDE_AGENT_ID, isClaudeAgentId };

// Pure: text → {meta, body} | null (no frontmatter). `key: value` lines only
// (no nested YAML); BOM and CRLF tolerated; `#` after a value is kept (the
// description may contain one) — only whole-line comments are skipped.
export function parseAgentFile(text) {
  const src = String(text ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = src.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    let val = line.slice(i + 1).trim();
    if (/^(["']).*\1$/.test(val) && val.length >= 2) val = val.slice(1, -1);
    meta[key] = val;
  }
  return { meta, body: src.slice(m[0].length).trim() };
}

const truthy = (v) => /^(true|yes|1)$/i.test(String(v ?? "").trim());

function listMd(dir) {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// Pure-ish loader: [{id, name, description, tools?, prompt, source}] sorted by
// name. data/ overrides shipped/ by id; `disabled: true` (in either) hides.
export function loadClaudeAgents({ shippedDir = null, dataDir = null, log = (m) => console.warn(m) } = {}) {
  const byId = new Map();
  for (const [source, dir] of [["shared", shippedDir], ["data", dataDir]]) {
    for (const file of listMd(dir)) {
      const id = path.basename(file).slice(0, -3);
      if (!isClaudeAgentId(id)) {
        log(`[zai-claude-agents] skipped ${file}: file name is not a valid agent id (a-z, 0-9, -)`);
        continue;
      }
      let parsed = null;
      try {
        parsed = parseAgentFile(readFileSync(file, "utf8"));
      } catch (err) {
        log(`[zai-claude-agents] skipped ${file}: ${err?.message ?? err}`);
        continue;
      }
      if (parsed && truthy(parsed.meta.disabled)) {
        byId.delete(id);
        continue;
      }
      const name = parsed?.meta.name?.trim();
      const description = parsed?.meta.description?.trim();
      if (!parsed || !name || !description || !parsed.body) {
        log(`[zai-claude-agents] skipped ${file}: needs frontmatter name, description and a prompt body`);
        continue;
      }
      const agent = { id, name: name.slice(0, 60), description: description.slice(0, 300), prompt: parsed.body, source };
      if (parsed.meta.tools?.trim()) agent.tools = parsed.meta.tools.trim();
      byId.set(id, agent);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "ru") || a.id.localeCompare(b.id));
}

// Pure: the JSON object the CLI takes (`--agents`). `model` is never passed:
// the turn's model always comes from the chat binding (--model).
export function compileAgentsJson(list) {
  const out = {};
  for (const a of list ?? []) {
    const rec = { description: a.description, prompt: a.prompt };
    if (a.tools) rec.tools = a.tools.split(",").map((t) => t.trim()).filter(Boolean);
    out[a.id] = rec;
  }
  return out;
}

export function compileClaudeAgents(list, file) {
  writeJsonAtomic(file, compileAgentsJson(list));
  return file;
}

export class ClaudeAgentCatalog {
  #shippedDir;
  #dataDir;
  #compiledPath;
  #log;
  #sig = null;
  #list = [];
  #compiledSig = null;
  // id → last known display name (the «agent gone» notice names it).
  #names = new Map();

  constructor({ shippedDir = null, dataDir = null, compiledPath = null, log = (m) => console.warn(m) } = {}) {
    this.#shippedDir = shippedDir;
    this.#dataDir = dataDir;
    this.#compiledPath = compiledPath;
    this.#log = log;
  }

  // Signature of every source file (path, mtime, size): any edit, new file
  // or removal changes it.
  #signature() {
    const parts = [];
    for (const dir of [this.#shippedDir, this.#dataDir]) {
      for (const f of listMd(dir)) {
        try {
          const st = statSync(f);
          parts.push(`${f}:${st.mtimeMs}:${st.size}`);
        } catch {}
      }
    }
    return parts.join("|");
  }

  list() {
    const sig = this.#signature();
    if (sig !== this.#sig) {
      this.#list = loadClaudeAgents({ shippedDir: this.#shippedDir, dataDir: this.#dataDir, log: this.#log });
      this.#sig = sig;
      for (const a of this.#list) this.#names.set(a.id, a.name);
    }
    return this.#list;
  }

  // What the client may see: no prompt, no paths.
  publicList() {
    return this.list().map(({ id, name, description }) => ({ id, name, description }));
  }

  get(id) {
    if (!isClaudeAgentId(id)) return null;
    return this.list().find((a) => a.id === id) ?? null;
  }

  has(id) {
    return Boolean(this.get(id));
  }

  // Display name of an id (also of an agent that has just disappeared).
  nameOf(id) {
    return this.get(id)?.name ?? this.#names.get(id) ?? id;
  }

  // The compiled --agents file, rewritten only when the catalog changed.
  // null when there is nowhere to write it.
  compiledFile() {
    if (!this.#compiledPath) return null;
    const list = this.list();
    if (this.#compiledSig !== this.#sig || !existsSync(this.#compiledPath)) {
      compileClaudeAgents(list, this.#compiledPath);
      this.#compiledSig = this.#sig;
    }
    return this.#compiledPath;
  }
}
