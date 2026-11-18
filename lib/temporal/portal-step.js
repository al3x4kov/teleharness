// FEAT-19.16: steps the portal performs for the worker — «Условие» (evaluate a
// check against an input or a step answer) and «Артефакт» (save a step answer
// as a file in this run's folder). Pure apart from injected IO.
import path from "node:path";

const norm = (v) => String(v ?? "").trim().toLowerCase();
const YES = /^(да|yes|true|ok|ок|1|верно|одобрено)(?![\p{L}\p{N}])/iu;
const NO = /^(нет|no|false|0|неверно|отклонено)(?![\p{L}\p{N}])/iu;
export function evaluateCheck(check, subject) {
  const s = Array.isArray(subject) ? subject.join("\n") : String(subject ?? "");
  switch (check.op) {
    case "equals": return norm(s) === norm(check.value);
    case "contains": return norm(s).includes(norm(check.value));
    case "not_contains": return !norm(s).includes(norm(check.value));
    case "yes": return subject === true || YES.test(s.trim());
    case "no": return subject === false || NO.test(s.trim());
    default: throw new Error("unknown condition");
  }
}
// Safe file name inside the run folder; an existing file gets « (2)».
export function artifactTarget(runDir, filename, exists) {
  const base = path.basename(String(filename));
  if (base !== filename || base.startsWith(".")) throw new Error("bad artifact name");
  let target = path.join(runDir, base);
  const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
  for (let i = 2; exists(target); i++) target = path.join(runDir, `${stem} (${i})${ext}`);
  return target;
}
