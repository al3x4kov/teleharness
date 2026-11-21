// FEAT-20.7: рабочие копии (git worktree) — чистые функции, общие для сервера
// и клиента: имя ветки из первого сообщения, сообщения агенту («разрешить
// конфликт», «починить тесты», «не трогать файлы»), подсказка о копии для
// системного промпта, тексты ошибок по kind. Без зависимостей.

export const WT_BRANCH_PREFIX = "teleharness/";
export const WT_SLUG_MAX = 32;

const TR = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  і: "i", ї: "yi", є: "ye", ґ: "g",
};

// Текст → латиница строчными (кириллица транслитом, прочее — без диакритики).
export function translit(text) {
  return String(text ?? "")
    .toLowerCase()
    .split("")
    .map((ch) => (TR[ch] !== undefined ? TR[ch] : ch))
    .join("")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
}

// Слова → `[a-z0-9-]`, не длиннее max, по границе слова, без дефисов по краям.
export function branchSlug(text, max = WT_SLUG_MAX) {
  const words = translit(text)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > max) {
      if (!out) out = w.slice(0, max);
      break;
    }
    out = next;
  }
  return out.replace(/^-+|-+$/g, "") || "task";
}

// Имя ветки: `teleharness/<slug>-<id4>`; пользовательское имя тоже приводится к виду
// `teleharness/<slug>` (N-33 «Fix Orders» → `teleharness/fix-orders`).
export function branchName(text, id4, { custom = null } = {}) {
  if (custom && String(custom).trim()) {
    const raw = String(custom).trim().replace(/^teleharness\//i, "");
    return WT_BRANCH_PREFIX + branchSlug(raw, 60);
  }
  const tail = String(id4 ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4) || "0000";
  return `${WT_BRANCH_PREFIX}${branchSlug(text)}-${tail}`;
}

// Занятое имя → суффикс -2, -3, … (N-33).
export function freeBranchName(name, taken) {
  const set = taken instanceof Set ? taken : new Set(taken ?? []);
  if (!set.has(name)) return name;
  for (let i = 2; i < 1000; i++) if (!set.has(`${name}-${i}`)) return `${name}-${i}`;
  return `${name}-${Date.now().toString(36)}`;
}

// Ветка портала: только `teleharness/…` строчными, без опасных последовательностей
// (финальную проверку делает `git check-ref-format --branch`).
export function isPortalBranch(name) {
  return typeof name === "string" && /^teleharness\/[a-z0-9][a-z0-9._/-]{0,90}$/.test(name) && !/\.\.|\/\/|\.lock$|\/$|\.$|@\{/.test(name);
}

// Сообщение агенту при конфликте (кр. 9): слить базу в ветку копии и разрешить.
export function resolveConflictText({ base = "main", branch, files = [], lang = "ru" } = {}) {
  const list = files.slice(0, 50).map((f) => `- ${f}`).join("\n");
  if (lang === "en")
    return `Merging \`${base}\` into branch \`${branch}\` gives a conflict in:\n${list}\n\nRun \`git merge ${base}\` in this worktree, resolve the conflicts keeping both changes where possible, run the tests and commit the merge. Do not switch branches.`;
  return `При слиянии \`${base}\` в ветку \`${branch}\` конфликт в файлах:\n${list}\n\nВыполни в этой рабочей копии \`git merge ${base}\`, разреши конфликты (по возможности сохрани обе правки), прогони тесты и закоммить слияние. Ветку не переключай.`;
}

// Сообщение агенту, когда тесты упали после подтягивания базы (кр. 10).
export function fixTestsText({ base = "main", cmd = "", tail = "", lang = "ru" } = {}) {
  const t = String(tail ?? "").split("\n").slice(-80).join("\n");
  if (lang === "en") return `Tests \`${cmd}\` failed after pulling \`${base}\` into this branch. Fix the code (not the tests, unless they are wrong), run the tests again and commit.\n\n\`\`\`\n${t}\n\`\`\``;
  return `Тесты \`${cmd}\` упали после подтягивания \`${base}\` в эту ветку. Почини код (тесты — только если они неверны), прогони тесты снова и закоммить.\n\n\`\`\`\n${t}\n\`\`\``;
}

// «Сообщить агенту: не трогать эти файлы» (полоса пересечения).
export function avoidFilesText({ other = "", files = [], lang = "ru" } = {}) {
  const list = files.slice(0, 50).map((f) => `- ${f}`).join("\n");
  if (lang === "en") return `${other ? `Chat “${other}”` : "Another chat"} is also editing these files — do not change them unless the task requires it:\n${list}`;
  return `${other ? `Чат «${other}»` : "Другой чат"} тоже правит эти файлы — не меняй их без необходимости:\n${list}`;
}

// Строка системной подсказки (кр. 19, 21): копия, ветка, порты.
export function worktreeRule({ branch, base, port, path: wtPath = null } = {}) {
  if (!branch) return "";
  const ports = Number.isInteger(port) ? ` Порты dev-сервера этой копии: ${port}–${port + 9} (переменная TELEHARNESS_WORKTREE_PORT=${port}); не занимай 3000/5173/8080.` : "";
  return `Ты работаешь в отдельной рабочей копии git (worktree)${wtPath ? ` \`${wtPath}\`` : ""} на ветке \`${branch}\` от \`${base}\`. Коммить в эту ветку; не переключай ветки и не трогай основную копию — слияние в \`${base}\` делает портал.${ports}`;
}

// kind ошибки → короткий заголовок для интерфейса.
export const WT_KIND_TITLE = Object.freeze({
  "not-git": "Папка не под git",
  "no-commits": "В репозитории нет ни одного коммита",
  space: "Не хватает места",
  quota: "Достигнут лимит места",
  limit: "Достигнут лимит рабочих копий",
  "dirty-config": "Опасные настройки репозитория",
  busy: "git занят другой операцией",
  conflict: "Конфликт — слияние не выполнено",
  "tests-failed": "Тесты не прошли — main не изменена",
  "tests-timeout": "Тесты не уложились во время",
  "tests-unavailable": "Тесты для пользователей недоступны на этом сервере",
  "no-tests": "Команда тестов не найдена",
  "main-dirty": "Основная копия: незакоммиченные файлы будут перезаписаны",
  "main-moved": "main изменилась во время проверки",
  "turn-running": "Дождитесь конца хода",
  gone: "Папка рабочей копии не найдена",
  "branch-switched": "В копии выбрана другая ветка",
  dirty: "В копии есть незакоммиченные файлы",
  forbidden: "Недоступно",
  interrupted: "Слияние прервано перезапуском сервера — main не изменена",
  "create-failed": "Не удалось создать рабочую копию",
  detached: "Выберите базовую ветку",
  "not-empty": "Папка чата не пуста",
});

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1).replace(".", ",")} ГБ`;
  if (v >= 1024 ** 2) return `${Math.round(v / 1024 ** 2)} МБ`;
  if (v >= 1024) return `${Math.round(v / 1024)} КБ`;
  return `${v} Б`;
}

// BUG-273: «В копии N незакоммиченных файлов и M коммитов не в <base>» — формы
// числа по правилам RU; один текст для ответа 409 сервера и диалога удаления.
const pluralRu = (n, one, few, many) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
};
export function unsavedText(u, base = "main") {
  if (!u) return "";
  const parts = [];
  if (u.uncommitted) parts.push(`${u.uncommitted} ${pluralRu(u.uncommitted, "незакоммиченный файл", "незакоммиченных файла", "незакоммиченных файлов")}`);
  if (u.commits) parts.push(`${u.commits} ${pluralRu(u.commits, "коммит", "коммита", "коммитов")} не в ${base}`);
  return parts.length ? `В копии ${parts.join(" и ")}` : "";
}
