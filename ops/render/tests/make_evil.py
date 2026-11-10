# FEAT-04.12 test fixture: documents that try to pull a secret file or hit a
# loopback canary while being rendered. argv: <out dir> <secret file> <canary url>
import sys
import zipfile
from pathlib import Path

from docx import Document
from pptx import Presentation
from pptx.util import Inches

out, secret, canary = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
out.mkdir(parents=True, exist_ok=True)
secret_uri = Path(secret).as_uri()

# 1. docx: INCLUDETEXT field (complex and simple) → the secret file's text
d = Document()
d.add_paragraph("NORMAL-DOCX-TEXT")
d.save(out / "base.docx")
with zipfile.ZipFile(out / "base.docx") as zin, zipfile.ZipFile(out / "evil.docx", "w", zipfile.ZIP_DEFLATED) as zout:
    for i in zin.infolist():
        data = zin.read(i.filename)
        if i.filename == "word/document.xml":
            s = data.decode("utf-8")
            esc = secret.replace("\\", "\\\\")
            field = (
                '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
                f'<w:r><w:instrText xml:space="preserve"> INCLUDETEXT "{esc}" </w:instrText></w:r>'
                '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>placeholder</w:t></w:r>'
                '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
                f'<w:p><w:fldSimple w:instr=" INCLUDETEXT &quot;{esc}&quot; "><w:r><w:t>p2</w:t></w:r></w:fldSimple></w:p>'
            )
            s = s.replace("<w:sectPr", field + "<w:sectPr", 1)
            data = s.encode("utf-8")
        zout.writestr(i, data)
(out / "base.docx").unlink()

# 2. pptx: a picture whose relationship is EXTERNAL (linked image) → canary + file
p = Presentation()
s = p.slides.add_slide(p.slide_layouts[6])
tx = s.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1))
tx.text_frame.text = "NORMAL-PPTX-TEXT"
p.save(out / "base.pptx")
with zipfile.ZipFile(out / "base.pptx") as zin, zipfile.ZipFile(out / "evil.pptx", "w", zipfile.ZIP_DEFLATED) as zout:
    for i in zin.infolist():
        data = zin.read(i.filename)
        if i.filename == "ppt/slides/_rels/slide1.xml.rels":
            r = data.decode("utf-8").replace(
                "</Relationships>",
                f'<Relationship Id="rIdX1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="{canary}/pptx-linked.png" TargetMode="External"/>'
                f'<Relationship Id="rIdX2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="{secret_uri}" TargetMode="External"/>'
                "</Relationships>")
            data = r.encode("utf-8")
        if i.filename == "ppt/slides/slide1.xml":
            pic = ('<p:pic><p:nvPicPr><p:cNvPr id="90" name="L1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
                   '<p:blipFill><a:blip r:link="rIdX1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
                   '<p:spPr><a:xfrm><a:off x="914400" y="2743200"/><a:ext cx="1828800" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
                   '<p:pic><p:nvPicPr><p:cNvPr id="91" name="L2"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
                   '<p:blipFill><a:blip r:link="rIdX2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
                   '<p:spPr><a:xfrm><a:off x="3657600" y="2743200"/><a:ext cx="1828800" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>')
            data = data.decode("utf-8").replace("</p:spTree>", pic + "</p:spTree>", 1).encode("utf-8")
        zout.writestr(i, data)
(out / "base.pptx").unlink()

# 3. html: iframe/object on the secret file, loopback requests of every kind
(out / "evil.html").write_text(f"""<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="{canary}/css"></head><body>
<h1>NORMAL-HTML-TEXT</h1>
<iframe src="{secret_uri}" width="600" height="200"></iframe>
<object data="{secret_uri}" width="600" height="200"></object>
<img src="{canary}/img">
<script>
fetch("{canary}/fetch", {{method: "POST", mode: "no-cors", body: "x"}}).catch(() => {{}});
var x = new XMLHttpRequest(); try {{ x.open("GET", "{secret_uri}", false); x.send(); document.body.insertAdjacentText("beforeend", x.responseText); }} catch (e) {{}}
navigator.sendBeacon && navigator.sendBeacon("{canary}/beacon", "x");
</script></body></html>""", encoding="utf-8")
print("ok")
