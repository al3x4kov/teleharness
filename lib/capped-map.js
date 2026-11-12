// TASK-12.31 (SRV-23): запись в Map-кэш с потолком размера. Обновление ключа делает его
// самым свежим; при переполнении вытесняется самый старый (порядок вставки Map).
export function setCapped(map, key, value, max = 500) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
  return value;
}
