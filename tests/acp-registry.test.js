// FEAT-20.4
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AcpRegistry } from "../lib/acp-registry.js";

test("каталог кэширует закреплённую поставку и переживает недоступность источника", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "registry-"));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const agent = {id:"github-copilot-cli",name:"GitHub Copilot CLI",version:"1.0.114",distribution:{npx:{package:"@github/copilot@1.0.114"}}};
  let count=0;
  const catalog = new AcpRegistry(dir, async () => {
    if (++count > 1) throw new Error("network");
    return Response.json({agents:[agent, {id:"broken"}]});
  });
  assert.equal((await catalog.read()).skipped,1);
  assert.equal((await catalog.read()).agents[0].installable,true);
  assert.equal(count,1);
  const offline = await catalog.read(true);
  assert.equal(offline.agents.length,1);
  assert.ok(offline.error);
});

test("FEAT-20.4: binary-агент installable по платформе linux-x86_64, провайдер — «Google Antigravity»", async t => {
  const {acpProviderCatalog}=await import("../lib/acp-registry.js");
  const dir=await mkdtemp(path.join(tmpdir(),"registry-bin-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  // Реестровый id — antigravity-acp, внутренний ключ — antigravity: каталог
  // транслирует его, иначе установка и статус не бьют в установленный агент.
  const agy={id:"antigravity-acp",name:"Google Antigravity",version:"1.5.2",distribution:{binary:{"linux-x86_64":{archive:"https://dl.google.com/agy.zip"}}}};
  const catalog=new AcpRegistry(dir,async()=>Response.json({agents:[
    agy,
    {...agy,version:"1.5.1"},
    {...agy,distribution:{binary:{"darwin-arm64":{}}}},
    {...agy,distribution:{binary:{"linux-x86_64":{}}},id:"github-copilot-cli",version:"1.0.114"}
  ]}));
  const list=(await catalog.read()).agents;
  assert.deepEqual(list.map(a=>[a.id,a.installable]),[
    ["antigravity",true],
    ["antigravity",false],
    ["antigravity",false],
    ["github-copilot-cli",false]
  ]);
  const base={all:[],default:{},connected:[]};
  const providers=acpProviderCatalog(base,["antigravity","github-copilot-cli"]);
  assert.equal(providers.all[0].name,"Google Antigravity");
  assert.equal(providers.all[1].name,"GitHub Copilot CLI");
  assert.equal(acpProviderCatalog(base,["gemini"]).all[0].name,"Gemini CLI");
});
