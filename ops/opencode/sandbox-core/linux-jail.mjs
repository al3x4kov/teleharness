// EPIC-17 transitional shell isolation. The privileged runner repeats all checks.
import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
export function linuxJailLine(command, { name, home, cwd = home }) {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0') || Buffer.byteLength(command) > 65536)
    return { error: 'пустая или недопустимая команда' };
  if (!/^teleharness-t-[A-Za-z0-9_-]{1,40}$/.test(name ?? '') || !home || !cwd)
    return { error: 'нет папки или имени песочницы пользователя' };
  try {
    const root = path.resolve(home), wd = path.resolve(cwd);
    const inside = (p, r) => p === r || p.startsWith(r + '/');
    if (!statSync(root).isDirectory() || !statSync(wd).isDirectory() ||
        !inside(wd, root) || !inside(realpathSync(wd), realpathSync(root)))
      return { error: 'рабочая папка команды вне вашей папки' };
    const payload = Buffer.from(JSON.stringify({ name, home: root, cwd: wd, command })).toString('base64url');
    const line = `/usr/bin/sudo -n /usr/local/libexec/teleharness-tenant-run --b64 ${payload}`;
    // JSON escaping + base64 inflate the command up to ~8x; the line is one exec
    // argument (sh -c), capped by the kernel at MAX_ARG_STRLEN = 128 KiB.
    if (line.length >= 131072) return { error: 'пустая или недопустимая команда: слишком длинная' };
    return { command: line };
  } catch { return { error: 'папка песочницы недоступна' }; }
}
