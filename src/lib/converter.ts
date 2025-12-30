import DOMPurify from "dompurify";
import ePub from "epubjs";
import JSZip from "jszip";

type EpubBook = ReturnType<typeof ePub> & {
  spine: {
    spineItems: Array<{
      load: (loader: unknown) => Promise<{
        document?: { body?: { innerHTML: string } };
        contents?: string;
        unload?: () => void;
      }>;
      document?: { body?: { innerHTML: string } };
      contents?: string;
      unload?: () => void;
      href?: string;
      url?: string;
    }>;
  };
  package?: { metadata?: { title?: string } };
  load?: (...args: unknown[]) => unknown;
  resolve?: (path: string) => string;
  archived?: boolean;
  archive?: {
    createUrl: (path: string) => string;
  };

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

type HtmlExportMode = "zip" | "inline";

type AssetRecord = {
  blob: Blob;
  mimeType: string;
  resolvedUrl: string;
  normalizedPath: string;
};

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
    const request = book.load?.bind(book);
    if (!request) throw new Error("book.load is missing");

    for (const section of book.spine?.spineItems ?? []) {
      try {
        // epub.js: section.load(request) populates section.document / section.contents
        const contents = await section.load(request);

        // Prefer the parsed document if present, otherwise fallback to returned string
        const html =
          section?.document?.body?.innerHTML ??
          section?.contents ??
          (typeof contents === "string" ? contents : "");

        const href = section?.href || section?.url || "";

        yield { html: html || "", href };
      } finally {
        // Important for big books: frees memory
        section?.unload?.();
      }
    }
  }

  async toHtml(book: EpubBook) {
    const sections: string[] = [];
    for await (const { html } of this.iterateSpine(book)) {
      const safeHtml = this.sanitizer.sanitize(html);
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
    for await (const { html } of this.iterateSpine(book)) {
      const safeHtml = this.sanitizer.sanitize(html);
      const text = this.textExtractor.htmlToText(safeHtml);
      if (text) {
        chunks.push(text, "\n\n");
      }
    }
    const text = chunks.join("").trimEnd();
    return text ? `${text}\n` : "";
  }

  async toHtmlWithAssets(book: EpubBook, options: { mode: HtmlExportMode }) {
    const sections: string[] = [];
    const assetCache = new Map<string, Promise<AssetRecord | null>>();
    const dataUrlCache = new Map<string, Promise<string>>();
    const zip = options.mode === "zip" ? new JSZip() : null;
    const assetPathByResolved = new Map<string, string>();
    const usedAssetPaths = new Set<string>();

    for await (const { html, href } of this.iterateSpine(book)) {
      const safeHtml = this.sanitizer.sanitize(html);
      const rewritten = await this.rewriteChapterHtml({
        html: safeHtml,
        sectionHref: href,
        book,
        mode: options.mode,
        assetCache,
        dataUrlCache,
        zip,
        assetPathByResolved,
        usedAssetPaths,
      });
      const finalHtml = this.sanitizer.sanitize(rewritten);
      sections.push(`<div class="chapter">${finalHtml}</div>`);
    }

    const bodyHtml = sections.join("\n");
    const html = this.templateBuilder.buildDocument({
      title: book.package?.metadata?.title || "EPUB",
      bodyHtml,
    });

    if (options.mode === "inline") {
      return { html } as const;
    }

    if (!zip) {
      throw new Error("ZIP export is not available.");
    }

    zip.file("index.html", html);
    const zipBlob = await zip.generateAsync({ type: "blob" });
    return { zipBlob, htmlPreview: html } as const;
  }

  private async rewriteChapterHtml({
    html,
    sectionHref,
    book,
    mode,
    assetCache,
    dataUrlCache,
    zip,
    assetPathByResolved,
    usedAssetPaths,
  }: {
    html: string;
    sectionHref: string;
    book: EpubBook;
    mode: HtmlExportMode;
    assetCache: Map<string, Promise<AssetRecord | null>>;
    dataUrlCache: Map<string, Promise<string>>;
    zip: JSZip | null;
    assetPathByResolved: Map<string, string>;
    usedAssetPaths: Set<string>;
  }) {
    const container = document.createElement("div");
    container.innerHTML = html;

    const rewriteUrl = async (rawUrl: string | null): Promise<string | null> => {
      if (!rawUrl) return null;
      const resolved = this.resolveAssetTarget(rawUrl, sectionHref, book);
      if (resolved.isExternal || !resolved.normalizedPath) return rawUrl;

      const asset = await this.getAsset(resolved, book, assetCache);
      if (!asset) {
        console.warn("Failed to load asset", rawUrl);
        return rawUrl;
      }

      if (mode === "inline") {
        if (!dataUrlCache.has(asset.resolvedUrl)) {
          dataUrlCache.set(asset.resolvedUrl, this.blobToDataUrl(asset.blob));
        }
        return await dataUrlCache.get(asset.resolvedUrl)!;
      }

      if (!zip) return rawUrl;
      let assetPath = assetPathByResolved.get(asset.resolvedUrl);
      if (!assetPath) {
        const safePath = this.toSafeAssetPath(asset.normalizedPath);
        assetPath = this.ensureUniqueAssetPath(safePath, usedAssetPaths);
        assetPathByResolved.set(asset.resolvedUrl, assetPath);
        zip.file(`assets/${assetPath}`, asset.blob);
      }
      return `assets/${assetPath}`;
    };

    const rewriteSrcset = async (rawValue: string | null) => {
      if (!rawValue) return null;
      const entries = rawValue
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      const rewritten: string[] = [];
      for (const entry of entries) {
        const [urlPart, ...rest] = entry.split(/\s+/);
        const rewrittenUrl = (await rewriteUrl(urlPart)) || urlPart;
        rewritten.push([rewrittenUrl, ...rest].filter(Boolean).join(" "));
      }
      return rewritten.join(", ");
    };

    const imgElements = Array.from(container.querySelectorAll("img"));
    for (const img of imgElements) {
      const rewritten = await rewriteUrl(img.getAttribute("src"));
      if (rewritten) img.setAttribute("src", rewritten);
      const srcset = await rewriteSrcset(img.getAttribute("srcset"));
      if (srcset) img.setAttribute("srcset", srcset);
    }

    const sourceElements = Array.from(container.querySelectorAll("source"));
    for (const source of sourceElements) {
      const rewritten = await rewriteUrl(source.getAttribute("src"));
      if (rewritten) source.setAttribute("src", rewritten);
      const srcset = await rewriteSrcset(source.getAttribute("srcset"));
      if (srcset) source.setAttribute("srcset", srcset);
    }

    const svgImages = Array.from(container.querySelectorAll("image"));
    for (const image of svgImages) {
      const href = image.getAttribute("href") ?? image.getAttribute("xlink:href");
      const rewritten = await rewriteUrl(href);
      if (rewritten) {
        image.setAttribute("href", rewritten);
        if (image.hasAttribute("xlink:href")) {
          image.setAttribute("xlink:href", rewritten);
        }
      }
    }

    const linkElements = Array.from(container.querySelectorAll("link"));
    for (const link of linkElements) {
      const rel = (link.getAttribute("rel") || "").toLowerCase();
      if (!rel.includes("stylesheet")) continue;
      const rewritten = await rewriteUrl(link.getAttribute("href"));
      if (rewritten) link.setAttribute("href", rewritten);
    }

    return container.innerHTML;
  }

  private resolveAssetTarget(rawUrl: string, sectionHref: string, book: EpubBook) {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
      return { resolvedUrl: rawUrl, normalizedPath: "", isExternal: true };
    }

    if (/^(data:|https?:|blob:)/i.test(trimmed)) {
      return { resolvedUrl: trimmed, normalizedPath: "", isExternal: true };
    }

    const cleanSection = sectionHref.split("#")[0].split("?")[0];
    const baseDir = cleanSection.includes("/")
      ? cleanSection.slice(0, cleanSection.lastIndexOf("/") + 1)
      : "";
    const normalized = new URL(trimmed, `https://x/${baseDir}`);
    const normalizedPath = normalized.pathname.replace(/^\/+/, "");
    const resolvedUrl = book.resolve ? book.resolve(normalizedPath) : normalizedPath;
    return { resolvedUrl, normalizedPath, isExternal: false };
  }

  private async getAsset(
    resolved: { resolvedUrl: string; normalizedPath: string },
    book: EpubBook,
    cache: Map<string, Promise<AssetRecord | null>>
  ) {
    if (!cache.has(resolved.resolvedUrl)) {
      cache.set(resolved.resolvedUrl, this.fetchAsset(resolved, book));
    }
    return await cache.get(resolved.resolvedUrl)!;
  }

  private async fetchAsset(resolved: { resolvedUrl: string; normalizedPath: string }, book: EpubBook) {
    try {
      let fetchUrl = resolved.resolvedUrl;
      if (book.archived && book.archive?.createUrl) {
        fetchUrl = book.archive.createUrl(resolved.resolvedUrl);
      }
      const response = await fetch(fetchUrl);
      if (!response.ok) {
        return null;
      }
      const blob = await response.blob();
      const mimeType = blob.type || this.inferMimeType(resolved.normalizedPath) || "application/octet-stream";
      const typedBlob = blob.type ? blob : new Blob([blob], { type: mimeType });
      return {
        blob: typedBlob,
        mimeType,
        resolvedUrl: resolved.resolvedUrl,
        normalizedPath: resolved.normalizedPath,
      } satisfies AssetRecord;
    } catch (error) {
      console.warn("Asset fetch failed", resolved.resolvedUrl, error);
      return null;
    }
  }

  private inferMimeType(path: string) {
    const clean = path.split("?")[0].split("#")[0];
    const ext = clean.slice(clean.lastIndexOf(".") + 1).toLowerCase();
    const map: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      svg: "image/svg+xml",
      webp: "image/webp",
      css: "text/css",
      ttf: "font/ttf",
      otf: "font/otf",
      woff: "font/woff",
      woff2: "font/woff2",
    };
    return map[ext];
  }

  private toSafeAssetPath(path: string) {
    const clean = path.split("?")[0].split("#")[0];
    const segments = clean
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment && segment !== "." && segment !== "..");
    const safeSegments = segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
    return safeSegments.join("/") || "asset";
  }

  private ensureUniqueAssetPath(path: string, used: Set<string>) {
    if (!used.has(path)) {
      used.add(path);
      return path;
    }
    const extIndex = path.lastIndexOf(".");
    const base = extIndex > 0 ? path.slice(0, extIndex) : path;
    const ext = extIndex > 0 ? path.slice(extIndex) : "";
    let counter = 2;
    let candidate = `${base}-${counter}${ext}`;
    while (used.has(candidate)) {
      counter += 1;
      candidate = `${base}-${counter}${ext}`;
    }
    used.add(candidate);
    return candidate;
  }

  private blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
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
