// Плагин тенантов для opencode 2.x (FEAT-16.3, tasks 4.2 + 4.4).
// Тонкий адаптер над двумя модулями:
//  - ops/opencode/sandbox-core/index.mjs — логика песочницы (зоны/allowlist/jail/
//    CJK/turn-undo/codemode), тесты ops/opencode/tests/sandbox-core.test.mjs;
//  - ops/opencode/plugin-v2/hooks.mjs — база знаний и системные правила
//    (KB-снапшот, kb-склейка, правила тенанта BUG-169, дайджест, compaction),
//    тесты ops/opencode/tests/plugin-v2-*.test.mjs.
// Здесь только монтаж хуков по таблице design.md §7:
//   tool.execute.before  -> ctx.tool.hook("execute.before")  (блокировка = throw,
//                           подтверждено живьём Э10; agent/messageID в событии)
//   tool.execute.after   -> ctx.tool.hook("execute.after")   (ветка completed|error)
//   chat.message         -> ctx.session.hook("prompt")       (BUG-146 startTurn;
//                           FEAT-03.22: metadata.system -> pending, из metadata
//                           ключ удаляется — хранимый текст не искажается, Э9;
//                           KB-снапшот первого хода -> metadata.kbContext,
//                           metadata персистентна — Э8)
//   system/messages/params transform -> ctx.session.hook("context"): pending ->
//                           event.system.push (one-shot); kb-склейка сообщений
//                           модели; правила тенанта + вырезание admin-_index.md;
//                           (glmEffort НЕ монтируется — v2 решает variant сессии
//                           сам, api-map §10: Model.Info.variants несут settings/
//                           body, session variant виден в step.started живьём)
//   experimental.session.compacting -> ctx.session.hook("compaction") (ссылка на
//                           дайджест -> event.system.push)
//   event -> session.idle -> ctx.event.subscribe() (дайджест сессии + seal хода,
//                           async-итератор, гасится cleanup'ом setup)
// Регистрация: в конфиге v2 plugins: ["<путь к этой директории>"] — локальные
// пути только директории (migrate-v1), entry — index.ts с default export.
// Точка входа: bare-объект {id, setup} (проверено живьём Э8); если пакет
// @opencode/plugin резолвится, объект оборачивается в Plugin.define — форма та
// же, но каноничная по документации. Пакет может отсутствовать рядом с плагином
// (в D:\Portal\zai\node_modules его нет) — поэтому динамический import с
// fallback, статический импорт уронил бы загрузку всего плагина.
import os from "node:os"
import path from "node:path"
import * as core from "../sandbox-core/index.mjs"
import * as hooks from "./hooks.mjs"

type Any = Record<string, any>

const ID = "zai-tenant-v2"

const spec: Any = {
  id: ID,
  async setup(ctx: Any) {
    await core.log(`${ID}: loaded (sandbox-core core from ops/opencode/sandbox-core)`)

    // ctx.session.get -> Session.Info (обёртки .data нет, Э8; directory живёт
    // в location.directory; ранняя сессия урезанная — для execute.before это
    // не важно, к инструментам сессия уже установлена). Ядро ждёт форму v1:
    // { directory, parentID }.
    const getSession = async (sessionID: string): Promise<Any | null> => {
      try {
        const s: Any = await ctx.session.get({ sessionID })
        const info = s && typeof s === "object" && s.data && typeof s.data === "object" ? s.data : s
        const dir = info?.location?.directory ?? info?.directory
        if (!dir) return null
        return { ...info, directory: dir }
      } catch {
        return null // fail-closed: ядро откажет «не удалось определить права»
      }
    }
    // ctx.session.context -> история; плоские записи v2 разворачиваются в
    // {info, parts} ядра (toV1Message) — нужно и песочнице (currentTurn
    // после рестарта serve), и дайджесту/снапшоту (фильтр первого хода).
    const getMessages = async (sessionID: string): Promise<Any[]> => {
      try {
        const raw: Any = await ctx.session.context({ sessionID })
        const arr: any[] = Array.isArray(raw) ? raw : (raw?.data ?? [])
        return arr.map((m: Any) => hooks.toV1Message(m))
      } catch {
        return []
      }
    }

    const sb = core.createSandbox({ getSession, getMessages })

    // FEAT-03.22: per-session pending системного текста (variant A, Э9).
    const pending = new Map<string, string>()
    const sysLogged = new Set<string>() // BUG-209: лог «system добавлен» — раз за ход
    // KB-снапшот: раз на сессию за жизнь процесса (после рестарта serve защита
    // — по истории, как в 1.x).
    const injected = new Set<string>()
    // BUG-194: sessionID → (messageID → metadata хода с kbContext/zaiHidden).
    // Копия на диске (metaStore) переживает рестарт serve; из context-хука —
    // только синхронное чтение файла, НИКАКИХ вызовов opencode (вешало ход).
    const metaCache = new Map<string, Map<string, Any>>()
    const metaStore = hooks.createMetaStore(path.join(process.env.XDG_DATA_HOME || os.tmpdir(), "zai-turn-meta"))
    const metaOf = (sid: string): Map<string, Any> => {
      let map = metaCache.get(sid)
      if (!map) metaCache.set(sid, (map = metaStore.load(sid)))
      return map
    }

    await ctx.tool.hook("execute.before", (event: Any) =>
      // event.input мутабелен: pointToChat и jail-подмена внутри ядра правят
      // его на месте; throw из ядра доходит до модели как Tool.Error (Э10).
      sb.before(event.tool, event.sessionID, event.input),
    )

    await ctx.tool.hook("execute.after", async (event: Any) => {
      if (event.status !== "completed") return
      const note = await sb.after(event.tool, event.sessionID)
      if (!note) return
      // Tool.Result 2.x точно не вычитан (plugin-map «не проверено»): дописываем
      // только в строковый output; иначе карантин уже сработал, а заметку пишем в лог.
      const r = event.result as Any
      if (r && typeof r === "object" && typeof r.output === "string") r.output += note
      else await core.log(`sandbox note for ${String(event.sessionID).slice(0, 12)}:${note.trim()}`)
    })

    await ctx.session.hook("prompt", async (event: Any) => {
      // BUG-146: открытие хода turn-undo; messageID приходит в событии (в 1.x
      // доставали из истории). Синтетика/title в v2 хук не запускают (migrate-v1).
      await sb.startTurn(event.sessionID, event.messageID)
      const md = event.metadata as Any | undefined
      const sys = md && typeof md === "object" ? md.system : undefined
      if (typeof sys === "string" && sys) {
        delete md.system // admission-metadata чистится: инструкция нигде не хранится
        pending.set(event.sessionID, sys)
        sysLogged.delete(event.sessionID)
        await core.log(`feat-03.22: pending system (${sys.length} зн.) для ${String(event.sessionID).slice(0, 12)}`)
      } else {
        // Новый ход без metadata: мост не живёт дольше своего хода.
        pending.delete(event.sessionID)
      }

      // KB-снапшот (FEAT-01.32, vault-cache.ts chat.message 1152-1213): первый
      // текстовый ход КОРНЕВОЙ сессии. Снапшот кладётся в metadata.kbContext —
      // metadata хода персистентна на user-части (Э8), текст не меняется.
      try {
        const md = event.metadata as Any | undefined
        const have = md && typeof md === "object" && typeof md.kbContext === "string" && md.kbContext
        if (!injected.has(event.sessionID) && !have) {
          injected.add(event.sessionID) // как в 1.x: любая решённая проверка закрывает сессию
          const text = (event.prompt as Any)?.text
          if (typeof text === "string" && !text.startsWith("[obsidian-cache]")) {
            const v = await sb.zoneForSession(event.sessionID)
            if (v && !v.parentID && !(await getMessages(event.sessionID)).some((m: Any) => m?.info?.role === "user" && m.info.id !== event.messageID)) {
              const snap = await hooks.buildSnapshot({ id: event.sessionID, directory: v.dir, title: "" }, v.zone)
              if (snap) {
                event.metadata = { ...(event.metadata ?? {}), kbContext: snap }
                await core.log(`kb snapshot injected into ${String(event.sessionID).slice(0, 8)} (zone ${v.zone.tenant ?? "admin"} -> ${v.zone.root})`)
              } else {
                await core.log(`snapshot skipped for ${String(event.sessionID).slice(0, 8)} (tenant ${v.zone.tenant}: no vault zone)`)
              }
            }
          }
        }
      } catch (e) {
        await core.log(`kb snapshot error (${String(event.sessionID)?.slice(0, 12)}): ${String(e)}`)
      }
      // BUG-194: metadata хода (снапшот, скрытая подсказка) — в карту для hook("context")
      const md2 = event.metadata as Any | undefined
      if (event.messageID && md2 && typeof md2 === "object" && (typeof md2[hooks.KB_CONTEXT_KEY] === "string" || typeof md2[hooks.HIDDEN_KEY] === "string")) {
        const map = metaOf(event.sessionID)
        map.set(event.messageID, md2)
        metaStore.save(event.sessionID, map)
      }
    })

    await ctx.session.hook("context", async (event: Any) => {
      try {
        // FEAT-03.22 / BUG-209: системный текст хода — на КАЖДОЙ сборке context
        // (hook зовётся на каждом шаге: живьём 3 вызова на 3 шага). Раньше one-shot —
        // шаги 2+ шли без промпта. Снимает его prompt-хук следующего хода без system.
        const sys = pending.get(event.sessionID)
        if (sys && Array.isArray(event.system)) {
          event.system.push({ type: "text", text: sys })
          if (!sysLogged.has(event.sessionID)) {
            sysLogged.add(event.sessionID)
            await core.log(`feat-03.22: system добавлен в context ${String(event.sessionID).slice(0, 12)} (${sys.length} зн.)`)
          }
        }
        // FEAT-01.32: то, что видит МОДЕЛЬ — «снапшот --- текст»; хранимая
        // история не меняется (правки живут только в исходящем запросе).
        // BUG-193: скрытая подсказка хода (metadata.zaiHidden) — тоже только в запросе к модели.
        // BUG-194: у живого 2.2.6 сообщения здесь — {id, role, content[]} БЕЗ metadata;
        // metadata хода — из карты prompt-хука, после рестарта serve — с диска (metaStore).
        if (Array.isArray(event.messages)) {
          const map = metaOf(event.sessionID)
          let spliced = 0
          for (const m of event.messages) {
            hooks.hiddenSplice(hooks.kbSplice(m)) // плоская форма (совместимость)
            const md = m?.role === "user" && m?.id ? map?.get(m.id) : undefined
            if (md) {
              hooks.spliceModelMessage(m, md)
              spliced++
            }
          }
          if (spliced) await core.log(`bug-194: kb/hidden в запросе к модели ${String(event.sessionID).slice(0, 12)}: ${spliced} сообщ.`)
        }
        // Системные правила тенанта (vault-cache.ts system.transform 1246-1264):
        // вырезание admin-блока _index.md, правила зоны, рабочая папка чата.
        const v = await sb.effectiveZone(event.sessionID)
        if (v?.zone.tenant && Array.isArray(event.system)) {
          const texts: string[] = event.system.map((p: Any) => (p && typeof p.text === "string" ? p.text : ""))
          const stripped = hooks.stripAdminRules(texts)
          for (let i = 0; i < texts.length; i++) if (typeof (event.system[i] as Any)?.text === "string") (event.system[i] as Any).text = texts[i]
          event.system.push({ type: "text", text: v.zone.root ? hooks.tenantRules(v.zone) : "База знаний Obsidian в этой сессии недоступна: не читай и не пиши в D:\\Obsidian." })
          const cd = await sb.chatDirOf(event.sessionID, v)
          if (cd) event.system.push({ type: "text", text: hooks.chatDirLine(cd) })
          await core.log(`system: tenant ${v.zone.tenant} (${String(event.sessionID).slice(0, 12)}): admin rules blocks stripped=${stripped}`)
        }
      } catch (e) {
        await core.log(`context hook error (${String(event.sessionID)?.slice(0, 12)}): ${String(e)}`)
      }
    })

    // Compaction-правило (vault-cache.ts experimental.session.compacting
    // 1383-1400): если дайджест сессии существует — указатель на него в system.
    await ctx.session.hook("compaction", async (event: Any) => {
      try {
        const v = await sb.zoneForSession(event.sessionID)
        if (!v?.zone.root) return
        const prev = await hooks.readIfExists(hooks.digestFile(v.zone.root, event.sessionID))
        const note = hooks.compactionNote(v.zone, event.sessionID, prev)
        if (note && Array.isArray(event.system)) event.system.push({ type: "text", text: note })
      } catch (e) {
        await core.log(`compaction error (${String(event.sessionID)?.slice(0, 12)}): ${String(e)}`)
      }
    })

    // session.idle (vault-cache.ts event-хук 1355-1381): seal хода (BUG-146) и
    // дайджест сессии. Async-итератор гасится AbortController'ом в cleanup.
    const ac = new AbortController()
    ;(async () => {
      try {
        // Типы @opencode/plugin: subscribe возвращает AsyncIterable синхронно
        // (plugin-map:75); страхуемся от промис-обёртки.
        const sub: Any = ctx.event.subscribe({ signal: ac.signal }) as Any
        const stream: Any = typeof sub?.[Symbol.asyncIterator] === "function" ? sub : await sub
        for await (const ev of stream) {
          const e = ev as Any
          if (e?.type !== "session.idle") continue
          const props = e.properties ?? e.data ?? {}
          const sessionID: string | undefined = props?.sessionID
          if (!sessionID) continue
          try {
            sb.seal(sessionID)
          } catch (err) {
            await core.log(`turn-undo seal error: ${String(err)}`)
          }
          hooks
            .enqueue(sessionID, async () => {
              const s = await getSession(sessionID)
              if (!s) return
              const msgs = await getMessages(sessionID)
              if (!hooks.isPrimary(s, msgs)) return
              const d = hooks.extractDigest(msgs)
              if (!d) return
              await hooks.writeDigest(s, await core.zoneOf(s.directory), d)
            })
            .catch((err) => core.log(`digest error (${String(sessionID).slice(0, 12)}): ${String(err)}`))
        }
      } catch (err) {
        if (!ac.signal.aborted) await core.log(`event subscribe error: ${String(err)}`)
      }
    })()
    return () => ac.abort()
  },
}

// Каноничная обёртка Plugin.define, если пакет доступен; иначе bare-объект (Э8).
let plugin: Any = spec
try {
  const m: any = await import("@opencode/plugin")
  if (typeof m?.define === "function") plugin = m.define(spec as never)
} catch {}

export default plugin
