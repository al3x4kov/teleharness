// FEAT-20.4
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile, stat } from "node:fs/promises";
import { AcpInstaller, installBinary } from "../lib/acp-install.js";
import { agents, agentEntry } from "../lib/acp-registry.js";

const run = promisify(execFile);
test("установщик защищает от повтора и публикует пакет только после проверки", async t => {
  const dir=await mkdtemp(path.join(tmpdir(),"acp-install-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const installer=new AcpInstaller(dir,async (temp,pkg)=>{
    await gate;
    const entry=path.join(temp,"node_modules",pkg.name,pkg.entry);
    await mkdir(path.dirname(entry),{recursive:true});
    await writeFile(entry,"");
  });
  const first=installer.install("gemini");
  await assert.rejects(installer.install("gemini"),{status:409});
  assert.equal(installer.status("gemini"),"installing");
  release();
  await first;
  assert.equal(installer.status("gemini"),"installed");
  const broken=new AcpInstaller(dir,async()=>{throw new Error("test")});
  await assert.rejects(broken.install("github-copilot-cli"));
  assert.deepEqual(await readdir(path.join(dir,"acp-agents","github-copilot-cli")),[]);
});

test("обычный пользователь получает 403 до чтения реестра и запуска npm", async () => {
  const {acpCatalogRoutes}=await import("../routes/acp-catalog.js");
  const {dispatchRoute}=await import("../routes/router.js");
  let status;
  const sendJson=(_,code)=>{status=code;};
  const routes=acpCatalogRoutes({sendJson});
  await dispatchRoute(routes,{req:{method:"POST"},url:new URL("https://test/teleharness/api/acp/agents/install"),admin:false},{sendJson});
  assert.equal(status,403);
});

test("FEAT-20.4: binary-агент — sha256, раскладка без node_modules и права 755", async t => {
  const dir=await mkdtemp(path.join(tmpdir(),"acp-install-bin-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  // Локальный архив с двумя файлами бинарной поставки.
  const work=await mkdtemp(path.join(tmpdir(),"acp-bin-zip-"));
  t.after(()=>rm(work,{recursive:true,force:true}));
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const makeZip = (entries) => {
    const locals = [], centrals = [];
    let offset = 0;
    for (const [name, content] of entries) {
      const nb = Buffer.from(name, "utf8");
      const db = Buffer.from(content, "utf8");
      const crc = crc32(db);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(db.length, 18); lh.writeUInt32LE(db.length, 22); lh.writeUInt16LE(nb.length, 26);
      locals.push(lh, nb, db);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(db.length, 20); ch.writeUInt32LE(db.length, 24);
      ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42);
      centrals.push(ch, nb);
      offset += lh.length + nb.length + db.length;
    }
    const cdSize = centrals.reduce((a, b) => a + b.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, eocd]);
  };
  const bytes = makeZip([["agy_acp_server.par", "#!/bin/sh\nexit 0\n"], ["localharness_external", "harness\n"]]);
  const sha=createHash("sha256").update(bytes).digest("hex");
  const server=http.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/zip"});res.end(bytes);});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const pkg={...agents.get("antigravity"),archive:`http://127.0.0.1:${server.address().port}/agy.zip`,sha256:sha};
  const installer=new AcpInstaller(dir,null,(temp,p)=>installBinary(temp,pkg));
  await installer.install("antigravity");
  assert.equal(installer.status("antigravity"),"installed");
  const entry=agentEntry(dir,"antigravity");
  assert.equal(entry,path.join(dir,"acp-agents","antigravity","1.5.2","agy_acp_server.par"));
  if (process.platform !== "win32") {
    const mode=async file => (await stat(file)).mode & 0o777;
    assert.equal(await mode(entry),0o755);
    assert.equal(await mode(path.join(path.dirname(entry),"localharness_external")),0o755);
  }
  // Архив не переезжает в целевую папку.
  assert.deepEqual((await readdir(path.dirname(entry))).sort(),["agy_acp_server.par","localharness_external"]);

  // Неудачный sha256 — чистая ошибка, агент не публикуется, мусора не остаётся.
  const other=await mkdtemp(path.join(tmpdir(),"acp-install-bad-"));
  t.after(()=>rm(other,{recursive:true,force:true}));
  const broken=new AcpInstaller(other,null,(temp,p)=>installBinary(temp,{...pkg,sha256:"0".repeat(64)}));
  await assert.rejects(broken.install("antigravity"),{message:"Проверка целостности не пройдена"});
  assert.equal(broken.status("antigravity"),"absent");
  assert.deepEqual(await readdir(path.join(other,"acp-agents","antigravity")),[]);
});
