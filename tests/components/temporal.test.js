// FEAT-19.14 (was FEAT-19.1/19.4/19.6/19.7): Temporal v2 — real component
// state, no simulated executions. Every state of the mockup that the client
// owns has a test here; server contracts live in tests/temporal-routes.test.js.
import {test,before,afterEach} from "node:test";
import assert from "node:assert/strict";
import {$,$$,createHarness,loadUI} from "./helpers/load.mjs";
import {installFetch,fetchCalls} from "./helpers/dom.mjs";
let ui,h;
before(async()=>{ui=await loadUI({TemporalView:"src/components/views/TemporalView.jsx",DefinitionEditor:"src/components/temporal/DefinitionEditor.jsx",
  RunDetail:"src/components/temporal/RunDetail.jsx",StartRun:"src/components/temporal/StartRun.jsx",ScheduleForm:"src/components/temporal/Schedules.jsx#ScheduleForm",
  describeCron:"src/components/temporal/Schedules.jsx#describeCron",previewTimes:"src/components/temporal/Schedules.jsx#previewTimes",toCron:"src/components/temporal/Schedules.jsx#toCron",attention:"src/lib/temporal-attention.js#temporalAttention",refreshAttention:"src/lib/temporal-attention.js#refreshTemporalAttention"});h=createHarness(ui);
  ui.store.me.value={id:"admin",role:"admin"};});
afterEach(()=>{h.cleanup();installFetch();if(typeof location!=="undefined")location.hash="";});
const draft=()=>({name:"Review",directory:"/srv/project",inputs:[],steps:[{id:"approve",type:"approval",name:"Решение",dependsOn:[]}]});
const record=()=>({id:"a",revision:1,draft:draft(),versions:[]});
const caps={definitions:true,execution:{available:true,reason:"Исполнение подключено"},engines:["opencode"],subscriptionModels:{},pipelineAvailable:true,runListAvailable:true,schedulesAvailable:true};
const byText=(root,text,sel="button,a")=>[...root.querySelectorAll(sel)].find(b=>b.textContent.includes(text));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const change=(el,v)=>h.act(()=>{el.value=v;el.dispatchEvent(new Event("change",{bubbles:true}));});
const run=(id,kind,extra={})=>({workflowId:id,definitionId:"a",name:"Пайп "+id,version:1,accepted:true,source:"manual",steps:[{id:"gate",name:"Решение",type:"approval"}],
  summary:{kind,status:kind==="ok"?"COMPLETED":"RUNNING",startTime:new Date().toISOString(),stepsTotal:1,current:kind==="wait"?{id:"gate",name:"Решение",index:1}:null,waiting:kind==="wait"},...extra});

// ——— Запуски ———
test("список: статус каждого запуска без нажатий, блок «Ждут вашего решения» и счётчик фильтра",async()=>{
 installFetch([{path:"/teleharness/api/temporal/capabilities",reply:()=>caps},{path:"/teleharness/api/temporal/runs",reply:()=>[run("w1","wait"),run("w2","run"),run("w3","ok")]}]);
 const {root}=h.mount(ui.TemporalView);
 await h.waitFor(()=>root.textContent.includes("Ждут вашего решения"));
 assert($(root,".t-attn").textContent.includes("Пайп w1"));
 assert(root.textContent.includes("Выполняется"));assert(root.textContent.includes("Завершён"));
 assert(root.textContent.includes("Шаг 1 из 1 · Решение"));
 assert(byText(root,"Ждут меня · 1"));assert(!byText(root,"Проверить состояние"));
 assert.equal($(root,`a[href="#/temporal/run/w1"]`)!==null,true);
});
test("пустой фильтр «Ошибки» объясняет 14 дней и возвращает ко всем",async()=>{
 installFetch([{path:"/teleharness/api/temporal/capabilities",reply:()=>caps},{path:"/teleharness/api/temporal/runs",reply:()=>[run("w3","ok")]}]);
 const {root}=h.mount(ui.TemporalView);await h.waitFor(()=>byText(root,"Ошибки"));
 h.click(byText(root,"Ошибки"));await h.flush();
 assert(root.textContent.includes("Ошибок нет"));assert(root.textContent.includes("14 дней"));
 h.click(byText(root,"Показать все запуски"));await h.flush();assert(root.textContent.includes("Пайп w3"));
});
test("поиск по ID запуска",async()=>{
 installFetch([{path:"/teleharness/api/temporal/capabilities",reply:()=>caps},{path:"/teleharness/api/temporal/runs",reply:()=>[run("abc-1","ok"),run("xyz-2","ok")]}]);
 const {root}=h.mount(ui.TemporalView);await h.waitFor(()=>root.textContent.includes("Пайп abc-1"));
 h.typeInto($(root,'[aria-label="Поиск запусков"]'),"xyz");await h.flush();
 assert(!root.textContent.includes("Пайп abc-1"));assert(root.textContent.includes("Пайп xyz-2"));
});
test("первый вход: объяснение в три шага, без «Запусков пока нет» до ответа сервера",async()=>{
 let resolve;const pending=new Promise(r=>{resolve=r;});
 installFetch([{path:"/teleharness/api/temporal/capabilities",reply:()=>caps},{path:"/teleharness/api/temporal/runs",reply:()=>pending}]);
 const {root}=h.mount(ui.TemporalView);await h.flush();
 assert(root.textContent.includes("Загружаем"));assert(!root.textContent.includes("Запусков пока нет"));
 resolve([]);await h.waitFor(()=>root.textContent.includes("Запусков пока нет"));
 assert(root.textContent.includes("Опубликуйте версию"));assert(byText(root,"Создать пайп"));
});
test("ошибка списка не превращается в пустой список и предлагает повтор",async()=>{
 installFetch([{path:"/teleharness/api/temporal/capabilities",reply:()=>caps},{path:"/teleharness/api/temporal/runs",reply:()=>({status:503,body:{error:"Хранилище недоступно"}})}]);
 const {root}=h.mount(ui.TemporalView);await h.waitFor(()=>root.textContent.includes("Не удалось загрузить запуски"));
 assert(root.textContent.includes("Хранилище недоступно"));assert(!root.textContent.includes("Запусков пока нет"));assert(byText(root,"Повторить"));
});
test("Temporal не отвечает: незавершённые запуски unavailable — баннер «не потеряны», admin видит службы",async()=>{
 installFetch([{path:"/teleharness/api/temporal/capabilities",reply:()=>caps},{path:"/teleharness/api/temporal/runs",reply:()=>[run("w1","unavailable"),run("w2","ok")]}]);
 const {root}=h.mount(ui.TemporalView);await h.waitFor(()=>root.textContent.includes("Temporal не отвечает"));
 assert(root.textContent.includes("не потеряны"));assert(root.textContent.includes("teleharness-temporal-pipeline-v1"));
 h.cleanup();ui.store.me.value={id:"t",role:"tenant"};
 installFetch([{path:"/teleharness/api/temporal/capabilities",reply:()=>caps},{path:"/teleharness/api/temporal/runs",reply:()=>[run("w1","unavailable")]}]);
 const t=h.mount(ui.TemporalView);await h.waitFor(()=>t.root.textContent.includes("Temporal не отвечает"));
 assert(!t.root.textContent.includes("teleharness-temporal"));ui.store.me.value={id:"admin",role:"admin"};
});
test("недоступный runtime не отображается пустым списком запусков",async()=>{
 installFetch([{path:"/teleharness/api/temporal/capabilities",reply:()=>({...caps,runListAvailable:false,execution:{available:false,reason:"Исполнение Temporal ещё не подключено"}})}]);
 const {root}=h.mount(ui.TemporalView);await h.waitFor(()=>root.textContent.includes("ещё не подключено"));
 assert(!root.textContent.includes("Запусков пока нет"));assert.equal(fetchCalls.filter(c=>c.path.endsWith("/runs")).length,0);
});

// ——— Запуск ———
const detail=(over={})=>({workflowId:"w",runId:"run",status:"RUNNING",name:"Контроль",version:2,definitionId:"a",source:"manual",startTime:new Date().toISOString(),
  steps:[{id:"prep",name:"Подготовка",type:"timer"},{id:"review",name:"Одобрение",type:"approval"},{id:"pub",name:"Публикация",type:"timer"}],
  resultSteps:["prep"],state:{generation:"gen",steps:{prep:"completed",review:"running",pub:"waiting"},pending:["review"],paused:false},summary:{kind:"wait"},...over});
test("решение рядом с результатом: одобрение привязано к runId, поколению и шагу; повтор сохраняет actionId",async()=>{
 const sent=[];let fail=true;
 installFetch([{path:"/teleharness/api/temporal/runs/w",reply:()=>detail()},{path:"/teleharness/api/temporal/runs/w/results/prep",reply:()=>({text:"Изменено 4 файла"})},
  {method:"POST",path:"/teleharness/api/temporal/runs/w/actions",reply:req=>{sent.push(req.body);if(fail){fail=false;return {status:503,body:{error:"Temporal не подтвердил действие"}};}return {accepted:true};}}]);
 const {root}=h.mount(ui.RunDetail,{workflowId:"w"});
 await h.waitFor(()=>root.textContent.includes("Изменено 4 файла"));
 assert(root.textContent.includes("Шаг «Одобрение» ждёт вашего решения"));assert(root.textContent.includes("продолжится с шага «Публикация»"));
 h.click($(root,'[data-action="approve"]'));await h.waitFor(()=>sent.length===1);
 await h.waitFor(()=>!$(root,'[data-action="approve"]').disabled);
 assert.equal(sent[0].runId,"run");assert.equal(sent[0].generation,"gen");assert.equal(sent[0].stepId,"review");assert.match(sent[0].actionId,/^[a-f0-9-]{36}$/);
 h.click($(root,'[data-action="approve"]'));await h.waitFor(()=>sent.length===2);
 assert.notEqual(sent[1].actionId,undefined);
});
test("409 при решении — тост «запуск изменился» и перечитывание, а не пропажа экрана",async()=>{
 let reads=0;
 installFetch([{path:"/teleharness/api/temporal/runs/w",reply:()=>{reads++;return detail({resultSteps:[]});}},
  {method:"POST",path:"/teleharness/api/temporal/runs/w/actions",reply:()=>({status:409,body:{error:"Требуется актуальное решение по шагу"}})}]);
 const {root}=h.mount(ui.RunDetail,{workflowId:"w"});await h.waitFor(()=>$(root,'[data-action="approve"]'));
 h.click($(root,'[data-action="approve"]'));await h.waitFor(()=>document.body.textContent.includes("запуск изменился"));
 assert(reads>=2);assert(root.textContent.includes("Контроль"));
});
test("отклонение — шторка с последствиями и необязательным комментарием",async()=>{
 const sent=[];installFetch([{path:"/teleharness/api/temporal/runs/w",reply:()=>detail({resultSteps:[]})},{method:"POST",path:"/teleharness/api/temporal/runs/w/actions",reply:req=>{sent.push(req.body);return {accepted:true};}}]);
 const {root}=h.mount(ui.RunDetail,{workflowId:"w"});await h.waitFor(()=>$(root,'[data-action="reject"]'));
 h.click($(root,'[data-action="reject"]'));await h.flush();
 assert(document.body.textContent.includes("следующие шаги не выполнятся"));assert.equal(sent.length,0);
 h.typeInto(document.querySelector('[aria-label="Комментарий к отклонению"]'),"Не трогать Drawer");
 h.click(document.querySelector('[data-action="confirm-reject"]'));await h.waitFor(()=>sent.length===1);
 assert.equal(sent[0].action,"reject");assert.equal(sent[0].reason,"Не трогать Drawer");
});
test("отмена требует подтверждения; принудительная остановка — причины",async()=>{
 const sent=[];installFetch([{path:"/teleharness/api/temporal/runs/w",reply:()=>detail({resultSteps:[],state:{generation:"g",steps:{prep:"running"},pending:[],paused:false},summary:{kind:"run"}})},
  {method:"POST",path:"/teleharness/api/temporal/runs/w/actions",reply:req=>{sent.push(req.body);return {accepted:true};}}]);
 const {root}=h.mount(ui.RunDetail,{workflowId:"w"});await h.waitFor(()=>$(root,'[data-action="cancel"]'));
 h.click($(root,'[data-action="cancel"]'));await h.flush();assert.equal(sent.length,0);
 assert(document.body.textContent.includes("нельзя продолжить"));
 h.click(document.querySelector('[data-action="confirm-cancel"]'));await h.waitFor(()=>sent.length===1);assert.equal(sent[0].action,"cancel");
 await h.waitFor(()=>!$(root,'[data-action="terminate"]').disabled);
 h.click($(root,'[data-action="terminate"]'));await h.flush();
 assert(document.querySelector('[data-action="confirm-terminate"]').disabled);
 h.typeInto(document.querySelector('[aria-label="Причина остановки"]'),"Завис");
 h.click(document.querySelector('[data-action="confirm-terminate"]'));await h.waitFor(()=>sent.length===2);assert.equal(sent[1].reason,"Завис");
});
test("пауза показывает баннер и «Продолжить»",async()=>{
 installFetch([{path:"/teleharness/api/temporal/runs/w",reply:()=>detail({state:{generation:"g",steps:{prep:"completed"},pending:["review"],paused:true},summary:{kind:"paused"},resultSteps:[]})}]);
 const {root}=h.mount(ui.RunDetail,{workflowId:"w"});await h.waitFor(()=>root.textContent.includes("Запуск на паузе"));
 assert($(root,'[data-action="resume"]'));assert(!$(root,'[data-action="approve"]'));
});
test("квота подписки объяснена у шага: продолжится сам, платный API не используется",async()=>{
 installFetch([{path:"/teleharness/api/temporal/runs/w",reply:()=>detail({steps:[{id:"m",name:"Разбор писем",type:"model"}],state:{generation:"g",steps:{m:"quota_wait"},pending:[],paused:false},summary:{kind:"quota"},resultSteps:[]})}]);
 const {root}=h.mount(ui.RunDetail,{workflowId:"w"});await h.waitFor(()=>root.textContent.includes("Шаг ждёт очереди к подписке"));
 assert(root.textContent.includes("Платный API не используется"));assert(root.textContent.includes("Ждёт квоту подписки"));
});
test("завершённый: результаты по шагам и «Запустить заново» на ту же версию",async()=>{
 installFetch([{path:"/teleharness/api/temporal/runs/w",reply:()=>detail({status:"COMPLETED",state:{steps:{prep:"completed",review:"completed",pub:"completed"}},summary:{kind:"ok"},closeTime:new Date().toISOString()})},
  {path:"/teleharness/api/temporal/runs/w/results/prep",reply:()=>({text:"Готово"})}]);
 const {root}=h.mount(ui.RunDetail,{workflowId:"w"});await h.waitFor(()=>root.textContent.includes("Завершён"));
 assert($(root,'a[href="#/temporal/start/a?v=2"]'));assert(!$(root,'[data-action="cancel"]'));
 h.click(byText(root,"Показать ответ"));await h.waitFor(()=>root.textContent.includes("Готово"));
});
test("403/404 — экран «Запуск недоступен», действия пропадают",async()=>{
 installFetch([{path:"/teleharness/api/temporal/runs/w",reply:()=>({status:404,body:{error:"Запуск не найден"}})}]);
 const {root}=h.mount(ui.RunDetail,{workflowId:"w"});await h.waitFor(()=>root.textContent.includes("Запуск недоступен"));
 assert(root.textContent.includes("14 дней"));assert(!$(root,'[data-action="cancel"]'));
 h.cleanup();
 installFetch([{path:"/teleharness/api/temporal/runs/w",reply:()=>detail({resultSteps:[],state:{generation:"g",steps:{},pending:[],paused:false},summary:{kind:"run"}})},
  {method:"POST",path:"/teleharness/api/temporal/runs/w/actions",reply:()=>({status:403,body:{error:"Доступ к проекту отозван"}})}]);
 const b=h.mount(ui.RunDetail,{workflowId:"w"});await h.waitFor(()=>$(b.root,'[data-action="pause"]'));
 h.click($(b.root,'[data-action="pause"]'));await h.waitFor(()=>b.root.textContent.includes("Запуск недоступен"));
});
test("workflow расписания с меткой времени в пути читается",async()=>{
 const id="teleharness-schedule-a-2026-11-18T07:34:49Z";
 installFetch([{path:"/teleharness/api/temporal/runs/"+id,reply:()=>detail({workflowId:id,status:"COMPLETED",source:"schedule",summary:{kind:"ok"},state:null,resultSteps:[]})}]);
 const {root}=h.mount(ui.RunDetail,{workflowId:id});await h.waitFor(()=>root.textContent.includes("по расписанию"));
});

// ——— Редактор ———
test("BUG-250 + BUG-251: новый пайп — проект подставлен сервером, пути нет; после публикации есть «Запустить»",async()=>{
 let created;
 installFetch([{path:"/teleharness/api/temporal/projects",reply:()=>({projects:[{directory:"/srv/p",name:"p"}],default:"/srv/p"})},
  {method:"POST",path:"/teleharness/api/temporal/definitions",reply:req=>{created=req.body.draft;return {id:"n",revision:1,draft:created,folder:"pipelines/ревью",versions:[]};}},
  {method:"POST",path:"/teleharness/api/temporal/definitions/n/publish",reply:()=>({id:"n",revision:2,draft:created,folder:"pipelines/ревью",versions:[{version:1,definition:created}]})}]);
 const {root}=h.mount(ui.DefinitionEditor,{pipelineAvailable:true,engines:["claude"],subscriptionModels:{}});
 await h.waitFor(()=>!$(root,'[aria-label="Проект"]').disabled);
 assert.equal($(root,'[aria-label="Папка проекта"]'),null);assert(!root.textContent.includes("Абсолютный путь"));
 h.typeInto($(root,'[aria-label="Название пайпа"]'),"Ревью");
 h.click(byText(root,"Добавить шаг"));await h.flush();h.click($(root,'[data-type="approval"]'));await h.flush();
 h.click($(root,'[data-action="publish"]'));await h.waitFor(()=>root.textContent.includes("Версия 1 опубликована"));
 assert.equal(created.directory,"/srv/p");assert.deepEqual(created.inputs,[]);assert($(root,'[data-action="start"]'));
 assert(root.textContent.includes("pipelines/ревью"));
});
test("меню шагов: «Модель» без подписок недоступна с причиной; «Условие» и «Артефакт» доступны",async()=>{
 const {root}=h.mount(ui.DefinitionEditor,{record:record(),engines:["claude"],subscriptionModels:{}});
 h.click(byText(root,"Добавить шаг"));await h.flush();
 assert.equal($(root,'[data-type="model"]').getAttribute("aria-disabled"),"true");assert(root.textContent.includes("не подключены к пайпам"));
 h.click($(root,'[data-type="model"]'));await h.flush();assert.equal($$(root,".t-stepc").length,1);
 assert.equal($(root,'[data-type="condition"]').getAttribute("aria-disabled"),null);
 h.click($(root,'[data-type="condition"]'));await h.flush();assert.equal($$(root,".t-stepc").length,2);
 assert(root.textContent.includes("шаги после него пропускаются"));
});
test("модельный шаг выбирает модель подписки; неисполнимая версия перечисляет причины и не даёт запуск",async()=>{
 const r=record();r.versions=[{version:2,definition:{...draft(),steps:[{id:"a",type:"model",name:"Ревью",engine:"opencode",model:"project-default",instruction:"x",timeoutSeconds:60,maxAttempts:1,dependsOn:[]}]}}];
 const {root}=h.mount(ui.DefinitionEditor,{record:r,pipelineAvailable:true,engines:["opencode","claude"],subscriptionModels:{claude:["haiku","sonnet"]}});
 h.click(byText(root,"Добавить шаг"));await h.flush();h.click($(root,'[data-type="model"]'));await h.flush();
 assert.equal($(root,'[aria-label="Модель подписки"]').value,"haiku");
 assert(root.textContent.includes("Эту версию нельзя запустить"));assert(!$(root,'[data-action="start"]'));
});
test("ошибки: публикация без названия показывает ошибку у поля и в «Готовности», запрос не уходит",async()=>{
 const {root}=h.mount(ui.DefinitionEditor,{engines:["opencode"],subscriptionModels:{}});
 h.click($(root,'[data-action="publish"]'));await h.flush();
 assert(root.textContent.includes("Введите название"));assert(root.textContent.includes("Добавьте от 1 до 64 шагов"));
 assert.equal(fetchCalls.some(c=>c.method==="POST"),false);
});
test("автосохранение черновика и бейдж «сохранён»",async()=>{
 let saved;installFetch([{method:"PUT",path:"/teleharness/api/temporal/definitions/a",reply:req=>{saved=req.body;return {...record(),revision:2,draft:req.body.draft};}}]);
 const {root}=h.mount(ui.DefinitionEditor,{record:record(),engines:["opencode"]});
 h.typeInto($(root,'[aria-label="Название пайпа"]'),"Обновлённый");
 await sleep(1400);await h.waitFor(()=>saved);assert.equal(saved.revision,1);assert.equal(saved.draft.name,"Обновлённый");
 await h.waitFor(()=>root.textContent.includes("Черновик сохранён"));
});
test("409 при сохранении: правки остаются на экране, выбор «загрузить сохранённую / моя поверх»",async()=>{
 let puts=0;installFetch([{method:"PUT",path:"/teleharness/api/temporal/definitions/a",reply:req=>{puts++;return puts===1?{status:409,body:{error:"Пайп изменён в другом окне"}}:{...record(),revision:6,draft:req.body.draft};}},
  {path:"/teleharness/api/temporal/definitions/a",reply:()=>({...record(),revision:5})}]);
 const {root}=h.mount(ui.DefinitionEditor,{record:record(),engines:["opencode"]});
 h.typeInto($(root,'[aria-label="Название пайпа"]'),"Моя правка");
 await sleep(1400);await h.waitFor(()=>root.textContent.includes("изменили в другой вкладке"));
 assert.equal($(root,'[aria-label="Название пайпа"]').value,"Моя правка");assert.equal(fetchCalls.some(x=>x.path.includes("/publish")),false);
 h.click(byText(root,"Сохранить мою поверх"));await h.waitFor(()=>puts===2);
 const last=fetchCalls.filter(c=>c.method==="PUT").at(-1);assert.equal(last.body.revision,5);assert.equal(last.body.draft.name,"Моя правка");
});
test("шаги: «Выше» сохраняет простую цепочку, удаление можно вернуть",async()=>{
 const r=record();r.draft.steps=[{id:"s1",type:"timer",name:"Первый",seconds:60,dependsOn:[]},{id:"s2",type:"approval",name:"Второй",dependsOn:["s1"]}];
 installFetch([{method:"PUT",path:"/teleharness/api/temporal/definitions/a",reply:req=>({...r,revision:2,draft:req.body.draft})}]);
 const {root}=h.mount(ui.DefinitionEditor,{record:r,engines:["opencode"]});
 h.click($(root,'[aria-label="Выше: Второй"]'));await h.flush();
 const names=$$(root,".t-stepc-head b").map(b=>b.textContent);assert.deepEqual(names,["Второй","Первый"]);
 assert(root.textContent.includes("после «Второй»"));
 h.click($(root,'[aria-label="Удалить шаг 1"]'));await h.flush();assert.equal($$(root,".t-stepc").length,1);
 h.click(byText(root,"Вернуть"));await h.flush();assert.equal($$(root,".t-stepc").length,2);
});
test("тенант видит только свои проекты с сервера, путь не вводится",async()=>{
 ui.store.me.value={id:"t",role:"tenant",directories:["/home/t/proj"]};
 installFetch([{path:"/teleharness/api/temporal/projects",reply:()=>({projects:[{directory:"/home/t/proj",name:"proj"}],default:"/home/t/proj"})}]);
 const {root}=h.mount(ui.DefinitionEditor,{engines:["claude","codex"],codexTextOnly:true,subscriptionModels:{codex:["gpt"]}});
 await h.waitFor(()=>$$(root,'[aria-label="Проект"] option').length===2);
 const opts=$$(root,'[aria-label="Проект"] option').map(o=>o.textContent);
 assert(opts.some(o=>o.includes("proj")));assert(!opts.some(o=>o.includes("/home/t")));assert.equal($(root,'[aria-label="Папка проекта"]'),null);
 h.click(byText(root,"Добавить шаг"));await h.flush();h.click($(root,'[data-type="model"]'));await h.flush();
 assert(root.textContent.includes("Codex отвечает только текстом"));
 ui.store.me.value={id:"admin",role:"admin"};
});

// ——— Старт ———
test("форма запуска: версия по ссылке, ключ запроса один на форму, повтор после ошибки не создаёт второй запуск",async()=>{
 const bodies=[];let n=0;
 const r=record();r.versions=[{version:1,definition:draft()},{version:2,definition:draft()}];
 installFetch([{path:"/teleharness/api/temporal/definitions",reply:()=>[{id:"a",name:"Review",latestVersion:2}]},{path:"/teleharness/api/temporal/definitions/a",reply:()=>r},
  {method:"POST",path:"/teleharness/api/temporal/runs",reply:req=>{bodies.push(req.body);return ++n===1?{status:503,body:{error:"Temporal не подтвердил запуск"}}:{workflowId:"w9",version:req.body.version};}}]);
 const {root}=h.mount(ui.StartRun,{definitionId:"a",capabilities:caps,initialVersion:1});
 await h.waitFor(()=>$(root,'[data-action="start"]')&&!$(root,'[data-action="start"]').disabled);
 // happy-dom не синхронизирует <select>.value с selected; реальный select проверяет стенд (new-pipe-browser).
 assert($(root,'[data-action="start"]').textContent.includes("версию 1"));
 h.click($(root,'[data-action="start"]'));await h.waitFor(()=>root.textContent.includes("Запуск не принят"));
 h.click($(root,'[data-action="start"]'));await h.waitFor(()=>root.textContent.includes("Запуск принят"));
 assert.equal(bodies[0].requestId,bodies[1].requestId);assert.equal(bodies[0].version,1);assert(root.textContent.includes("«Review», версия 1"));
 assert($(root,'a[href="#/temporal/run/w9"]'));
});
test("нечего запускать — объяснение и путь к пайпам",async()=>{
 installFetch([{path:"/teleharness/api/temporal/definitions",reply:()=>[{id:"a",name:"Черновик",latestVersion:null}]}]);
 const {root}=h.mount(ui.StartRun,{capabilities:caps});await h.waitFor(()=>root.textContent.includes("Запускать пока нечего"));
});

// ——— Расписания ———
test("расписания: человеческое описание, пауза подтверждается сервером, «Запустить сейчас»",async()=>{
 const s={id:"s",definitionId:"a",name:"Сводка",version:1,cron:"0 9 * * 1-5",timezone:"Europe/Moscow",overlap:"skip",catchupSeconds:3600,nextTimes:["2026-12-01T06:00:00Z"],paused:false};
 installFetch([{path:"/teleharness/api/temporal/capabilities",reply:()=>caps},{path:"/teleharness/api/temporal/schedules",reply:()=>[s]},{path:"/teleharness/api/temporal/runs",reply:()=>[]},
  {method:"POST",path:"/teleharness/api/temporal/schedules/s/pause",reply:()=>({...s,paused:true})}]);
 const {root}=h.mount(ui.TemporalView,{section:"schedules"});
 await h.waitFor(()=>root.textContent.includes("По будням в 09:00"));assert(root.textContent.includes("Europe/Moscow"));
 assert($(root,'a[href="#/temporal/start/a?v=1"]'));
 h.click($(root,'[data-action="pause-schedule"]'));await h.waitFor(()=>$(root,'[data-action="resume-schedule"]'));
});
test("расписание без доступа показано с причиной, без переключателя",async()=>{
 installFetch([{path:"/teleharness/api/temporal/capabilities",reply:()=>caps},{path:"/teleharness/api/temporal/runs",reply:()=>[]},
  {path:"/teleharness/api/temporal/schedules",reply:()=>[{id:"s",definitionId:"a",name:"Документация",version:2,cron:"0 21 * * 1-5",timezone:"UTC",overlap:"skip",blocked:"Нет доступа к проекту или движку пайпа — срабатывания пропускаются"}]}]);
 const {root}=h.mount(ui.TemporalView,{section:"schedules"});await h.waitFor(()=>root.textContent.includes("Срабатывания пропускаются"));
 assert(!$(root,'[data-action="pause-schedule"]'));
});
test("новое расписание: превью ближайших запусков до создания, неверный пояс — ошибка у поля, запрос не уходит",async()=>{
 const r=record();r.versions=[{version:3,definition:draft()}];let body;
 installFetch([{path:"/teleharness/api/temporal/definitions",reply:()=>[{id:"a",name:"Review",latestVersion:3}]},{path:"/teleharness/api/temporal/definitions/a",reply:()=>r},
  {method:"POST",path:"/teleharness/api/temporal/schedules",reply:req=>{body=req.body;return {...req.body,id:"x"};}}]);
 location.hash="#/temporal/schedules/new?def=a&v=3";
 const {root}=h.mount(ui.ScheduleForm,{capabilities:caps});
 await h.waitFor(()=>root.textContent.includes("Ближайшие запуски"));
 h.typeInto($(root,'[aria-label="Часовой пояс"]'),"Not/AZone");await h.flush();
 h.click($(root,'[data-action="create-schedule"]'));await h.flush();
 assert(root.textContent.includes("Нет такого пояса"));assert.equal(body,undefined);
 h.typeInto($(root,'[aria-label="Часовой пояс"]'),"Europe/Moscow");await h.flush();
 h.click($(root,'[data-action="create-schedule"]'));await h.waitFor(()=>body);
 assert.equal(body.cron,"0 9 * * *");assert.equal(body.version,3);assert.equal(body.timezone,"Europe/Moscow");assert.match(body.requestId,/^[a-f0-9-]{36}$/);
});
test("cron: пресеты и описание, превью по поясу",()=>{
 assert.equal(ui.toCron("weekdays","10:30","0",""),"30 10 * * 1-5");assert.equal(ui.toCron("hourly","","15",""),"15 * * * *");
 assert.equal(ui.describeCron("30 10 * * 1-5"),"По будням в 10:30");assert.equal(ui.describeCron("5 * * * *"),"Каждый час, в :05");
 const from=Date.parse("2026-11-20T12:00:00Z"); // пятница
 const next=ui.previewTimes("weekdays","09:00","0","Europe/Moscow",3,from);
 assert.deepEqual(next.map(d=>d.toISOString()),["2026-11-23T06:00:00.000Z","2026-11-24T06:00:00.000Z","2026-11-25T06:00:00.000Z"]);
});

test("счётчик «ждут решения»: вкладка показывает число; сбой сети не обнуляет",async()=>{
 let fail=false;installFetch([{path:"/teleharness/api/temporal/capabilities",reply:()=>caps},{path:"/teleharness/api/temporal/runs",reply:()=>[]},
  {path:"/teleharness/api/temporal/attention",reply:()=>fail?"network":{waiting:2}}]);
 await ui.refreshAttention();assert.equal(ui.attention.value,2);
 const {root}=h.mount(ui.TemporalView);await h.waitFor(()=>$(root,".t-count"));assert.equal($(root,".t-count").textContent,"2");
 fail=true;installFetch([{path:"/teleharness/api/temporal/attention",reply:"network"}]);await ui.refreshAttention();assert.equal(ui.attention.value,2);
 ui.attention.value=0;
});

// ——— FEAT-19.16 ———
test("FEAT-19.16: итог запуска — ответ модели markdown, файлы папки запуска, «Открыть разговор», пропущенный шаг и условие",async()=>{
 installFetch([{path:"/teleharness/api/temporal/runs/w",reply:()=>detail({status:"COMPLETED",summary:{kind:"ok"},closeTime:new Date().toISOString(),
   steps:[{id:"check",name:"Проверка",type:"model",engine:"claude",model:"claude-haiku-4-5"},{id:"gate",name:"Если ОК",type:"condition"},{id:"fix",name:"Исправить",type:"model",engine:"codex",model:"gpt"},{id:"save",name:"Сохранить",type:"artifact"}],
   state:{steps:{check:"completed",gate:"completed",fix:"skipped",save:"skipped"},conditions:{gate:false}},resultSteps:["check"],
   chats:{check:"ses_step1"},files:[{path:"runs/r1/отчёт.md",name:"отчёт.md",size:10}],runFolder:"runs/r1",workspace:"/srv/p/pipelines/x",inputs:{task:"проверить docs"}})},
  {path:"/teleharness/api/temporal/runs/w/results/check",reply:()=>({text:"**Всё ОК**, ошибок нет"})}]);
 const {root}=h.mount(ui.RunDetail,{workflowId:"w"});
 await h.waitFor(()=>root.textContent.includes("Всё ОК"));
 assert($(root,".t-final strong"));assert(root.textContent.includes("Ответ шага «Проверка»"));
 assert($(root,'a[href="#/chat/ses_step1"]'));assert(root.textContent.includes("отчёт"));assert(root.textContent.includes("runs/r1"));
 assert(root.textContent.includes("пропущен — условие не выполнено"));assert(root.textContent.includes("условие: нет"));
 assert(root.textContent.includes("проверить docs"));
});
test("FEAT-19.16: форма запуска — входы по схеме, обязательный проверяется до запроса, значения уходят на сервер",async()=>{
 const bodies=[];const r=record();r.versions=[{version:1,definition:{...draft(),inputs:[{name:"task",type:"string",required:true},{name:"urgent",type:"boolean",required:false}],
   steps:[{id:"m",type:"model",name:"Ответ",engine:"claude",model:"claude-haiku-4-5",instruction:"{{input.task}}",timeoutSeconds:60,maxAttempts:1,dependsOn:[]}]}}];
 installFetch([{path:"/teleharness/api/temporal/definitions",reply:()=>[{id:"a",name:"Review",latestVersion:1}]},{path:"/teleharness/api/temporal/definitions/a",reply:()=>r},
  {method:"POST",path:"/teleharness/api/temporal/runs",reply:req=>{bodies.push(req.body);return {workflowId:"w1",version:1};}}]);
 const {root}=h.mount(ui.StartRun,{definitionId:"a",capabilities:{...caps,subscriptionModels:{claude:["claude-haiku-4-5"]}},initialVersion:1});
 await h.waitFor(()=>$(root,'[aria-label="task"]'));
 assert(root.textContent.includes("расходуют лимит ваших подписок"));
 h.click($(root,'[data-action="start"]'));await h.flush();
 assert(root.textContent.includes("Заполните «task»"));assert.equal(bodies.length,0);
 h.typeInto($(root,'[aria-label="task"]'),"Проверить docs");
 h.click($(root,'[data-action="start"]'));await h.waitFor(()=>bodies.length===1);
 assert.deepEqual(bodies[0].inputs,{task:"Проверить docs"});
});
test("FEAT-19.16: редактор — вход, кнопки вставки {{input}} и {{steps}} в инструкцию, условие и артефакт по предыдущему шагу",async()=>{
 const r=record();r.draft.steps=[{id:"draft",type:"model",name:"Черновик",engine:"claude",model:"claude-haiku-4-5",instruction:"Напиши",timeoutSeconds:600,maxAttempts:1,dependsOn:[]},
   {id:"rev",type:"model",name:"Проверка",engine:"codex",model:"gpt",instruction:"Проверь ",timeoutSeconds:600,maxAttempts:1,dependsOn:["draft"]}];
 installFetch([{path:"/teleharness/api/temporal/projects",reply:()=>({projects:[{directory:"/srv/project",name:"project"}],default:"/srv/project"})},
  {method:"PUT",path:"/teleharness/api/temporal/definitions/a",reply:req=>({...r,revision:2,draft:req.body.draft})}]);
 const {root}=h.mount(ui.DefinitionEditor,{record:r,engines:["claude","codex"],subscriptionModels:{claude:["claude-haiku-4-5"],codex:["gpt"]}});
 h.click(byText(root,"＋ Вход"));await h.flush();assert.equal($(root,'[aria-label="Имя входа 1"]').value,"task");
 h.click($$(root,".t-stepc-head")[1]);await h.flush();
 h.click(byText(root,"ответ «Черновик»","button"));await h.flush();h.click(byText(root,"вход «task»","button"));await h.flush();
 assert.equal($(root,'[aria-label="Инструкция"]').value,"Проверь {{steps.draft}}{{input.task}}");
 h.click(byText(root,"Добавить шаг"));await h.flush();h.click($(root,'[data-type="artifact"]'));await h.flush();
 assert.equal($(root,'[aria-label="Имя файла"]').value,"итог.md");
 assert(root.textContent.includes("Схема без ошибок"));
});

test("BUG-255: экран Temporal не вкладывает второй .view (overscroll-behavior: contain глушил прокрутку main.view)",async()=>{
 installFetch([{path:"/teleharness/api/temporal/capabilities",reply:()=>caps},{path:"/teleharness/api/temporal/runs",reply:()=>[]}]);
 const {root}=h.mount(ui.TemporalView);await h.waitFor(()=>$(root,".temporal-view"));
 assert.equal($(root,".temporal-view").classList.contains("view"),false);assert.equal($$(root,".view").length,0);
});

test("BUG-254: пустой новый пайп — «Готовность» нейтральная, красная только после попытки публикации",async()=>{
 installFetch([{path:"/teleharness/api/temporal/projects",reply:()=>({projects:[{directory:"/srv/p",name:"p"}],default:"/srv/p"})}]);
 const {root}=h.mount(ui.DefinitionEditor,{engines:["claude"],subscriptionModels:{}});
 await h.flush();
 assert.equal($$(root,".t-ready .t-err-text").length,0);assert(root.textContent.includes("Чтобы опубликовать, осталось"));assert($(root,".t-ready .t-todo-text"));
 h.click($(root,'[data-action="publish"]'));await h.flush();
 assert($(root,".t-ready .t-err-text"));
});

test("BUG-258: расписание для версии с обязательным входом — причина видна сразу, «Создать» недоступна, «Исправьте поля» не показывается",async()=>{
 const r=record();r.versions=[{version:1,definition:{...draft(),inputs:[{name:"task",type:"string",required:true}]}}];let posted=false;
 installFetch([{path:"/teleharness/api/temporal/definitions",reply:()=>[{id:"a",name:"Review",latestVersion:1}]},{path:"/teleharness/api/temporal/definitions/a",reply:()=>r},
  {method:"POST",path:"/teleharness/api/temporal/schedules",reply:()=>{posted=true;return {id:"x"};}}]);
 location.hash="#/temporal/schedules/new?def=a&v=1";
 const {root}=h.mount(ui.ScheduleForm,{capabilities:caps});
 await h.waitFor(()=>root.textContent.includes("нельзя запускать по расписанию"));
 assert(root.textContent.includes("«task»"));assert.equal($(root,'[data-action="create-schedule"]').disabled,true);
 h.click($(root,'[data-action="create-schedule"]'));await h.flush();
 assert(!root.textContent.includes("Исправьте отмеченные поля"));assert.equal(posted,false);
});

test("BUG-259: без изменений после публикации кнопка недоступна («Версия N актуальна»); после правки — снова «Опубликовать версию N+1»",async()=>{
 const r=record();r.versions=[{version:1,definition:structuredClone(r.draft)}];
 installFetch([{path:"/teleharness/api/temporal/projects",reply:()=>({projects:[{directory:"/srv/project",name:"project"}],default:"/srv/project"})},
  {method:"PUT",path:"/teleharness/api/temporal/definitions/a",reply:req=>({...r,revision:2,draft:req.body.draft})}]);
 const {root}=h.mount(ui.DefinitionEditor,{record:r,engines:["claude"],subscriptionModels:{}});
 const btn=()=>$(root,'[data-action="publish"]');
 assert.equal(btn().disabled,true);assert(btn().textContent.includes("Версия 1 актуальна"));
 h.typeInto($(root,'[aria-label="Название пайпа"]'),"Review 2");await h.flush();
 assert.equal(btn().disabled,false);assert(btn().textContent.includes("Опубликовать версию 2"));
});

test("ответ шага перед решением не дублируется «Промежуточным итогом»",async()=>{
 installFetch([{path:"/teleharness/api/temporal/runs/w",reply:()=>detail({steps:[{id:"prep",name:"Подготовка",type:"model",engine:"claude",model:"m"},{id:"review",name:"Одобрение",type:"approval"}],
   state:{generation:"gen",steps:{prep:"completed",review:"running"},pending:["review"],paused:false},resultSteps:["prep"],summary:{kind:"wait"}})},
  {path:"/teleharness/api/temporal/runs/w/results/prep",reply:()=>({text:"Черновик"})}]);
 const {root}=h.mount(ui.RunDetail,{workflowId:"w"});
 await h.waitFor(()=>root.textContent.includes("Черновик"));
 assert.equal($(root,".t-final"),null);assert.equal(root.textContent.split("Черновик").length-1,1);
});

// ——— BUG-264 п.6: удаление пайпа ———
test("BUG-264 п.6: «Удалить пайп…» — лист с именем и последствиями, «Не удалять» закрывает, подтверждение — DELETE и возврат к списку",async()=>{
 installFetch([{method:"DELETE",path:"/teleharness/api/temporal/definitions/a",reply:()=>({id:"a",deleted:true})}]);
 const n=h.mount(ui.DefinitionEditor,{engines:["opencode"],subscriptionModels:{}});
 assert.equal($(n.root,'[data-action="delete-pipe"]'),null,"у несохранённого пайпа удалять нечего");h.cleanup();
 const {root}=h.mount(ui.DefinitionEditor,{record:record(),engines:["opencode"],subscriptionModels:{}});
 const btn=$(root,'[data-action="delete-pipe"]');assert(btn);assert.match(btn.className,/t-btn/);assert.match(btn.textContent,/Удалить пайп/);
 h.click(btn);await h.flush();
 const sheet=document.querySelector('[role="dialog"]');assert(sheet);assert.equal(sheet.getAttribute("aria-label"),"Удалить пайп «Review»?");
 assert(sheet.textContent.includes("Завершённые запуски и их файлы останутся"));
 h.click(byText(sheet,"Не удалять"));await h.flush();assert.equal(document.querySelector('[role="dialog"]'),null);
 assert.equal(fetchCalls.some(c=>c.method==="DELETE"),false);
 h.click($(root,'[data-action="delete-pipe"]'));await h.flush();
 h.click(document.querySelector('[data-action="confirm-delete"]'));
 await h.waitFor(()=>location.hash==="#/temporal/pipes");
 assert.equal(fetchCalls.filter(c=>c.method==="DELETE"&&c.path==="/teleharness/api/temporal/definitions/a").length,1);
});
test("BUG-264 п.6: 409 — лист остаётся и показывает причину сервера; 403 и 404 объяснены словами",async()=>{
 const why="Пайп «Review» нельзя удалить: идёт запусков: 1. Дождитесь их завершения или отмените на вкладке «Запуски». Затем удалите пайп.";
 let reply={status:409,body:{error:why}};
 installFetch([{method:"DELETE",path:"/teleharness/api/temporal/definitions/a",reply:()=>reply}]);
 const {root}=h.mount(ui.DefinitionEditor,{record:record(),engines:["opencode"],subscriptionModels:{}});
 const confirm=async()=>{h.click(document.querySelector('[data-action="confirm-delete"]'));await h.waitFor(()=>document.querySelector('[role="dialog"] [role="alert"]'));return document.querySelector('[role="dialog"] [role="alert"]').textContent;};
 h.click($(root,'[data-action="delete-pipe"]'));await h.flush();
 assert.equal(await confirm(),why);assert.notEqual(location.hash,"#/temporal/pipes");
 reply={status:403,body:{error:"outside your scope"}};assert.match(await confirm(),/Нет доступа к проекту/);
 reply={status:404,body:{error:"Пайп не найден"}};assert.match(await confirm(),/Пайпа уже нет/);
 h.click(byText(document.querySelector('[role="dialog"]'),"К пайпам"));await h.flush();assert.equal(location.hash,"#/temporal/pipes");
});
test("BUG-264 п.6: запуск удалённого пайпа читается — имя с пометкой, без «Запустить заново» и ссылки на пайп",async()=>{
 installFetch([{path:"/teleharness/api/temporal/runs/w",reply:()=>detail({status:"COMPLETED",pipeDeleted:true,state:{steps:{prep:"completed",review:"completed",pub:"completed"}},summary:{kind:"ok"},closeTime:new Date().toISOString()})}]);
 const {root}=h.mount(ui.RunDetail,{workflowId:"w"});await h.waitFor(()=>root.textContent.includes("Завершён"));
 assert(root.textContent.includes("Контроль"));assert(root.textContent.includes("пайп удалён"));
 assert.equal($(root,'a[href^="#/temporal/start/"]'),null);assert.equal($(root,'a[href^="#/temporal/pipe/"]'),null);
 h.cleanup();
 installFetch([{path:"/teleharness/api/temporal/capabilities",reply:()=>caps},{path:"/teleharness/api/temporal/runs",reply:()=>[run("w1","ok",{pipeDeleted:true})]}]);
 const l=h.mount(ui.TemporalView);await h.waitFor(()=>l.root.textContent.includes("Пайп w1"));
 assert(l.root.textContent.includes("Пайп удалён · Версия 1"));
});
test("BUG-264 п.6: расписание удалённого пайпа — «Пайп удалён», без переключателя, «Запустить сейчас» и ссылки на пайп",async()=>{
 installFetch([{path:"/teleharness/api/temporal/capabilities",reply:()=>caps},{path:"/teleharness/api/temporal/runs",reply:()=>[]},
  {path:"/teleharness/api/temporal/schedules",reply:()=>[{id:"s",definitionId:"a",name:"Документация",version:2,cron:"0 21 * * 1-5",timezone:"UTC",overlap:"skip",pipeDeleted:true,blocked:"Пайп удалён — расписание больше не срабатывает"}]}]);
 const {root}=h.mount(ui.TemporalView,{section:"schedules"});await h.waitFor(()=>root.textContent.includes("Пайп удалён"));
 assert(!root.textContent.includes("Срабатывания пропускаются"));assert(!$(root,'[role="switch"]'));
 assert.equal($(root,'a[href^="#/temporal/start/"]'),null);assert.equal($(root,'a[href^="#/temporal/pipe/"]'),null);
});
