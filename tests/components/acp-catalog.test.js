// FEAT-20.4
import test from "node:test";
import assert from "node:assert/strict";
import { byText, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

test("каталог запрашивает подтверждение выбранной версии до установки", async t=>{
  const ui=await loadUI({AcpCatalog:"src/components/views/AcpCatalog.jsx"});
  const h=createHarness(ui);
  t.after(()=>h.cleanup());
  let installs=0;
  installFetch([
    {method:"GET",path:"/teleharness/api/acp/registry",reply:()=>({agents:[{id:"github-copilot-cli",name:"GitHub Copilot",version:"1.0.114",installable:true,status:installs?"installed":"absent"}]})},
    {method:"GET",path:"/teleharness/api/acp/github-copilot-cli/login",reply:()=>({status:"idle"})},
    {method:"POST",path:"/teleharness/api/acp/agents/install",reply:()=>{installs++;return {status:"installed"};}}
  ]);
  const {root}=h.mount(ui.AcpCatalog);
  await h.waitFor(()=>root.textContent.includes("Агенты не установлены"));
  h.click(byText(root,"button","Каталог агентов"));
  h.click(byText(root,"button","Установить"));
  assert.equal(installs,0);
  assert.match(root.textContent,/Установить GitHub Copilot версии 1.0.114/);
  h.click(byText(root,"button","Подтвердить установку"));
  await h.waitFor(()=>root.textContent.includes("Войти через GitHub"));
  assert.equal(installs,1);
});
