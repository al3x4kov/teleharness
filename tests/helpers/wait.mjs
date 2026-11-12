// Общий помощник ожидания условия с дедлайном (BUG-222 / QA-07).
// Заменяет фиксированные паузы перед проверкой результата: ждём само условие,
// а не «надеемся, что N мс хватит» на нагруженном хосте, где работает прод.
// Паузы, нужные по смыслу теста («ничего не должно произойти за N мс»),
// остаются await sleep(...) с комментарием «// пауза по смыслу».
export async function waitFor(predicate, { timeoutMs = 5000, stepMs = 25, label = "условие" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try {
      v = await predicate();
    } catch {
      // Предикат может читать файл/сеть в момент записи — трактуем как «ещё нет».
    }
    if (v) return v;
    if (Date.now() >= until) throw new Error(`waitFor: не дождались «${label}» за ${timeoutMs} мс`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
