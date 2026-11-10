// One message. User: right-aligned bubble with ONLY what the human typed
// (A030/FEAT-01.32) — failure and queue marks sit in a row under it (R-11,
// R-13), an orchestration directive becomes a separate system card (R-10),
// and the vault-cache snapshot is a quiet «Контекст из базы знаний» row at
// the start of the agent's turn, expandable for admin only (U-3 decision).
// Assistant: full-width, parts in order. A TURN (user message + every
// assistant step after it, see normalize.buildTurns) gets one author line,
// one labelled «Копировать ответ» and one meta line «↑вход ↓выход · время ·
// длительность» under its last step (R-02/R-03). A Claude chat is authored
// by the Claude model, never by an opencode agent name (R-08).
// Artifacts: files the agent wrote (write/edit) and paths mentioned in the
// final text, hard-scoped to the session folder by collectArtifacts (leak
// audit 2026-11-01). Images among them — and media read by tools — render as
// result thumbnails right in the message (BUG-05.9/FEAT-05.7, FV-01); other
// files are chips with a type badge (R-06). Every one opens the FileViewer.
// 1.8.1 (FEAT-05.17): all of them are now Claude-style file cards (FileCard)
// stacked before the final answer text; pictures keep a thumbnail in the tile.
import { useEffect, useRef, useState } from "preact/hooks";
import Markdown from "./Markdown.jsx";
import Reasoning from "./Reasoning.jsx";
import ToolCard from "./ToolCard.jsx";
import Attachment from "./Attachment.jsx";
import FileViewer from "./FileViewer.jsx";
import FileCard from "./FileCard.jsx";
import { EditButton, RegenerateButton, TurnMenu } from "./TurnActions.jsx";
import { mentionedFiles, serverFilesFor, turnHaystack } from "../../lib/turn-files.js";
import { probeState, requestProbe } from "../../lib/file-probe.js";
import { partKbContext } from "../../../shared/title.js";
import { copyText } from "../../lib/clipboard.js";
import { t } from "../../lib/i18n.js";
import { bindingOf, modelName, queuedLabel } from "../../lib/engine.js";
import { describeTurnError } from "../../lib/turn.js";
import { revealPlan, revealSlices } from "../../lib/exec-detail.js";
import { isSpokenAnswer, isVoicePart } from "../../lib/voice-text.js";
import { active, activeSessionDir, claudeAgents, editing, fileUrl, lastUserMessage, me, providerCfg, retryFailed, sessions } from "../../lib/store.js";
import {
  buildTurns,
  collapseToolRuns,
  collectArtifactEntries,
  isImageName,
  queuedUserIds,
  splitDirective,
  splitInjected,
  toolMedia,
  turnAuthor,
  turnMetaLine,
} from "../../lib/normalize.js";

const basename = (p) => String(p ?? "").split(/[\\/]/).pop() || p;

// Turns are computed once per messages array (every bubble of a render reads
// the same snapshot), not once per bubble.
let turnCache = { ref: null, busy: null, turns: null, queued: null };
function turnsFor(messages, busy) {
  if (turnCache.ref !== messages || turnCache.busy !== busy) {
    turnCache = { ref: messages, busy, turns: buildTurns(messages, { busy }), queued: queuedUserIds(messages, busy) };
  }
  return turnCache;
}

const CopyIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
const OkIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4.5 12.5l5 5L19.5 6.5" />
  </svg>
);
const ClockIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
// FEAT-06.2: «голосом» / «озвучено» marks (frame 7 of voice-mode.html).
const MicIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
  </svg>
);
const BookIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" />
    <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
  </svg>
);

export default function MessageBubble({ msg, streaming = false, showRole = true, showMeta = false, reveal = false, onRevealed }) {
  const [copied, setCopied] = useState(null); // null | "ok" | "fail"
  const [viewer, setViewer] = useState(null);
  const flashTimer = useRef(0);
  const pressTimer = useRef(0);
  const pressCopied = useRef(false);

  const info = msg.info ?? {};
  const role = info.role === "user" ? "user" : "assistant";
  const parts = msg.parts ?? [];
  // FEAT-03.19: a whole turn merged by lib/exec-detail.js («Детализация
  // выполнения» off) — only the answer text, files and the turn foot render.
  const compact = msg.compact === true;
  // FEAT-03.19 (уточнение владельца 2026-11-04 ~23:00): the answer that has
  // just finished is revealed from its start like a live stream (MessageList
  // decides which one). shown = chars out; null = everything (no reveal).
  const answerTexts = compact ? parts.filter((p) => p.type === "text").map((p) => p.text ?? "") : [];
  const revealTotal = answerTexts.reduce((n, t) => n + t.length, 0);
  const [shown, setShown] = useState(() => (compact && reveal ? 0 : null));
  useEffect(() => {
    if (!(compact && reveal)) return undefined;
    const plan = revealPlan(revealTotal);
    if (plan.ticks === 0) {
      setShown(null);
      onRevealed?.();
      return undefined;
    }
    let n = 0;
    setShown(0);
    const t = setInterval(() => {
      n = Math.min(revealTotal, n + plan.step);
      if (n >= revealTotal) {
        clearInterval(t);
        setShown(null);
        onRevealed?.();
      } else setShown(n);
    }, 33);
    return () => clearInterval(t);
  }, [compact, reveal]); // eslint-disable-line react-hooks/exhaustive-deps
  const revealing = compact && reveal && shown !== null;
  const act = active.value;
  const feed = act?.messages ?? [];
  const busy = act?.status === "busy" || act?.status === "stopping";
  const { turns, queued } = turnsFor(feed, busy);
  const turn = role === "assistant" ? (turns.get(info.id) ?? null) : null;
  // FEAT-01.57/01.58: the last question / the last turn carry the rewind
  // actions (only once the turn is over; disabled while anything runs).
  const lastUserId = !busy ? lastUserMessage(act)?.info?.id ?? null : null;
  let lastAssistantId = null;
  for (let i = feed.length - 1; i >= 0 && !lastAssistantId; i--) if (feed[i]?.info?.role === "assistant") lastAssistantId = feed[i].info.id;
  const isLastTurn = Boolean(turn && lastUserId && turn.last === lastAssistantId);
  const beingEdited = role === "user" && editing.value?.sid === act?.id && editing.value?.messageID === info.id;

  // Media from tool results (read returns pictures as state.attachments).
  const media = [];
  if (role === "assistant") {
    for (const p of parts) {
      if (p.type !== "tool") continue;
      for (const m of toolMedia(p)) {
        if (media.some((x) => x.url === m.url) || media.length >= 8) continue;
        media.push(m);
      }
    }
  }

  const openArtifact = (path) => setViewer({ path, name: basename(path) });
  const openData = (url, filename) => setViewer({ dataUrl: url, name: filename });
  // Synthetic parts of a user message (the voice-mode hint, FEAT-06.2) are
  // not the human's words: never drawn, never copied.
  const texts = parts.filter((p) => p.type === "text" && !(role === "user" && p.synthetic));
  const voiced = role === "user" && parts.some(isVoicePart);
  const spoken = role === "assistant" && isSpokenAnswer(feed, info.id);
  // Uploaded binary attachments ride as reference texts; render them as
  // chips, not as raw bracketed text (mirror of lib/attach.js fileRefText).
  // `.+` (not \S+) — stored names legally contain spaces: "my report (2).pdf".
  const FILE_REF_RE =
    /^\[Пользователь приложил файл: \.zai-uploads\/(.+) \((\d+) байт(?:, ([^)]+))?\)\./;
  const refChips = [];
  const realTexts = [];
  for (const p of texts) {
    if (role === "user") {
      const m = FILE_REF_RE.exec(p.text ?? "");
      if (m) {
        refChips.push({ name: m[1], size: Number(m[2]), mime: m[3] ?? null });
        continue;
      }
    }
    realTexts.push(p);
  }
  const injectedContexts = [];
  const directiveTexts = [];
  const cleanTexts = realTexts.map((p) => {
    // FEAT-01.32: the snapshot rides as metadata.kbContext (text stays clean);
    // older messages still carry it inside the text (splitInjected).
    const meta = role === "user" ? partKbContext(p) : null;
    if (meta) injectedContexts.push(meta);
    const r = splitInjected(p.text);
    if (r.context && !meta) injectedContexts.push(r.context);
    const d = splitDirective(r.text);
    if (d.directive) directiveTexts.push(d.directive);
    return d.full ? "" : d.text;
  }).filter((t) => t.length > 0);
  const sessionDir = activeSessionDir() ?? "";
  let artifactEntries = role === "assistant" ? collectArtifactEntries(parts, cleanTexts, sessionDir) : [];
  // BUG-092: the server lists what really changed in the chat folder during
  // this turn. A name only GUESSED from the text is shown when the server
  // confirms it (no more 404 probes); the files nobody named — made inside a
  // script — join the turn's last step, once per turn.
  const serverFiles = turn ? serverFilesFor(act?.id, turn.last) : null;
  if (serverFiles) {
    const known = new Set(serverFiles.map((f) => f.toLowerCase()));
    artifactEntries = artifactEntries.filter((e) => !e.guessed || known.has(e.path.toLowerCase()));
    if (turn.last === info.id) {
      const shown = new Set();
      const i0 = feed.findIndex((m) => m.info?.id === turn.first);
      const i1 = feed.findIndex((m) => m.info?.id === turn.last);
      const steps = i0 >= 0 && i1 >= i0 ? feed.slice(i0, i1 + 1) : [msg];
      for (const s of steps) {
        const ts = (s.parts ?? []).filter((x) => x.type === "text").map((x) => x.text ?? "");
        for (const e of collectArtifactEntries(s.parts ?? [], ts, sessionDir)) shown.add(e.path.toLowerCase());
      }
      for (const e of artifactEntries) shown.add(e.path.toLowerCase());
      // Only files this turn names (BUG-094): a file another chat wrote into
      // the shared folder at the same time is not this answer's file.
      for (const f of mentionedFiles(serverFiles, turnHaystack(steps.includes(msg) ? steps : [...steps, msg]))) {
        if (!shown.has(f.toLowerCase())) artifactEntries.push({ path: f, guessed: false });
      }
    }
  } else if (artifactEntries.some((e) => e.guessed && isImageName(e.path))) {
    // BUG-090: no server list yet (a running turn, an old server) — a guessed
    // picture gets its card (and its <img>) only once the server confirmed
    // the file exists: no 404 probe in the console.
    const ask = artifactEntries.filter((e) => e.guessed && isImageName(e.path) && probeState(sessionDir, e.path) === undefined).map((e) => e.path);
    if (ask.length > 0) requestProbe(sessionDir, ask);
    artifactEntries = artifactEntries.filter((e) => !e.guessed || !isImageName(e.path) || probeState(sessionDir, e.path) === true);
  }
  // FEAT-05.17: every file of the answer is one card — media read by tools
  // first, then artifacts in the agent's order; pictures carry a thumbnail.
  const fileCards = media.length > 0 || artifactEntries.length > 0 ? (
    <div class="file-cards" key="file-cards">
      {media.map((m, i) => (
        <FileCard key={`media-${i}`} name={m.name} thumb={m.url} onOpen={() => openData(m.url, m.name)} />
      ))}
      {artifactEntries.map(({ path: p, guessed }) => (
        <FileCard
          key={`art-${p}`}
          name={basename(p)}
          thumb={isImageName(p) ? fileUrl(sessionDir, p) : null}
          onOpen={() => openArtifact(p)}
          hideIfBroken={guessed && isImageName(p)}
        />
      ))}
    </div>
  ) : null;

  const lastTextId = realTexts.length > 0 ? realTexts[realTexts.length - 1].id : null;
  const lastPartId = parts.length > 0 ? parts[parts.length - 1].id : null;
  const stepTotal = parts.filter((p) => p.type === "step-start").length;

  // What a copy takes: the whole turn's answer for assistant steps (one
  // button per turn), the typed text for a user bubble.
  const copyPayload = () => (compact ? cleanTexts.join("\n\n").trim() : turn?.text ? turn.text : cleanTexts.join("\n").trim());

  const flash = (ok) => {
    setCopied(ok ? "ok" : "fail");
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setCopied(null), 1600);
  };

  const copy = () => {
    const t = copyPayload();
    if (!t) return;
    copyText(t).then(flash);
  };

  const onContextMenu = (e) => {
    if (!copyPayload()) return;
    e.preventDefault();
    if (pressCopied.current) {
      pressCopied.current = false; // long-press already copied
      return;
    }
    copy();
  };

  const onTouchStart = () => {
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => {
      pressCopied.current = true;
      copy();
      setTimeout(() => (pressCopied.current = false), 400);
    }, 500);
  };
  const onTouchEnd = () => clearTimeout(pressTimer.current);

  const directiveCard = directiveTexts.length > 0 && (
    <div class="msg msg-system" key="sys">
      <div class="sys-card">
        <details class="sys-details">
          <summary>
            <span class="sys-badge">{t("message.system.badge")}</span>
            {t("message.system.title")}
          </summary>
          <pre class="sys-body">{directiveTexts.join("\n\n")}</pre>
        </details>
      </div>
    </div>
  );

  // A message that is ONLY an orchestration directive is not the human's
  // words: muted system card on the left, never a user bubble.
  if (role === "user" && realTexts.length > 0 && cleanTexts.length === 0 && directiveTexts.length > 0) {
    return directiveCard;
  }

  const revealParts = revealing ? parts.filter((p) => p.type === "text") : [];
  const revealOut = revealing ? revealSlices(answerTexts, shown) : [];
  let stepIdx = 0;
  const renderPart = (p, i) => {
    if (compact && p.type !== "text" && p.type !== "file") return null;
    switch (p.type) {
      case "text":
        if (revealing) {
          const k = revealParts.indexOf(p);
          const text = k >= 0 ? revealOut[k] : "";
          if (!text) return null;
          const next = k >= 0 && k + 1 < revealOut.length ? revealOut[k + 1] : "";
          return <Markdown key={p.id ?? i} text={text} streaming caret={!next} />;
        }
        return (
          <Markdown
            key={p.id ?? i}
            text={p.text ?? ""}
            streaming={streaming}
            caret={streaming && p.id === lastTextId && p.id === lastPartId}
          />
        );
      case "reasoning":
        return (
          <Reasoning
            key={p.id ?? i}
            text={p.text ?? ""}
            time={p.time}
            streaming={streaming && p.time?.end == null}
            hasText={texts.length > 0}
          />
        );
      case "tool":
        return <ToolCard key={p.id ?? i} part={p} repeat={p.__repeat} />;
      case "file":
        return (
          <Attachment
            key={p.id ?? i}
            mime={p.mime}
            filename={p.filename}
            url={p.url}
            onOpen={p.url ? () => openData(p.url, p.filename ?? t("message.file")) : undefined}
          />
        );
      case "step-start":
        stepIdx += 1;
        if (stepTotal <= 1 || stepIdx <= 1) return null;
        return <div class="step-label" key={p.id ?? i}>{t("message.step", { n: stepIdx })}</div>;
      case "step-finish":
        return null;
      default:
        // Unknown service part: a quiet line WITHOUT payload (leak audit).
        return <div class="part-unknown" key={p.id ?? i}>{t("message.unknownPart", { type: String(p.type ?? t("message.unknownType")) })}</div>;
    }
  };

  if (role === "user") {
    const files = parts.filter((p) => p.type === "file");
    const isQueued = !info.failed && queued.has(info.id);
    const admin = me.value?.role === "admin";
    const failText =
      info.failReason === "rejected"
        ? t("message.fail.rejected")
        : info.failReason === "stopped"
          ? t("message.fail.stopped")
          : t("message.fail.network");
    return (
      <>
        <div
          class="msg msg-user"
          onContextMenu={onContextMenu}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onTouchMove={onTouchEnd}
          onTouchCancel={onTouchEnd}
        >
          <div class={"bubble-user" + (info.failed ? " is-failed" : "") + (isQueued ? " is-queued" : "") + (beingEdited ? " is-editing" : "")}>
            {voiced && (
              <span class="voice-tag">
                <MicIcon />
                {t("message.voiced")}
              </span>
            )}
            {cleanTexts.length > 0 && <span class="bubble-text">{cleanTexts.join("\n")}</span>}
            {(files.length > 0 || refChips.length > 0) && (
              <div class="msg-files">
                {files.map((p, i) => (
                  <Attachment
                    key={p.id ?? i}
                    mime={p.mime}
                    filename={p.filename}
                    url={p.url}
                    onOpen={p.url ? () => openData(p.url, p.filename ?? t("message.file")) : undefined}
                  />
                ))}
                {refChips.map((c, i) => (
                  <Attachment
                    key={`ref-${i}`}
                    mime={c.mime}
                    filename={c.name}
                    url={(c.mime ?? "").startsWith("image/") && sessionDir ? fileUrl(sessionDir, ".zai-uploads/" + c.name) : null}
                    onOpen={() => openArtifact(".zai-uploads/" + c.name)}
                  />
                ))}
              </div>
            )}
          </div>
          {info.failed && (
            <div class="fail-row" role="status">
              <span>{failText}</span>
              <button class="retry-btn" type="button" onClick={() => retryFailed(info.id)}>{t("common.retry")}</button>
            </div>
          )}
          {!isQueued && !info.failed && lastUserId === info.id && !beingEdited && (
            <div class="msg-under turn-acts">
              <EditButton sid={act.id} />
            </div>
          )}
          {isQueued && (
            <div class="msg-under">
              <span class="queue-tag"><ClockIcon />{queuedLabel(bindingOf(sessions.value.find((s) => s.id === (act?.id ?? globalThis.__zaiActiveId)))?.engine)}</span>
            </div>
          )}
          {/* BUG-01.38: a persistent live region (a status node inserted
              together with its text is often not announced). */}
          <span class="sr-only" role="status" aria-live="polite">{copied ? (copied === "ok" ? t("common.copied") : t("message.copyFailed")) : ""}</span>
          {copied && <span class="copy-flash" aria-hidden="true">{copied === "ok" ? t("common.copied") : t("message.copyFailed")}</span>}
          {viewer && <FileViewer file={viewer} onClose={() => setViewer(null)} />}
        </div>
        {directiveCard}
        {injectedContexts.length > 0 && (
          <div class="msg msg-turnctx">
            {admin ? (
              <details class="turn-ctx">
                <summary>
                  <BookIcon />
                  <span>{t("message.kbContext")}</span>
                </summary>
                <pre class="ctx-body">{injectedContexts.join("\n\n---\n\n")}</pre>
              </details>
            ) : (
              <div class="turn-ctx is-static">
                <BookIcon />
                <span>{t("message.kbContext")}</span>
              </div>
            )}
          </div>
        )}
      </>
    );
  }

  // Author: once per turn; Claude chats show the model (R-08).
  const binding = bindingOf(sessions.value.find((s) => s.id === (act?.id ?? globalThis.__zaiActiveId)));
  const modelLabel = info.modelID ? modelName(providerCfg.value, { providerID: info.providerID, modelID: info.modelID }) : null;
  const author = turnAuthor(info, { engine: binding?.engine ?? null, modelLabel, claudeAgents: claudeAgents.value });
  const isTurnHead = compact || (turn ? turn.first === info.id : showRole);
  const isTurnEnd = (turn ? turn.last === info.id && turn.closed && !streaming : showMeta) && !revealing;
  const meta = turn ? turnMetaLine(turn) : "";
  const stepError = info.error ? describeTurnError(info.error, { engine: binding?.engine ?? "opencode" }) : null;

  return (
    <div
      class={"msg msg-assistant" + (streaming || revealing ? " is-streaming" : "")}
      data-mid={info.id ?? undefined}
      onContextMenu={onContextMenu}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchMove={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {isTurnHead && showRole && (author.name || author.claude) ? (
        <div class="msg-author">
          <span class={"msg-avatar" + (author.claude ? " is-claude" : "")} aria-hidden="true" />
          <span class="msg-agent">{author.name}</span>
          {spoken && <span class="voice-tag is-spoken">· {t("message.spoken")}</span>}
        </div>
      ) : spoken && isTurnHead ? (
        <div class="msg-author">
          <span class="voice-tag is-spoken">{t("message.spoken")}</span>
        </div>
      ) : null}
      {/* Loop protection: identical consecutive tool calls collapse into
          one card with a ×N counter. */}
      {(() => {
        const items = collapseToolRuns(parts);
        // FEAT-05.17: file cards sit after the steps and BEFORE the final
        // answer text (Claude-app order); without a trailing text — at the end.
        const cut = items.length > 1 && items[items.length - 1].part.type === "text" ? items.length - 1 : items.length;
        const out = items.map((item, i) => {
          const p = item.part;
          const enriched = item.count > 1 ? { ...p, __repeat: item.count } : p;
          return renderPart(enriched, i);
        });
        if (fileCards && !revealing) out.splice(cut, 0, fileCards);
        return out;
      })()}
      {/* ISSUE-006: every failed turn keeps its own mark in the feed — the
          banner only describes the LAST one. */}
      {stepError && (
        <div class="msg-turn-error" role="note">
          <span aria-hidden="true">⚠</span> {stepError.title}
        </div>
      )}
      {isTurnEnd && (copyPayload() || meta || isLastTurn) && (
        <div class="turn-foot">
          {copyPayload() && (
            <button class={"copy-turn" + (copied === "ok" ? " is-done" : "")} type="button" onClick={copy}>
              {copied === "ok" ? <OkIcon /> : <CopyIcon />}
              <span aria-live="polite">{copied === "ok" ? t("common.copied") : copied === "fail" ? t("message.copyFailedShort") : t("message.copyAnswer")}</span>
            </button>
          )}
          {isLastTurn && (
            <span class="turn-acts">
              <RegenerateButton sid={act.id} />
              <TurnMenu sid={act.id} />
            </span>
          )}
          {meta && <span class="msg-meta">{meta}</span>}
        </div>
      )}
      {!isTurnEnd && <span class="sr-only" role="status" aria-live="polite">{copied ? (copied === "ok" ? t("common.copied") : t("message.copyFailed")) : ""}</span>}
      {copied && !isTurnEnd && <span class="copy-flash" aria-hidden="true">{copied === "ok" ? t("common.copied") : t("message.copyFailed")}</span>}
      {viewer && <FileViewer file={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}
