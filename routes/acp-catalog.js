// FEAT-20.4
export function acpCatalogRoutes({registry,installer,sendJson,readJsonBody}) {
  async function catalog(refresh) {
    const result=await registry.read(refresh);
    return {...result,agents:result.agents.map(agent=>({...agent,status:installer.status(agent.id)}))};
  }
  return [
    {method:["GET","POST"],path:"/teleharness/api/acp/registry",scope:"admin",async handler({req,res}) {
      if (process.env.TELEHARNESS_ACP==="off") return sendJson(res,404,{error:"ACP отключён"});
      sendJson(res,200,await catalog(req.method==="POST"));
    }},
    {method:"POST",path:"/teleharness/api/acp/agents/install",scope:"admin",async handler({req,res}) {
      if (process.env.TELEHARNESS_ACP==="off") return sendJson(res,404,{error:"ACP отключён"});
      const body=await readJsonBody(req,2048);
      if (body?.confirmed!==true) return sendJson(res,400,{error:"Подтвердите установку"});
      const list=await registry.read();
      const agent=list.agents.find(a=>a.id===body.id && a.version===body.version && a.installable);
      if (!agent) return sendJson(res,409,{error:"Версия недоступна. Обновите каталог"});
      try {
        await installer.install(agent.id);
        return sendJson(res,200,{status:"installed"});
      } catch (err) {
        return sendJson(res,err.status??502,{error:err.status===409?"Уже устанавливается":"Не удалось установить пакет. Проверьте совместимость, свободное место и сеть."});
      }
    }}
  ];
}
