// TASK-12.18 / ADR-001 step 3: workspace-file routes (moved out of
// server.js handleApi without behaviour change). The directory gate lives in
// routes/router.js (scope "dirQuery"); handlers get ctx.dir already allowed.
//
// deps: { sendJson, homeDir, fileRoots, serveWorkspaceFile,
//         workspaceFileExists, turnFiles, parseWindows, errLog,
//         dirProblem, driveProblem, dirProblemText, dirAllowed }
export function fileRoutes(deps) {
  const { sendJson } = deps;
  return [
    // Binary attachment upload: streamed to the session folder. Tenants may
    // only land files inside their own scope, within their per-file limit and
    // total quota (BUG-12.10). Scope "user": the directory rules differ from
    // dirQuery (admin shape check, body drained on refusal, defaultDir) and
    // stay in the handler verbatim.
    {
      method: "POST",
      path: "/zai/api/upload",
      scope: "user",
      handler: ({ req, res, url, user, admin }) => {
        const { config } = deps;
        let dir = url.searchParams.get("directory");
        if (dir) {
          if (admin) {
            const problem = deps.dirProblem(dir);
            if (problem) {
              req.resume();
              return sendJson(res, 400, { error: deps.dirProblemText(problem), code: problem });
            }
          }
          if (!deps.dirAllowed(user, dir)) {
            req.resume();
            return sendJson(res, 403, { error: "outside your scope" });
          }
        } else {
          dir = deps.defaultDir(user, deps.chatDir);
        }
        if (admin) return deps.handleUpload(req, res, url, dir);
        const quota = config.ZAI_TENANT_UPLOAD_QUOTA;
        const used = quota ? deps.tenantUploadBytes(user) : 0;
        const declared = Number(req.headers["content-length"]) || 0;
        if (quota && used + declared > quota) {
          req.resume();
          return sendJson(res, 413, { error: "upload quota exceeded" });
        }
        const perFile = config.ZAI_TENANT_UPLOAD_LIMIT || deps.uploadLimit;
        const left = quota ? Math.max(0, quota - used) : Infinity;
        return deps.handleUpload(req, res, url, dir, Math.min(perFile, left, deps.uploadLimit));
      },
    },
    // ISSUE-009: a chip removed before sending takes its uploaded file with it
    // (no orphans in .zai-uploads). Only a plain stored name inside the
    // folder's .zai-uploads is accepted; scope rules = the upload's.
    {
      method: "DELETE",
      path: "/zai/api/upload",
      scope: "user",
      handler: ({ res, url, user, admin }) => {
        const { path } = deps;
        const dir = url.searchParams.get("directory") || deps.defaultDir(user, deps.chatDir);
        const name = String(url.searchParams.get("name") ?? "");
        if (admin && deps.dirProblem(dir)) return sendJson(res, 400, { error: deps.dirProblemText(deps.dirProblem(dir)) });
        if (!deps.dirAllowed(user, dir)) return sendJson(res, 403, { error: "outside your scope" });
        if (!name || name !== path.basename(name) || name !== deps.sanitizeFilename(name) || name === "." || name === "..")
          return sendJson(res, 400, { error: "bad name" });
        const base = path.join(dir, deps.uploadDir);
        const target = path.join(base, name);
        if (path.dirname(target) !== base) return sendJson(res, 400, { error: "bad name" });
        try {
          deps.unlinkSync(target);
        } catch (err) {
          if (err?.code !== "ENOENT") {
            deps.errLog("upload.delete", err);
            return sendJson(res, 500, { error: "delete failed" });
          }
        }
        return sendJson(res, 200, { ok: true });
      },
    },
    // Folder check for the «new project» modal (shape, scope, existing drive);
    // nothing is created. Its own order: shape → scope (400 before 403).
    {
      method: "GET",
      path: "/zai/api/dircheck",
      scope: "user",
      handler: ({ res, url, user }) => {
        const dir = url.searchParams.get("directory") ?? "";
        const problem = deps.dirProblem(dir) ?? deps.driveProblem(dir);
        if (problem) return sendJson(res, 400, { error: deps.dirProblemText(problem), code: problem });
        if (!deps.dirAllowed(user, dir)) return sendJson(res, 403, { error: "outside your scope" });
        return sendJson(res, 200, { ok: true });
      },
    },
    // Workspace file for chat artifact preview/download (lib/file.js: lexical
    // AND realpath containment, CSP sandbox for active documents).
    {
      method: ["GET", "HEAD"],
      path: "/zai/api/file",
      scope: "dirQuery",
      dirDefault: () => deps.homeDir,
      handler: ({ req, res, url, user, dir }) =>
        deps.serveWorkspaceFile(req, res, {
          directory: dir,
          target: url.searchParams.get("path"),
          download: url.searchParams.get("download") === "1",
          extraRoots: deps.fileRoots(user), // undefined for admin → module default
        }),
    },
    // BUG-090 (BUG-05.16): batch existence check for GUESSED pictures —
    // ?directory=<dir>&path=a&path=b… → {exists:[bool…]} in the same order.
    {
      method: "GET",
      path: "/zai/api/file/exists",
      scope: "dirQuery",
      dirDefault: () => deps.homeDir,
      handler: ({ res, url, user, dir }) => {
        const paths = url.searchParams.getAll("path");
        if (paths.length === 0 || paths.length > 100) return sendJson(res, 400, { error: "1..100 path params required" });
        const roots = deps.fileRoots(user);
        return sendJson(res, 200, { exists: paths.map((t) => deps.workspaceFileExists(dir, t, roots)) });
      },
    },
    // BUG-092: files the agent made/changed in the chat folder per turn window
    // (lib/turn-files.js) — file cards for script-made files in both engines.
    {
      method: "GET",
      path: "/zai/api/turn-files",
      scope: "dirQuery", // no default: an absolute ?directory= is required
      handler: ({ res, url, dir }) => {
        try {
          return sendJson(res, 200, { files: deps.turnFiles(dir, deps.parseWindows(url.searchParams.get("w"))) });
        } catch (err) {
          deps.errLog("turn-files", err);
          return sendJson(res, 500, { error: "scan failed" });
        }
      },
    },
  ];
}
