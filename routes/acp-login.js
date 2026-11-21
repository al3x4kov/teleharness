// FEAT-20.4
export function acpLoginRoute({ sendJson, readJsonBody, login, agent = "gemini" }) {
  return {
    method: ["GET","POST"], path: "/teleharness/api/acp/"+agent+"/login", scope: "admin",
    async handler({ req, res, user }) {
      res.setHeader("Cache-Control", "no-store");
      if (process.env.TELEHARNESS_ACP === "off") return sendJson(res, 404, {error:"ACP отключён"});
      if (req.method === "GET") return sendJson(res, 200, login.get(user.id));
      const body = await readJsonBody(req, 8192);
      if (body?.action === "start" && body.confirmed === true) {
        // FEAT-20.4. Antigravity: запасной вход по ключу Gemini API ({method, key}).
        try { return sendJson(res, 200, login.start(user.id, {method:body.method, key:body.key})); }
        catch (error) { return sendJson(res, error?.status ?? 503, {error: error?.status ? error.message : "CLI недоступен"}); }
      }
      if (agent === "gemini" && body?.action === "submit") {
        try { return sendJson(res, 200, login.submit(user.id, body.id, body.code)); }
        catch { return sendJson(res, 400, {error:"Проверьте код и состояние входа"}); }
      }
      // FEAT-20.4. Antigravity: вместо кода — адрес страницы после входа.
      if (agent === "antigravity" && body?.action === "submit") {
        try { return sendJson(res, 200, await login.submit(user.id, body.id, body.url)); }
        catch { return sendJson(res, 400, {error:"Вставьте адрес страницы после входа"}); }
      }
      return sendJson(res, 400, {error:"Требуется подтверждение входа"});
    }
  };
}
