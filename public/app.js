// Client-side EPUB conversion using epub.js.
// Works on Cloudflare Pages because it’s just static files.

class AppState {
  constructor() {
    this.book = null;
    this.lastHtml = null;
    this.lastTxt = null;
    this.lastBaseName = "book";
  }

  resetFileState() {
    this.book = null;
    this.lastHtml = null;
    this.lastTxt = null;
    this.lastBaseName = "book";
  }
}

class StatusView {
  constructor(statusEl, outputEl) {
    this.statusEl = statusEl;
    this.outputEl = outputEl;
  }

  setStatus(message) {
    this.statusEl.textContent = message;
  }

  setOutput(text) {
    this.outputEl.value = text;
  }
}

class DownloadService {
  downloadBlob(blob, filename) {
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 2500);
  }
}

class PrintService {
  openPrintable(html, title) {
    const popup = window.open("", "_blank", "noopener,noreferrer");
    if (!popup) {
      alert("Popup blocked. Allow popups to open printable view.");
      return;
    }
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    popup.document.title = title || "EPUB";
    // Let layout settle before triggering print.
    setTimeout(() => popup.print(), 250);
  }
}

class EpubRuntime {
  constructor() {
    this.ready = false;
  }

  async init() {
    if (!window.ePub) {
      throw new Error("epub.js failed to load");
    }
    this.ready = true;
  }

  openBook(arrayBuffer) {
    if (!this.ready) {
      throw new Error("EPUB runtime not initialized");
    }
    return window.ePub(arrayBuffer);
  }
}

class HtmlTemplateBuilder {
  buildDocument({ title, bodyHtml }) {
    const safeTitle = this.escape(title || "EPUB").slice(0, 200);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body {
      font-family: Georgia, "Times New Roman", Times, serif;
      margin: 42px;
      line-height: 1.45;
      color: #111;
      max-width: 820px;
    }
    h1 {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      font-size: 20px;
      margin: 0 0 18px 0;
    }
    p { margin: 0 0 12px 0; }
    @page { margin: 18mm; }
  </style>
</head>
<body>
  <h1>${safeTitle}</h1>
  ${bodyHtml}
</body>
</html>`;
  }

  escape(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

class TextExtractor {
  constructor() {
    this.blockTags = new Set([
      "p",
      "div",
      "section",
      "article",
      "header",
      "footer",
      "aside",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "pre",
      "blockquote",
      "hr",
      "br",
      "table",
      "tr",
    ]);
  }

  htmlToText(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const parts = [];

    const walker = document.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName?.toLowerCase();
        if (tag && this.blockTags.has(tag)) {
          parts.push("\n");
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue;
        if (text && text.trim()) {
          parts.push(text);
        }
      }
      node = walker.nextNode();
    }

    return parts
      .join("")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}

class EpubConverter {
  constructor(runtime) {
    this.runtime = runtime;
    this.templateBuilder = new HtmlTemplateBuilder();
    this.textExtractor = new TextExtractor();
  }

  async loadBook(arrayBuffer) {
    const book = this.runtime.openBook(arrayBuffer);
    await book.ready;
    return book;
  }

  async toHtml(book) {
    const sections = [];
    for (const item of book.spine.spineItems) {
      const section = await item.load(book.load.bind(book));
      if (section?.document?.body) {
        sections.push(section.document.body.innerHTML);
      } else if (section?.contents) {
        sections.push(section.contents);
      }
      section?.unload?.();
    }

    const bodyHtml = sections.map((html) => `<div class="chapter">${html}</div>`).join("\n");
    return this.templateBuilder.buildDocument({
      title: book.package?.metadata?.title || "EPUB",
      bodyHtml,
    });
  }

  async toTxt(book) {
    const sections = [];
    for (const item of book.spine.spineItems) {
      const section = await item.load(book.load.bind(book));
      if (section?.document?.body) {
        sections.push(section.document.body.innerHTML);
      } else if (section?.contents) {
        sections.push(section.contents);
      }
      section?.unload?.();
    }

    const combinedHtml = sections.join("\n");
    const text = this.textExtractor.htmlToText(combinedHtml);
    return text ? `${text}\n` : "";
  }
}

class FileNameService {
  static baseName(file) {
    const rawName = file?.name || "book";
    return rawName.replace(/\.epub$/i, "") || "book";
  }
}

class EpubApp {
  constructor(els) {
    this.els = els;
    this.state = new AppState();
    this.view = new StatusView(els.status, els.out);
    this.runtime = new EpubRuntime();
    this.converter = new EpubConverter(this.runtime);
    this.downloader = new DownloadService();
    this.printer = new PrintService();
  }

  async init() {
    this.view.setStatus("Loading EPUB runtime…");
    await this.runtime.init();
    this.view.setStatus("Ready. Choose an .epub file.");
    this.els.btnTxt.disabled = false;
    this.els.btnPdf.disabled = false;
    this.els.btnHtml.disabled = false;
    this.bindEvents();
  }

  bindEvents() {
    this.els.file.addEventListener("change", (event) => this.onFileChange(event));
    this.els.btnTxt.addEventListener("click", () => this.convertTxt());
    this.els.btnHtml.addEventListener("click", () => this.convertHtml());
    this.els.btnPdf.addEventListener("click", () => this.openPrintable());
    this.els.btnClear.addEventListener("click", () => this.clear());
  }

  async onFileChange(event) {
    const file = event.target.files?.[0];
    this.state.lastHtml = null;
    this.state.lastTxt = null;
    this.view.setOutput("");
    if (!file) return;

    this.state.lastBaseName = FileNameService.baseName(file);
    this.view.setStatus(`Reading ${file.name}…`);

    const buf = await file.arrayBuffer();
    this.state.book = await this.converter.loadBook(buf);

    this.view.setStatus(`Loaded ${file.name}. Choose TXT or Printable.`);
  }

  async convertTxt() {
    if (!this.state.book) return;

    this.view.setStatus("Converting to TXT…");
    try {
      this.state.lastTxt = await this.converter.toTxt(this.state.book);
      this.view.setOutput(this.state.lastTxt.slice(0, 200000));
      this.view.setStatus("TXT ready. Downloading…");
      this.downloader.downloadBlob(
        new Blob([this.state.lastTxt], { type: "text/plain;charset=utf-8" }),
        `${this.state.lastBaseName}.txt`,
      );
      this.view.setStatus("Done.");
    } catch (error) {
      console.error(error);
      this.view.setStatus(`Error: ${error?.message || error}`);
    }
  }

  async convertHtml() {
    if (!this.state.book) return;

    this.view.setStatus("Converting to HTML…");
    try {
      this.state.lastHtml = await this.converter.toHtml(this.state.book);
      this.view.setOutput("(HTML generated — use Download HTML or Printable)\n");
      this.view.setStatus("HTML ready. Downloading…");
      this.downloader.downloadBlob(
        new Blob([this.state.lastHtml], { type: "text/html;charset=utf-8" }),
        `${this.state.lastBaseName}.html`,
      );
      this.view.setStatus("Done.");
    } catch (error) {
      console.error(error);
      this.view.setStatus(`Error: ${error?.message || error}`);
    }
  }

  async openPrintable() {
    if (!this.state.book) return;

    this.view.setStatus("Building printable view…");
    try {
      if (!this.state.lastHtml) {
        this.state.lastHtml = await this.converter.toHtml(this.state.book);
      }
      this.view.setStatus("Opening printable view…");
      this.printer.openPrintable(this.state.lastHtml, this.state.lastBaseName);
      this.view.setStatus("Printable view opened. Use Print → Save as PDF.");
    } catch (error) {
      console.error(error);
      this.view.setStatus(`Error: ${error?.message || error}`);
    }
  }

  clear() {
    this.state.resetFileState();
    this.els.file.value = "";
    this.view.setOutput("");
    this.view.setStatus("Cleared. Choose an .epub file.");
  }
}

const els = {
  file: document.getElementById("file"),
  btnTxt: document.getElementById("btnTxt"),
  btnPdf: document.getElementById("btnPdf"),
  btnHtml: document.getElementById("btnHtml"),
  btnClear: document.getElementById("btnClear"),
  status: document.getElementById("status"),
  out: document.getElementById("out"),
};

const app = new EpubApp(els);
app.init().catch((error) => {
  console.error(error);
  els.status.textContent = `Failed to load runtime: ${error?.message || error}`;
});
