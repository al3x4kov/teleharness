// FEAT-19.16: subscription model adapter that runs a step as a portal chat turn
// (chat-step.js) and stores the text answer as the step receipt.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function chatAdapter({ engine, models, runner, artifactDirectory }) {
  const list = () => (typeof models === "function" ? models() : models);
  return {
    get models() { return list(); },
    subscriptionOnly: true, textOnly: true, files: true,
    async check() { return "ready"; },
    async execute({ user, directory, workspace, runFolder, title, instruction, model, timeoutSeconds, signal, onSession }) {
      if (!list().includes(model)) throw new Error("model unavailable");
      const out = await runner.run({ user, engine, model, directory: workspace, project: directory, runFolder, title, instruction,
        timeoutMs: Math.min(Math.max(timeoutSeconds || 600, 10), 3600) * 1000, signal, onSession });
      if (out.state === "quota_wait") return { state: "quota_wait" };
      await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
      const receipt = randomUUID();
      await writeFile(path.join(artifactDirectory, receipt), out.text, { flag: "wx", mode: 0o600 });
      return { receipt, sessionId: out.sessionId };
    },
  };
}
