// BUG-222 (QA-04): фикстура зависшего набора — сам тест проходит, а after-хук
// никогда не завершается: node --test не заканчивается сам, и без таймаута
// раннера npm test висит навсегда. Имя не *.test.js — обычный прогон её не
// подхватывает; запуск только раннером: node tests/run-tests.mjs files <путь>.
// Если задан HANGING_FIXTURE_PID_FILE, перед зависанием рождается внук-процесс,
// а его pid пишется в файл — тест раннера проверяет, что дерево убито целиком.
// HANGING_FIXTURE_SELF_FILE — pid самого процесса фикстуры (разбор зависаний
// вне раннера: кто именно держит event loop).
import { test, after } from "node:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PID_FILE = process.env.HANGING_FIXTURE_PID_FILE;
const SELF_FILE = process.env.HANGING_FIXTURE_SELF_FILE;

test("фикстура: сам тест проходит; внук живёт долго (проверка убийства дерева)", () => {
  if (SELF_FILE) writeFileSync(SELF_FILE, String(process.pid));
  if (!PID_FILE) return;
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
  writeFileSync(PID_FILE, String(child.pid));
});

after(async () => {
  // Настоящий «зависший» хук держит event loop живым хэндлом (в прод-сбое
  // QA-04 это незакрытый SSE-сервер/таймер): голый вечный промис процесс НЕ
  // держит — node --test завершился бы с кодом 0, и зависания нет.
  setInterval(() => {}, 10_000);
  await new Promise(() => {});
});
