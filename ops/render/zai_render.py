# FEAT-04.12: «zai-render» — preview pictures of a user's document so the model
# can SEE its result (slides, pages) and fix the layout before handing the file
# over. Runs on the host, outside the tenant AppContainer: LibreOffice hangs in
# the container (stand probe 2026-11-06), and the owner allowed the render to
# run outside the sandbox. The sandbox boundary still holds for the CONTENT:
#   * the input must be the user's own file (realpath inside --root);
#   * the renderer works on a COPY in a private temp folder the tenant cannot
#     reach, and the copy is stripped of everything that could pull other
#     files or network into the picture: external relationships (linked
#     images, OLE/DDE links, external workbooks, UNC paths), INCLUDETEXT /
#     INCLUDEPICTURE / DDE / LINK fields, ODF xlink:href to file:/UNC paths;
#   * LibreOffice runs with a hardened throw-away profile: macros off (very
#     high security), no formula recalculation on load, no link updates, no
#     untrusted referer links;
#   * HTML/SVG are printed by headless Edge (Playwright, html2pdf.mjs) with
#     every request intercepted: only the page's own folder copy is served —
#     no file://, no loopback (opencode :4096), no LAN, no internet.
# Output: <folder of the file>\_preview\<stem>\page-NN.png (+ <stem>.pdf for
# office/html input); the list is printed for the model.
#
# argv: --root <user folder> --cwd <command folder> --b64 <base64url of the
#       argument string the model wrote after «zai-render»>
# Exit: 0 ok, 2 refused (bad arguments / outside the folder), 1 render error.
import base64
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

LO = os.environ.get("ZAI_RENDER_SOFFICE") or r"D:\zai-sandbox\libreoffice\program\soffice.com"
TEMPLATE = Path(__file__).with_name("lo-profile.xcu")
WORK_ROOT = Path(os.environ.get("ZAI_RENDER_TMP") or r"D:\zai-sandbox\render-tmp")
OFFICE = {".pptx", ".docx", ".xlsx", ".odp", ".odt", ".ods", ".csv", ".pptm", ".docm", ".xlsm", ".ppt", ".doc", ".xls"}
OOXML = {".pptx", ".docx", ".xlsx", ".pptm", ".docm", ".xlsm"}
ODF = {".odp", ".odt", ".ods"}
WEB = {".html", ".htm", ".svg"}
TIMEOUT = int(os.environ.get("ZAI_RENDER_TIMEOUT") or 600)


def fail(msg, code=2):
    print(f"zai-render: {msg}")
    sys.exit(code)


def within(p: Path, root: Path) -> bool:
    try:
        p.relative_to(root)
        return True
    except ValueError:
        return False


def parse_args(raw: str):
    try:
        toks = shlex.split(raw, posix=False)
    except ValueError as e:
        fail(f"не разобрал аргументы ({e})")
    toks = [t[1:-1] if len(t) >= 2 and t[0] == t[-1] == '"' else t for t in toks]
    files, pages, scale = [], None, None
    i = 0
    while i < len(toks):
        t = toks[i]
        if t in ("--pages", "-p") and i + 1 < len(toks):
            pages = toks[i + 1]
            i += 2
            continue
        if t == "--scale" and i + 1 < len(toks):
            try:
                scale = max(0.3, min(4.0, float(toks[i + 1])))
            except ValueError:
                fail("--scale: нужно число, например 1.5")
            i += 2
            continue
        if t.startswith("-"):
            fail(f"неизвестный ключ {t}. Формат: zai-render <файл> [--pages 1-5] [--scale 1.5]")
        files.append(t)
        i += 1
    if not files:
        fail("укажите файл: zai-render <файл.pptx|docx|xlsx|pdf|html> [--pages 1-5]")
    return files, pages, scale


def page_set(spec, n):
    if not spec:
        return list(range(n))
    out = set()
    for part in spec.split(","):
        m = re.fullmatch(r"\s*(\d+)\s*(?:-\s*(\d+)\s*)?", part)
        if not m:
            fail(f"--pages: не понял «{part}». Пример: --pages 1-3,7")
        a = int(m.group(1))
        b = int(m.group(2) or a)
        for k in range(min(a, b), max(a, b) + 1):
            if 1 <= k <= n:
                out.add(k - 1)
    return sorted(out)


# --- sanitizing the copy ----------------------------------------------------------

EXTERNAL_REL = re.compile(r"<Relationship\b[^>]*TargetMode=\"External\"[^>]*/>", re.I)
HYPERLINK_TYPE = "/relationships/hyperlink"
FIELD_BAD = re.compile(r"\b(INCLUDETEXT|INCLUDEPICTURE|INCLUDE|DDEAUTO|DDE|LINK|IMPORT)\b", re.I)


def clean_rels(xml: str) -> str:
    # Hyperlinks stay (they are only text on a picture); every other external
    # target (linked picture, OLE link, external workbook, attached template,
    # UNC path …) is pointed at nothing.
    def one(m):
        tag = m.group(0)
        if HYPERLINK_TYPE in tag:
            return tag
        return re.sub(r'Target="[^"]*"', 'Target="NULL"', tag)
    return EXTERNAL_REL.sub(one, xml)


def clean_fields(xml: str) -> str:
    xml = re.sub(r"(<w:instrText\b[^>]*>)([^<]*)(</w:instrText>)",
                 lambda m: m.group(1) + (" " if FIELD_BAD.search(m.group(2)) else m.group(2)) + m.group(3), xml)
    xml = re.sub(r'(<w:fldSimple\b[^>]*\bw:instr=")([^"]*)(")',
                 lambda m: m.group(1) + (" " if FIELD_BAD.search(m.group(2)) else m.group(2)) + m.group(3), xml)
    # Excel: DDE/OLE links and web queries
    xml = re.sub(r"<(ddeLink|oleLink)\b.*?</\1>", "", xml, flags=re.S)
    return xml


INTERNAL_HREF = re.compile(r"^(Pictures/|\./|#|Object|ObjectReplacements/|Media/)")


def clean_odf(xml: str) -> str:
    # Linked (not embedded) pictures, objects, sections: only references inside
    # the package survive. Hyperlinks (<text:a>, <draw:a>) are just text on a
    # picture and are kept; every other element with an outside href (file:,
    # UNC, http — LibreOffice would fetch it) gets «#».
    def tag(m):
        t = m.group(0)
        if re.match(r"<(text:a|draw:a|office:event-listener)\b", t):
            return t
        return re.sub(r'xlink:href="([^"]*)"', lambda h: h.group(0) if INTERNAL_HREF.match(h.group(1)) and "\\" not in h.group(1) and ".." not in h.group(1) else 'xlink:href="#"', t)
    xml = re.sub(r"<[a-z]+:[a-z-]+\b[^>]*xlink:href=\"[^\"]*\"[^>]*>", tag, xml)
    xml = re.sub(r"<text:section-source\b[^>]*/>", "", xml)
    xml = re.sub(r"<table:table-source\b[^>]*/>", "", xml)
    xml = re.sub(r"<office:dde-source\b[^>]*/>", "", xml)
    return xml


def sanitize_zip(src: Path, dst: Path, odf: bool):
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            name = info.filename.lower()
            if name.endswith((".rels",)):
                data = clean_rels(data.decode("utf-8", "replace")).encode("utf-8")
            elif not odf and name.endswith(".xml") and ("word/" in name or "xl/" in name or "ppt/" in name):
                data = clean_fields(data.decode("utf-8", "replace")).encode("utf-8")
            elif odf and name.endswith(".xml"):
                data = clean_odf(data.decode("utf-8", "replace")).encode("utf-8")
            if name.startswith("basic/") or name.endswith("vbaproject.bin"):
                continue  # macros never travel into the renderer
            zout.writestr(info, data)


# --- renderers --------------------------------------------------------------------

WARM = WORK_ROOT / "lo-warm"  # a profile after its first start (~1 MB): 15 s instead of 45 s


def lo_profile(work: Path) -> str:
    # A private copy per run (parallel chats never share a profile lock); the
    # hardened settings are written over the warm copy every time.
    dst = work / "lo-profile"
    if (WARM / "user").is_dir():
        shutil.copytree(WARM, dst)
    (dst / "user").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(TEMPLATE, dst / "user" / "registrymodifications.xcu")
    return dst.as_uri()


def keep_warm(work: Path):
    if (WARM / "user").is_dir():
        return
    tmp = WORK_ROOT / f"lo-warm-{os.getpid()}"
    try:
        shutil.copytree(work / "lo-profile", tmp)
        tmp.rename(WARM)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)


def kill_tree(p):
    try:
        subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True, timeout=30)
    except Exception:
        pass


def office_to_pdf(copy: Path, work: Path) -> Path:
    out = work / "pdf"
    out.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(("ZAI_", "OPENCODE", "ANTHROPIC", "CLAUDE"))}
    args = [LO, "--headless", "--norestore", "--nolockcheck", "--nologo", "--nodefault", "-env:UserInstallation=" + lo_profile(work),
            "--convert-to", "pdf", "--outdir", str(out), str(copy)]
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=str(work))
    try:
        log, _ = p.communicate(timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        kill_tree(p)
        fail(f"LibreOffice не уложился в {TIMEOUT} с", 1)
    pdf = out / (copy.stem + ".pdf")
    if pdf.exists():
        keep_warm(work)
    if not pdf.exists():
        fail("LibreOffice не создал PDF: " + log.decode("utf-8", "replace")[-400:], 1)
    return pdf


HTML2PDF = Path(__file__).with_name("html2pdf.mjs")
NODE = os.environ.get("ZAI_RENDER_NODE") or r"D:\nodejs\node.exe"


def web_to_pdf(src: Path, work: Path) -> Path:
    # the page and the files next to it (pictures, css) — a copy, not deeper
    # than its own folder; html2pdf.mjs serves only this copy to the browser.
    site = work / "site"
    site.mkdir()
    for f in src.parent.iterdir():
        if f.is_file() and not f.is_symlink() and f.stat().st_size < 50 * 1024 * 1024:
            shutil.copyfile(f, site / f.name)
    pdf = work / (src.stem + ".pdf")
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(("OPENCODE", "ANTHROPIC", "CLAUDE"))}
    p = subprocess.Popen([NODE, str(HTML2PDF), str(site), src.name, str(pdf)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=str(work))
    try:
        log, _ = p.communicate(timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        kill_tree(p)
        fail(f"браузер не уложился в {TIMEOUT} с", 1)
    if not pdf.exists():
        fail("браузер не напечатал страницу в PDF: " + log.decode("utf-8", "replace")[-400:], 1)
    return pdf


def pdf_to_png(pdf: Path, out_dir: Path, pages, scale):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(pdf))
    n = len(doc)
    want = page_set(pages, n)
    shown = []
    for i in want:
        page = doc[i]
        w, h = page.get_size()
        s = scale or max(0.5, min(3.0, 1600.0 / max(w, h)))
        img = page.render(scale=s).to_pil()
        dst = out_dir / f"page-{i + 1:02d}.png"
        img.save(dst)
        shown.append(dst)
    doc.close()
    return n, shown


def main():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    argv = sys.argv[1:]
    def opt(name):
        return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else None
    root_s, cwd_s, b64 = opt("--root"), opt("--cwd"), opt("--b64")
    if not root_s or not b64:
        fail("внутренняя ошибка: нет папки пользователя")
    root = Path(root_s).resolve()
    cwd = Path(cwd_s or root_s).resolve()
    if not within(cwd, root):
        fail("рабочая папка вне вашей папки")
    try:
        raw = "" if b64 == "-" else base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)).decode("utf-8")
    except Exception:
        fail("внутренняя ошибка: аргументы не декодируются")
    files, pages, scale = parse_args(raw)
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    rc = 0
    for name in files:
        src = (cwd / name).resolve()
        if not within(src, root):
            print(f"zai-render: {name}: файл вне вашей папки — отказ")
            rc = 2
            continue
        if not src.is_file():
            print(f"zai-render: {name}: файла нет")
            rc = 2
            continue
        ext = src.suffix.lower()
        if ext not in OFFICE | WEB | {".pdf"}:
            print(f"zai-render: {name}: формат {ext} не рисуется (pptx, docx, xlsx, odp/odt/ods, csv, pdf, html, svg; ppt/doc/xls — после пересохранения)")
            rc = 2
            continue
        if ext in {".ppt", ".doc", ".xls"}:
            print(f"zai-render: {name}: старый двоичный формат не рисуется (нельзя очистить внешние ссылки). Сохраните как {ext}x через python-pptx/python-docx/openpyxl или работайте с новым файлом.")
            rc = 2
            continue
        out_dir = src.parent / "_preview" / src.stem
        if not within(out_dir.resolve(), root):
            print(f"zai-render: {name}: папка превью вне вашей папки — отказ")
            rc = 2
            continue
        t0 = time.time()
        work = Path(tempfile.mkdtemp(prefix="r-", dir=str(WORK_ROOT)))
        try:
            if ext == ".pdf":
                pdf_src = work / "in.pdf"
                shutil.copyfile(src, pdf_src)
                pdf = pdf_src
            elif ext in WEB:
                pdf = web_to_pdf(src, work)
            else:
                copy = work / ("in" + ext)
                if ext in OOXML or ext in ODF:
                    try:
                        sanitize_zip(src, copy, odf=ext in ODF)
                    except zipfile.BadZipFile:
                        print(f"zai-render: {name}: файл повреждён (не zip-архив {ext})")
                        rc = 1
                        continue
                else:
                    shutil.copyfile(src, copy)
                pdf = office_to_pdf(copy, work)
            if out_dir.exists():
                shutil.rmtree(out_dir, ignore_errors=True)
            out_dir.mkdir(parents=True, exist_ok=True)
            if ext != ".pdf":
                shutil.copyfile(pdf, out_dir / (src.stem + ".pdf"))
            n, shown = pdf_to_png(pdf, out_dir, pages, scale)
            rel = lambda p: os.path.relpath(p, cwd)
            print(f"zai-render: {name} → {n} стр., картинок {len(shown)} за {time.time() - t0:.0f} с")
            for p in shown:
                print("  " + rel(p))
            if ext != ".pdf":
                print("  PDF: " + rel(out_dir / (src.stem + ".pdf")))
            print("Посмотрите картинки (Read/look_at), сверьте с задачей и исправьте файл; папку _preview не называйте пользователю как результат.")
        finally:
            shutil.rmtree(work, ignore_errors=True)
    sys.exit(rc)


if __name__ == "__main__":
    main()
