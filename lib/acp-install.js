// FEAT-20.4
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, statfs, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { agents, agentDirectory, agentEntry } from "./acp-registry.js";

const run = promisify(execFile);
async function installNpm(temp, pkg) {
  const env = {PATH:process.env.PATH, HOME:temp, USERPROFILE:temp, NPM_CONFIG_USERCONFIG:path.join(temp,".npmrc")};
  const opts = {env, cwd:temp, timeout:120000, maxBuffer:1024*1024};
  const spec = pkg.name+"@"+pkg.version;
  const npm = path.join(path.dirname(process.execPath),"../lib/node_modules/npm/bin/npm-cli.js");
  const {stdout} = await run(process.execPath,[npm,"view",spec,"dist.unpackedSize","--json"],opts);
  const size = Number(JSON.parse(stdout));
  const disk = await statfs(temp);
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("Не удалось проверить размер пакета");
  if (disk.bsize*disk.bavail < Math.max(500*1024*1024,3*size)) throw new Error("Недостаточно места на диске");
  await run(process.execPath,[npm,"install","--prefix",temp,"--ignore-scripts","--engine-strict","--no-audit","--no-fund","--no-save",spec],opts);
  const manifest=JSON.parse(await readFile(path.join(temp,"node_modules",pkg.name,"package.json"),"utf8"));
  if (manifest.version !== pkg.version) throw new Error("Версия пакета не совпала");
  await rm(path.join(temp,".npm"),{recursive:true,force:true});
}

// FEAT-20.4. Бинарная поставка (Google Antigravity): самодостаточный архив
// ~274 МБ. На хосте нужна группа «nobody» — без неё par-бинарник падает при
// старте. Рядом с agy_acp_server.par в архиве лежит localharness_external.
export async function installBinary(temp, pkg, request = fetch) {
  const disk = await statfs(temp);
  if (disk.bsize*disk.bavail < Math.max(1536*1024*1024, 3*(pkg.bytes ?? 0))) throw new Error("Недостаточно места на диске");
  const archive = path.join(temp,".agent-archive.zip");
  const res = await request(pkg.archive, {signal:AbortSignal.timeout(600000)});
  if (!res.ok) throw new Error("Не удалось скачать архив агента");
  await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));
  // Поточная проверка sha256: архив большой, в память не берём.
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest("hex") !== pkg.sha256) {
    await unlink(archive).catch(() => {});
    throw Object.assign(new Error("Проверка целостности не пройдена"), {status:422});
  }
  await run("unzip", ["-qo", archive, "-d", temp], {timeout:300000, maxBuffer:1024*1024});
  await unlink(archive).catch(() => {});
  for (const file of [pkg.entry, "localharness_external"]) {
    if (existsSync(path.join(temp,file))) await chmod(path.join(temp,file), 0o755);
  }
  if (!existsSync(path.join(temp,pkg.entry))) throw new Error("В архиве нет исполняемого файла агента");
}

export class AcpInstaller {
  #pending = new Set();
  constructor(dataDir, installPackage=installNpm, installBinaryAgent=installBinary) {
    this.dataDir=dataDir;
    this.installPackage=installPackage;
    this.installBinaryAgent=installBinaryAgent;
  }
  status(id) {
    if (this.#pending.has(id)) return "installing";
    return agents.has(id) && existsSync(agentEntry(this.dataDir,id)) ? "installed" : "absent";
  }
  async install(id) {
    const target=agentDirectory(this.dataDir,id);
    if (this.#pending.has(id)) throw Object.assign(new Error("Уже устанавливается"),{status:409});
    if (this.status(id)==="installed") return;
    this.#pending.add(id);
    let temp;
    try {
      await mkdir(path.dirname(target),{recursive:true,mode:0o700});
      temp=await mkdtemp(path.join(path.dirname(target),".install-"));
      const pkg=agents.get(id);
      // FEAT-20.4. Бинарные агенты ставятся из архива, npm — как раньше.
      if (pkg.kind === "binary") await this.installBinaryAgent(temp,pkg);
      else await this.installPackage(temp,pkg);
      const placed = pkg.kind === "binary"
        ? path.join(temp,pkg.entry)
        : path.join(temp,"node_modules",pkg.name,pkg.entry);
      if (!existsSync(placed)) throw new Error("Не найден исполняемый файл");
      await rename(temp,target);
      temp=null;
    } finally {
      this.#pending.delete(id);
      if (temp) await rm(temp,{recursive:true,force:true});
    }
  }
}
