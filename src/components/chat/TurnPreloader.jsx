// FEAT-03.19: the turn preloader, shown instead of the running turn when
// «Детализация выполнения» is off. Since 2026-11-04 — the v3 artwork
// (a robot throws a glowing «ai» token into a basket), one file per theme,
// kept byte for byte as delivered: preloader-v3-light.svg / -dark.svg.
// Rendered as <img> (data: URL from the bundle): the SVG carries its own
// .turn-preloader/.tp-* styles and keyframes, which must not meet chat.css;
// its caption «Готовлю ответ…» lives inside the file. chat.css shows the
// variant of the current theme.
// Reduced motion: browsers do not pass prefers-reduced-motion into an SVG
// loaded as an image (stand dogfood 2026-11-04: frames kept changing), so the
// file's own media query never fires there. The artwork already has a still
// frame — its root class `tp-static` switches every animation off — so a
// still copy is derived here (class added to the root, nothing else touched)
// and chat.css swaps it in under prefers-reduced-motion: reduce.
import lightSvg from "./preloader-v3-light.svg";
import darkSvg from "./preloader-v3-dark.svg";
import { DICTIONARIES, lang, t } from "../../lib/i18n.js";

const ROOT_CLASS = 'class="turn-preloader ';
export const stillSvg = (svg) => (svg.includes(ROOT_CLASS) ? svg.replace(ROOT_CLASS, 'class="turn-preloader tp-static ') : svg);
const dataUrl = (svg) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
// The artwork's caption is Russian; other languages get it swapped in the
// <text> node (the ru variant stays byte for byte as delivered).
const captioned = (svg) => {
  const ru = DICTIONARIES.ru["preloader.caption"];
  const cap = t("preloader.caption");
  return cap === ru ? svg : svg.replace(`>${ru}</text>`, `>${cap.replace(/[<&]/g, "")}</text>`);
};
const variantCache = {};
const variants = () =>
  (variantCache[lang.value] ??= [lightSvg, darkSvg].map((raw, i) => {
    const svg = captioned(raw);
    return { theme: i === 0 ? "light" : "dark", anim: dataUrl(svg), still: dataUrl(stillSvg(svg)) };
  }));

export default function TurnPreloader() {
  return (
    <div class="msg msg-assistant msg-preloader">
      <div class="turn-preloader" role="status" aria-label={t("preloader.caption")}>
        {variants().map((v) => (
          <span key={v.theme} class={`tp-theme tp-theme-${v.theme}`}>
            <img class="tp-img tp-anim" src={v.anim} alt="" width="200" height="160" draggable={false} />
            <img class="tp-img tp-still" src={v.still} alt="" width="200" height="160" draggable={false} />
          </span>
        ))}
      </div>
    </div>
  );
}
