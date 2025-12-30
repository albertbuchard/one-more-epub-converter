import DOMPurify from "dompurify";
import ePub from "epubjs";

type EpubBook = ReturnType<typeof ePub> & {
  spine: {
    spineItems: Array<{
      load: (loader: unknown) => Promise<{
        document?: { body?: { innerHTML: string } };
        contents?: string;
        unload?: () => void;
      }>;
    }>;
  };
  package?: { metadata?: { title?: string } };
  load?: (...args: unknown[]) => unknown;

  // important:
  opened?: Promise<unknown>;
  loaded?: {
    spine?: Promise<unknown>;
    manifest?: Promise<unknown>;
    metadata?: Promise<unknown>;
  };

  ready?: Promise<void>;
};


const withTimeout = <T>(p: Promise<T>, ms: number, label: string) =>
    Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout waiting for ${label}`)), ms)),
    ]);

export class EpubRuntime {
  private ready = false;

  async init() {
    this.ready = true;
  }

  openBook(arrayBuffer: ArrayBuffer) {
    if (!this.ready) {
      throw new Error("EPUB runtime not initialized");
    }
    return ePub(arrayBuffer) as EpubBook;
  }
}


export class HtmlSanitizer {
  sanitize(html: string) {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["script", "iframe", "object", "embed"],
      FORBID_ATTR: ["onerror", "onload", "onclick"],
    });
  }
}

class HtmlTemplateBuilder {
  buildDocument({ title, bodyHtml }: { title?: string; bodyHtml: string }) {
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

  private escape(value: string) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

class TextExtractor {
  private blockTags = new Set([
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

  htmlToText(html: string) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const parts: string[] = [];

    const walker = document.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as Element).tagName?.toLowerCase();
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

export class EpubConverter {
  private templateBuilder = new HtmlTemplateBuilder();
  private textExtractor = new TextExtractor();

  constructor(private runtime: EpubRuntime, private sanitizer: HtmlSanitizer) {}

  async loadBook(arrayBuffer: ArrayBuffer) {
    const book = this.runtime.openBook(arrayBuffer) as EpubBook;

    // Prefer opened; it's much less likely to hang than ready
    const opened = book.opened ?? book.ready ?? Promise.resolve();

    // 60s is arbitrary; pick what you want
    await withTimeout(Promise.resolve(opened), 60_000, "book.opened");

    // If available, wait for spine specifically (what you actually need for conversion)
    if (book.loaded?.spine) {
      await withTimeout(Promise.resolve(book.loaded.spine), 60_000, "book.loaded.spine");
    }

    return book;
  }

  private async *iterateSpine(book: EpubBook) {
    for (const item of book.spine.spineItems) {
      const section = await item.load(book.load?.bind(book));
      try {
        if (section?.document?.body) {
          yield section.document.body.innerHTML;
        } else if (section?.contents) {
          yield section.contents;
        } else {
          yield "";
        }
      } finally {
        section?.unload?.();
      }
    }
  }

  async toHtml(book: EpubBook) {
    const sections: string[] = [];
    for await (const rawHtml of this.iterateSpine(book)) {
      const safeHtml = this.sanitizer.sanitize(rawHtml);
      sections.push(`<div class="chapter">${safeHtml}</div>`);
    }

    const bodyHtml = sections.join("\n");
    return this.templateBuilder.buildDocument({
      title: book.package?.metadata?.title || "EPUB",
      bodyHtml,
    });
  }

  async toTxt(book: EpubBook) {
    const chunks: string[] = [];
    for await (const rawHtml of this.iterateSpine(book)) {
      const safeHtml = this.sanitizer.sanitize(rawHtml);
      const text = this.textExtractor.htmlToText(safeHtml);
      if (text) {
        chunks.push(text, "\n\n");
      }
    }
    const text = chunks.join("").trimEnd();
    return text ? `${text}\n` : "";
  }
}

export class DownloadService {
  downloadBlob(blob: Blob, filename: string) {
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 2500);
  }
}

export class PrintService {
  openPrintable(html: string, title: string) {
    const popup = window.open("", "_blank", "noopener,noreferrer");
    if (!popup) {
      throw new Error("Popup blocked. Allow popups to open printable view.");
    }
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    popup.document.title = title || "EPUB";
    setTimeout(() => popup.print(), 250);
  }
}

export class FileNameService {
  static baseName(file: File | null) {
    const rawName = file?.name || "book";
    return rawName.replace(/\.epub$/i, "") || "book";
  }
}
