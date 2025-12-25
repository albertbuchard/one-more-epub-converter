import io
import re
import zipfile
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

# -------------------------
# Minimal HTML -> text
# -------------------------

_BLOCK_TAGS = {
    "p", "div", "section", "article", "header", "footer", "aside",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li",
    "pre", "blockquote",
    "hr", "br",
    "table", "tr",
}


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._parts = []
        self._stack = []

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        self._stack.append(tag)
        if tag in ("br", "hr"):
            self._parts.append("\n")
        elif tag in _BLOCK_TAGS:
            self._parts.append("\n")

    def handle_endtag(self, tag):
        tag = tag.lower()
        # Pop stack until matching tag (tolerant)
        for i in range(len(self._stack) - 1, -1, -1):
            if self._stack[i] == tag:
                self._stack = self._stack[:i]
                break
        if tag in _BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data):
        if not data:
            return
        # Ignore content inside script/style
        if any(t in ("script", "style") for t in self._stack):
            return
        self._parts.append(data)

    def get_text(self):
        text = "".join(self._parts)
        # Normalize whitespace while keeping paragraph breaks
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        text = re.sub(r"[ \t\f\v]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def _html_to_text(html: str) -> str:
    parser = _TextExtractor()
    parser.feed(html)
    return parser.get_text()


# -------------------------
# EPUB parsing helpers
# -------------------------

_NS = {
    "c": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
}


def _read_container_rootfile(zf: zipfile.ZipFile) -> str | None:
    try:
        data = zf.read("META-INF/container.xml")
    except KeyError:
        return None
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return None
    el = root.find(".//c:rootfile", _NS)
    if el is None:
        return None
    return el.attrib.get("full-path")


def _join_path(base: str, rel: str) -> str:
    if not base:
        return rel
    if "/" not in base:
        return rel
    prefix = base.rsplit("/", 1)[0]
    # Normalize ./ and ../
    parts = []
    for p in (prefix + "/" + rel).split("/"):
        if p == "" or p == ".":
            continue
        if p == "..":
            if parts:
                parts.pop()
            continue
        parts.append(p)
    return "/".join(parts)


def _parse_opf(zf: zipfile.ZipFile, opf_path: str):
    opf_xml = zf.read(opf_path)
    root = ET.fromstring(opf_xml)

    title = None
    t_el = root.find(".//dc:title", _NS)
    if t_el is not None and t_el.text:
        title = t_el.text.strip()

    manifest = {}
    for item in root.findall(".//opf:manifest/opf:item", _NS):
        item_id = item.attrib.get("id")
        href = item.attrib.get("href")
        media_type = item.attrib.get("media-type", "")
        if item_id and href:
            manifest[item_id] = (href, media_type)

    spine_ids = []
    for itemref in root.findall(".//opf:spine/opf:itemref", _NS):
        idref = itemref.attrib.get("idref")
        if idref:
            spine_ids.append(idref)

    return title, manifest, spine_ids


def _collect_xhtml_paths(zf: zipfile.ZipFile, opf_path: str | None):
    # If OPF exists, use spine order. Else fallback to HTML-ish files.
    if opf_path:
        try:
            title, manifest, spine_ids = _parse_opf(zf, opf_path)
        except Exception:
            title, manifest, spine_ids = None, {}, []
        xhtml_paths = []
        for sid in spine_ids:
            if sid in manifest:
                href, media_type = manifest[sid]
                # Common types: application/xhtml+xml, text/html
                if "html" in media_type or href.lower().endswith((".xhtml", ".html", ".htm")):
                    xhtml_paths.append(_join_path(opf_path, href))
        # Some books omit proper media-types; keep any referenced in spine.
        # If spine empty, fallback.
        if xhtml_paths:
            return title, xhtml_paths

    # Fallback: scan archive
    title = None
    names = zf.namelist()
    candidates = [n for n in names if n.lower().endswith((".xhtml", ".html", ".htm"))]
    candidates.sort()
    return title, candidates


def _read_text_files(zf: zipfile.ZipFile, paths: list[str]):
    out = []
    for p in paths:
        try:
            raw = zf.read(p)
        except KeyError:
            continue
        # Try utf-8 first; then latin-1 as last resort
        try:
            s = raw.decode("utf-8")
        except UnicodeDecodeError:
            s = raw.decode("latin-1", errors="replace")
        out.append((p, s))
    return out


# -------------------------
# Public API (called from JS)
# -------------------------


def epub_to_txt(epub_bytes) -> str:
    """
    epub_bytes: Python bytes-like (passed from JS via Pyodide)
    returns: plain text
    """
    if epub_bytes is None:
        raise ValueError("No EPUB bytes provided")

    bio = io.BytesIO(bytes(epub_bytes))
    with zipfile.ZipFile(bio) as zf:
        opf_path = _read_container_rootfile(zf)
        _, xhtml_paths = _collect_xhtml_paths(zf, opf_path)
        files = _read_text_files(zf, xhtml_paths)

    parts = []
    for _, html in files:
        text = _html_to_text(html)
        if text:
            parts.append(text)

    txt = "\n\n".join(parts).strip()
    txt = re.sub(r"\n{3,}", "\n\n", txt)
    return txt + ("\n" if txt else "")


def epub_to_html(epub_bytes) -> str:
    """
    returns: a single, printable HTML document
    """
    if epub_bytes is None:
        raise ValueError("No EPUB bytes provided")

    bio = io.BytesIO(bytes(epub_bytes))
    with zipfile.ZipFile(bio) as zf:
        opf_path = _read_container_rootfile(zf)
        title, xhtml_paths = _collect_xhtml_paths(zf, opf_path)
        files = _read_text_files(zf, xhtml_paths)

    # We keep it simple and safe: extract text, then render as HTML paragraphs.
    # This avoids broken CSS/layout and makes printing predictable.
    _ = files
    txt = epub_to_txt(epub_bytes)
    safe_title = (title or "EPUB").strip()
    safe_title = re.sub(r"[<>&\"]", "", safe_title)[:200]

    # Convert text -> simple HTML blocks
    blocks = []
    for para in txt.split("\n\n"):
        p = para.strip()
        if not p:
            continue
        # Preserve single newlines inside paragraphs as <br>
        p = (
            p.replace("&", "&amp;")
             .replace("<", "&lt;")
             .replace(">", "&gt;")
             .replace('"', "&quot;")
        )
        p = p.replace("\n", "<br/>")
        blocks.append(f"<p>{p}</p>")

    body = "\n".join(blocks)

    html = f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\" />
  <title>{safe_title}</title>
  <style>
    body {{
      font-family: Georgia, \"Times New Roman\", Times, serif;
      margin: 42px;
      line-height: 1.45;
      color: #111;
      max-width: 820px;
    }}
    h1 {{
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      font-size: 20px;
      margin: 0 0 18px 0;
    }}
    p {{ margin: 0 0 12px 0; }}
    @page {{ margin: 18mm; }}
  </style>
</head>
<body>
  <h1>{safe_title}</h1>
  {body}
</body>
</html>
"""
    return html
