// FEAT-13.11: the knowledge-base snapshot (Obsidian «active cache») for the
// Claude CLI engine — the portal-side twin of buildSnapshot() in the opencode
// plugin ops/opencode/vault-cache.ts (same vault layout, same text shape,
// keep them in sync).
//
// Zones (FEAT-12.15): admin → ZAI_KB_ROOT (D:\Obsidian\agents) with the admin
// rules line (_index.md); tenant → only its own obsidianRoot
// (ZAI_TENANT_VAULT\<name> by default) with the tenant rules — the admin
// rules and the admin vault are never named. root null → no snapshot.
//
// The snapshot is NOT part of the user's text (FEAT-01.32): the runner sends
// it to the CLI in front of the first prompt and stores it on the user text
// part as metadata.kbContext (KB_CONTEXT_KEY), so history, titles and the
// bubble keep the typed text only; the client shows the «Контекст из базы
// знаний» row from that metadata.
//
// Zero dependencies, sync fs (a handful of small notes, once per chat).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const SNAPSHOT_MAX_CHARS = 3500;
export const KB_CONTEXT_KEY = "kbContext";

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fwd = (p) => path.resolve(String(p)).replace(/\\/g, "/").replace(/\/+$/, "");
const lc = (p) => String(p).toLowerCase();
// Paths shown to the model: native separators (backslashes on Windows only).
const win = (p) => (process.platform === "win32" ? String(p).replace(/\//g, "\\") : String(p));

export function slugOf(dir) {
  const base = String(dir ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "default";
  const s = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "default";
}
function oneLine(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
function readIfExists(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
function listMd(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const headerOf = (text) => text.match(/^#\s+(.+)$/m)?.[1].trim() ?? "";
const stripFm = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

// Zone of a portal user: {tenant: null|name, root: abs|null, home}.
// adminRoot "" / "off" / "0" / "none" → admin chats get no snapshot (feature
// off; an empty env value falls back to the default in lib/config.js, so
// "off" is the way to switch it off).
const KB_OFF = /^(|off|0|none|false)$/i;
export function zoneForUser(user, { admin, adminRoot, tenantVault, home = null }) {
  if (admin) return { tenant: null, root: adminRoot && !KB_OFF.test(String(adminRoot).trim()) ? fwd(adminRoot) : null, home };
  const name = String(user?.name || user?.id || "?");
  const own = user?.obsidianRoot ? String(user.obsidianRoot) : null;
  const safe = /^[^\\/:*?"<>|.][^\\/:*?"<>|]*$/.test(name);
  const root = own ? fwd(own) : tenantVault && safe ? fwd(path.join(tenantVault, name)) : null;
  return { tenant: name, root, home: Array.isArray(user?.directories) ? user.directories[0] ?? null : null };
}

export function tenantRules(zone) {
  const r = win(zone.root ?? "");
  return [
    `Твоя база знаний (Obsidian) — только ${r}. Подпапки: projects\\, tasks\\, decisions\\, lessons\\, sessions\\ (создавай при необходимости).`,
    `Дайджест диалога пишется автоматически в ${win(`${zone.root ?? ""}/sessions`)} — рутину не логируй; задачи/решения/уроки оформляй заметками в своей зоне.`,
    `Другие разделы D:\\Obsidian (в том числе D:\\Obsidian\\agents и зоны других пользователей) тебе недоступны: не читай и не пиши туда.`,
    personalRule(r),
  ].join(" ");
}

// BUG-169 (BUG-01.67): a question about the user himself was answered «не знаю»
// without a single search of the knowledge base.
export function personalRule(root) {
  return `Вопрос о самом пользователе (его вещи, машина, семья, планы, прошлые разговоры и задачи) — сначала поищи в базе знаний ${root} файловыми инструментами (Glob/Grep/Read, не командной строкой): посмотри список заметок, grep по словам вопроса и вероятным названиям, открой подходящие заметки — и только потом отвечай; ничего нет — скажи, что поискал и не нашёл.`;
}

function rulesLine(zone) {
  if (zone.tenant) return tenantRules(zone);
  return `Правила кэша: ${win(`${zone.root}/_index.md`)}. Задачи/решения/уроки оформляй заметками по шаблонам; рутину не логируй. ${personalRule(win(zone.root))}`;
}

// The snapshot text for the first turn of a chat in `dir`, or null.
export function buildSnapshot({ dir, sid = "", zone, now = new Date() }) {
  if (!zone?.root) return null;
  const root = zone.root;
  const slug = slugOf(dir);
  const parts = [];
  const who = zone.tenant ? `пользователя «${zone.tenant}»` : `проекта «${slug}»`;
  parts.push(`[obsidian-cache] Активный кэш ${who} (${dir}), собран ${ymd(now)} ${hm(now)}.`);

  const proj = readIfExists(`${root}/projects/${slug}.md`);
  if (proj) {
    const body = stripFm(proj).split(/\r?\n/).slice(0, 45).join("\n").trim();
    parts.push(`## Проектная заметка (projects/${slug}.md)\n${body}`);
  } else if (!zone.tenant) {
    parts.push(`Проектной заметки projects/${slug}.md нет — если работа над этим репозиторием будет повторяться, создай её по шаблону _templates/project.md.`);
  }

  const tasks = [];
  for (const f of listMd(`${root}/tasks`)) {
    const t = readIfExists(`${root}/tasks/${f}`);
    if (!t) continue;
    const fm = frontmatter(t);
    if (fm.status !== "active" || (fm.project && fm.project !== slug)) continue;
    tasks.push(`- [[${f.replace(/\.md$/, "")}]] — ${oneLine(headerOf(t) || fm.status, 90)}`);
    if (tasks.length >= 5) break;
  }
  if (tasks.length) parts.push(`## Активные задачи\n${tasks.join("\n")}`);

  const lessons = [];
  for (const f of listMd(`${root}/lessons`)) {
    const t = readIfExists(`${root}/lessons/${f}`);
    if (!t) continue;
    const fm = frontmatter(t);
    if (fm.status !== "active") continue;
    lessons.push(`- ${oneLine(headerOf(t), 80)} (area: ${fm.area || "—"})`);
    if (lessons.length >= 10) break;
  }
  if (lessons.length) parts.push(`## Уроки (полный текст — grep по lessons/)\n${lessons.join("\n")}`);

  // Earlier digests of the SAME directory: pointers only, never content
  // (BUG-12.14), and not for the catch-all home folder.
  const generic = zone.home && lc(fwd(dir)) === lc(fwd(zone.home));
  if (!generic) {
    const prev = [];
    for (const f of listMd(`${root}/sessions`).reverse()) {
      if (sid && f.includes(sid)) continue;
      const t = readIfExists(`${root}/sessions/${f}`);
      if (!t) continue;
      const fm = frontmatter(t);
      if (!fm.directory || lc(fwd(fm.directory)) !== lc(fwd(dir))) continue;
      prev.push(`- sessions/${f} — ${oneLine(headerOf(t), 80)}`);
      if (prev.length >= 3) break;
    }
    if (prev.length) parts.push(`## Прошлые дайджесты этой директории (другие диалоги, не часть текущего разговора — открывай, только если задача их продолжает)\n${prev.join("\n")}`);
  }

  parts.push(rulesLine(zone));
  let out = parts.join("\n\n");
  if (out.length > SNAPSHOT_MAX_CHARS) out = out.slice(0, SNAPSHOT_MAX_CHARS) + "\n…(снапшот обрезан, полные данные в vault)";
  return out;
}

// What the model receives: the snapshot, a separator, the typed prompt.
export function withSnapshot(snapshot, prompt) {
  return snapshot ? `${snapshot}\n\n---\n\n${prompt}` : prompt;
}
