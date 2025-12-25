// Client-side EPUB conversion using Pyodide.
// Works on Cloudflare Pages because it’s just static files.

import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.mjs";

class AppState {
  constructor() {
    this.epubBytes = null;
    this.lastHtml = null;
    this.lastTxt = null;
    this.lastBaseName = "book";
  }

  resetFileState() {
    this.epubBytes = null;
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

class PyodideRuntime {
  constructor(pyPath) {
    this.pyPath = pyPath;
    this.pyodide = null;
  }

  async init() {
    this.pyodide = await loadPyodide();
    const pySrc = await (await fetch(this.pyPath)).text();
    this.pyodide.runPython(pySrc);
  }

  runWithBytes(functionName, epubBytes) {
    if (!this.pyodide) {
      throw new Error("Python runtime is not initialized");
    }
    this.pyodide.globals.set("EPUB_BYTES", epubBytes);
    try {
      const result = this.pyodide.runPython(`${functionName}(EPUB_BYTES.to_py())`);
      return String(result);
    } finally {
      try {
        this.pyodide.globals.delete("EPUB_BYTES");
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}

class EpubConverter {
  constructor(runtime) {
    this.runtime = runtime;
  }

  toTxt(epubBytes) {
    return this.runtime.runWithBytes("epub_to_txt", epubBytes);
  }

  toHtml(epubBytes) {
    return this.runtime.runWithBytes("epub_to_html", epubBytes);
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
    this.runtime = new PyodideRuntime("./py/epub_convert.py");
    this.converter = new EpubConverter(this.runtime);
    this.downloader = new DownloadService();
    this.printer = new PrintService();
  }

  async init() {
    this.view.setStatus("Loading Python runtime…");
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
    this.state.epubBytes = new Uint8Array(buf);

    this.view.setStatus(`Loaded ${file.name}. Choose TXT or Printable.`);
  }

  convertTxt() {
    if (!this.runtime.pyodide || !this.state.epubBytes) return;

    this.view.setStatus("Converting to TXT…");
    try {
      this.state.lastTxt = this.converter.toTxt(this.state.epubBytes);
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

  convertHtml() {
    if (!this.runtime.pyodide || !this.state.epubBytes) return;

    this.view.setStatus("Converting to HTML…");
    try {
      this.state.lastHtml = this.converter.toHtml(this.state.epubBytes);
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

  openPrintable() {
    if (!this.runtime.pyodide || !this.state.epubBytes) return;

    this.view.setStatus("Building printable view…");
    try {
      if (!this.state.lastHtml) {
        this.state.lastHtml = this.converter.toHtml(this.state.epubBytes);
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
