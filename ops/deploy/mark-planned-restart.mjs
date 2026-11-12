// TASK-12.29: плановый рестарт — не сбой. На Windows `schtasks /end` и Stop-Process убивают
// zai-web без сигнала остановки, поэтому сервер не успевает отметить чистое завершение, и
// следующий старт сообщил бы владельцу о «сбое» после каждого выката. Деплой-скрипт вызывает
// этот файл ПЕРЕД остановкой службы:
//   node ops/deploy/mark-planned-restart.mjs [каталог данных, по умолчанию <репозиторий>/data]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markClean, readPrevious } from "../../lib/run-state.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "data");
markClean(dataDir);
console.log(JSON.stringify({ ok: readPrevious(dataDir).crashed === false, dataDir }));
