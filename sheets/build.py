# Turns each worksheet .docx into a web page next to it (sheets/<id>.html, images under sheets/media/<id>/).
# Needs pandoc. Run from anywhere after changing a .docx or the worksheets in content.json:  python3 sheets/build.py
import html, json, re, shutil, subprocess
from pathlib import Path

HERE = Path(__file__).parent
content = json.loads((HERE.parent / "content.json").read_text())
sheets = content["worksheets"]
stages = {s["id"]: s["name"] for s in content["stages"]}

# worksheets that link to each other by their Google Docs address now link to their pages here
GDOCS = {"1dalDVGORLph9FSbYIQzExUuCRnh9y9zv9jcWdAGZ1X4": "question-to-data",
         "19FybtHxMrAUQaBnTiIGyi3RzAaPJMFZwz9aBBCnVKIQ": "searching",
         "1kcUooFCQZ855rt-FdO42_7vxHmofWyUEZ2f_vDnichQ": "operators"}

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · Investigations Lab</title>
<meta name="description" content="{summary}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:ital,wght@0,400;0,600;0,800;0,900;1,400&family=Azeret+Mono:wght@400;600&family=Newsreader:opsz,wght@6..72,500;6..72,600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../style.css">
</head>
<body class="reader">
<header class="doc-bar">
  <a href="../#{stage}">← Investigations Lab</a>
  <a href="{id}.docx" download>Download .docx</a>
</header>
<div class="reader-wrap">
<nav class="toc" aria-label="Contents">{toc}</nav>
<main class="doc">
  <p class="kicker">Worksheet · {stage_name} · {version}</p>
  <h1>{title}</h1>
{body}
</main>
<div></div>
</div>
<footer class="doc-end">{end}</footer>
</body>
</html>
"""


def clean(body, title):
    # the Word header (a table with the title, version and author) is replaced by the page's own header
    body = re.sub(r"^.*?<table>.*?Investigations Lab Worksheets.*?</table>", "", body, count=1, flags=re.S)
    body = re.sub(r"<h(\d)[^>]*>\s*(<br />\s*)?</h\1>", "", body)          # empty headings used as spacing
    body = re.sub(r"<li>\s*</li>", "", body)
    body = re.sub(r"</?u>", "", body)                                         # Word underlines its links
    body = re.sub(r"<(h\d)([^>]*)><strong>(.*?)</strong>\s*</\1>", r"<\1\2>\3</\1>", body, flags=re.S)
    body = re.sub(r"(<h\d[^>]*>)<br />\s*", r"\1", body)
    # drop the document's own title if it opens the body, since the page header already shows it
    body = re.sub(r"^\s*(<h1[^>]*>.*?</h1>|<p>[^<]*</p>)", lambda m: "" if similar(m.group(1), title) else m.group(0), body, count=1, flags=re.S)
    body = re.sub(r"<(/?)h(\d)", lambda m: f"<{m.group(1)}h{min(int(m.group(2)) + 1, 6)}", body)  # the page's title is the only h1
    for doc, sid in GDOCS.items():
        body = re.sub(rf'https://docs\.google\.com/document/d/{doc}[^"]*', f"{sid}.html", body)
    body = re.sub(r'<a href="http', '<a target="_blank" rel="noopener" href="http', body)
    body = re.sub(r"<table>", '<div class="table"><table>', body).replace("</table>", "</table></div>")
    return body.strip()


def headings(body):
    # a paragraph that is only bold text is a section title in the Word file: make it a heading, with an id
    def promote(m):
        text = m.group(1).strip()
        if text.endswith((":", ".", "…")) or len(text) > 90:
            return m.group(0)
        return f'<h3 id="{slug(text)}">{text}</h3>'
    return re.sub(r"<p><strong>([^<]{1,90})</strong></p>", promote, body)


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", html.unescape(text).lower()).strip("-")


def toc(body):
    items = re.findall(r'<h([23]) id="([^"]+)"[^>]*>(.*?)</h\1>', body, flags=re.S)
    if len(items) < 3:
        return ""
    lis = "".join(f'<li{" class=sub" if lvl == "3" else ""}><a href="#{i}">{re.sub(r"<[^>]+>", "", t)}</a></li>' for lvl, i, t in items)
    return f"<p>Contents</p><ol>{lis}</ol>"


def end(w):
    # where to go from here: the next worksheet, the tools that go with this one, and back to its stage
    tools = {t["id"]: t["name"] for t in content["tools"]}
    nxt = sheets[sheets.index(w) + 1] if w is not sheets[-1] else None
    parts = []
    if nxt:
        parts.append(f'<div class="next"><p>Next worksheet</p><a href="{nxt["id"]}.html">{html.escape(nxt["title"])}</a></div>')
    if w.get("tools"):
        parts.append("<div><p>Tools for this</p>" + "".join(f'<a href="../#tool-{t}">{html.escape(tools[t])}</a>' for t in w["tools"]) + "</div>")
    parts.append(f'<div><p>Back to</p><a href="../#{w["stage"]}">{stages[w["stage"]]}</a><a href="{w["id"]}.docx" download>Download .docx</a></div>')
    return "".join(parts)


def similar(tag, title):
    words = lambda s: set(re.findall(r"[a-z]+", html.unescape(re.sub(r"<[^>]+>", "", s)).lower())) - {"a", "the", "to", "for", "from"}
    a, b = words(tag), words(title)
    return bool(a) and len(a & b) >= len(a) * 0.5


shutil.rmtree(HERE / "media", ignore_errors=True)
for w in sheets:
    body = subprocess.run(["pandoc", Path(w["file"]).name, "-t", "html5", "--wrap=none", f"--extract-media=media/{w['id']}"],
                          cwd=HERE, check=True, capture_output=True, text=True).stdout
    body = body.replace(f'src="media/{w["id"]}/media/', f'loading="lazy" src="media/{w["id"]}/')
    body = re.sub(r' style="width:[^"]*"', "", body)                          # images size to the column instead
    if (HERE / "media" / w["id"] / "media").exists():
        for f in (HERE / "media" / w["id"] / "media").iterdir():
            f.rename(f.parent.parent / f.name)
        (HERE / "media" / w["id"] / "media").rmdir()
    body = headings(clean(body, w["title"]))
    (HERE / f"{w['id']}.html").write_text(PAGE.format(toc=toc(body), end=end(w),
        id=w["id"], title=html.escape(w["title"]), summary=html.escape(w["summary"]), version=html.escape(w["version"]),
        stage=w["stage"], stage_name=stages[w["stage"]], body=body))
    print("built", w["id"])
