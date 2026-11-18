import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {pipelineArtifacts} from "../lib/temporal/artifacts.js";

test("результат связан с запуском и шагом, повтор сохраняет ссылку",async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"temporal-result-"));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const store=pipelineArtifacts(new DatabaseSync(":memory:"),root);
 await writeFile(path.join(root,"qa-receipt"),"Результат");
 store.remember("run-one","step","qa-receipt");
 store.remember("run-one","step","qa-receipt");
 assert.deepEqual(store.steps("run-one"),["step"]);
 assert.equal(await store.read("run-one","step"),"Результат");
 await assert.rejects(store.read("run-two","step"),e=>e.status===404);
 assert.throws(()=>store.remember("run-one","step","other"));
 assert.throws(()=>store.remember("run-one","step","../result"));
});
