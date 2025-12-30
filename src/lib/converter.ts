import DOMPurify from "dompurify";
import ePub from "epubjs";
import JSZip from "jszip";
import html2pdf from "html2pdf.js";

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
      ADD_ATTR: ["xlink:href", "srcset"],
      ALLOWED_URI_REGEXP:
        /^(?:(?:https?|mailto|ftp|tel|sms|blob):|data:image\/(?:png|jpe?g|gif|webp|svg\+xml)|data:application\/octet-stream|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
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
    img { max-width: 100%; height: auto; }
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

type InlineStats = {
  inlined: number;
  skipped: number;
};

type DataUriResult = {
  dataUri: string;
  mimeType: string;
};

const IMAGE_MIME_PATTERN = /^image\//i;
const INLINE_WARNING_PREFIX = "[inline]";

function isImageMimeType(mimeType: string) {
  return IMAGE_MIME_PATTERN.test(mimeType);
}

function resolveRelativePath(baseHref: string, ref: string): { path: string; fragment: string } {
  const [refPath, fragment = ""] = ref.split("#", 2);
  const baseDir = baseHref.includes("/") ? baseHref.slice(0, baseHref.lastIndexOf("/") + 1) : "";
  const url = new URL(refPath, `https://epub.local/${baseDir}`);
  const path = url.pathname.replace(/^\/+/, "");
  return { path, fragment: fragment ? `#${fragment}` : "" };
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
    const { html } = await this.buildHtmlWithInlinedAssets(book);
    return html;
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
    const { html } = await this.buildHtmlWithInlinedAssets(book);

    if (options.mode === "inline") {
      return { html } as const;
    }

    const zip = new JSZip();
    zip.file("index.html", html);
    const zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    return { zipBlob, htmlPreview: html } as const;
  }

  private async buildHtmlWithInlinedAssets(book: EpubBook) {
    const sections: string[] = [];
    const dataUriCache = new Map<string, Promise<DataUriResult | null>>();
    const cssCache = new Map<string, Promise<string | null>>();
    const warningCache = new Set<string>();
    const stats: InlineStats = { inlined: 0, skipped: 0 };

    for await (const { html, href } of this.iterateSpine(book)) {
      const safeHtml = this.sanitizer.sanitize(html);
      const rewritten = await this.inlineEpubAssetsInHtml({
        html: safeHtml,
        baseHref: href,
        book,
        dataUriCache,
        cssCache,
        warningCache,
        stats,
      });
      const finalHtml = this.sanitizer.sanitize(rewritten);
      sections.push(`<div class="chapter">${finalHtml}</div>`);
    }

    if (import.meta.env.DEV) {
      console.info(`${INLINE_WARNING_PREFIX} summary`, { inlined: stats.inlined, skipped: stats.skipped });
    }

    const bodyHtml = sections.join("\n");
    const html = this.templateBuilder.buildDocument({
      title: book.package?.metadata?.title || "EPUB",
      bodyHtml,
    });

    return { html, stats } as const;
  }

  private async inlineEpubAssetsInHtml({
    html,
    baseHref,
    book,
    dataUriCache,
    cssCache,
    warningCache,
    stats,
  }: {
    html: string;
    baseHref: string;
    book: EpubBook;
    dataUriCache: Map<string, Promise<DataUriResult | null>>;
    cssCache: Map<string, Promise<string | null>>;
    warningCache: Set<string>;
    stats: InlineStats;
  }) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const root = doc.body ?? doc.documentElement;

    const shouldIgnoreRef = (ref: string) => /^(data:|blob:|https?:)/i.test(ref);

    const inlineUrl = async (rawUrl: string | null): Promise<string | null> => {
      if (!rawUrl) return null;
      const trimmed = rawUrl.trim();
      if (!trimmed || trimmed.startsWith("#") || shouldIgnoreRef(trimmed)) {
        return null;
      }
      const { path, fragment } = resolveRelativePath(baseHref, trimmed);
      if (!path) return null;

      const asset = await this.getAssetDataUri({
        epubPath: path,
        baseHref,
        ref: trimmed,
        book,
        dataUriCache,
        warningCache,
      });
      if (!asset || !isImageMimeType(asset.mimeType)) {
        stats.skipped += 1;
        return null;
      }
      if (!asset.dataUri.startsWith("data:image/")) {
        stats.skipped += 1;
        return null;
      }
      stats.inlined += 1;
      return `${asset.dataUri}${fragment}`;
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
        const rewrittenUrl = (await inlineUrl(urlPart)) || urlPart;
        rewritten.push([rewrittenUrl, ...rest].filter(Boolean).join(" "));
      }
      return rewritten.join(", ");
    };

    const imgElements = Array.from(root.querySelectorAll("img"));
    for (const img of imgElements) {
      const rewritten = await inlineUrl(img.getAttribute("src"));
      if (rewritten) img.setAttribute("src", rewritten);
      const srcset = await rewriteSrcset(img.getAttribute("srcset"));
      if (srcset) img.setAttribute("srcset", srcset);
    }

    const sourceElements = Array.from(root.querySelectorAll("source"));
    for (const source of sourceElements) {
      const rewritten = await inlineUrl(source.getAttribute("src"));
      if (rewritten) source.setAttribute("src", rewritten);
      const srcset = await rewriteSrcset(source.getAttribute("srcset"));
      if (srcset) source.setAttribute("srcset", srcset);
    }

    const svgImages = Array.from(root.querySelectorAll("image"));
    for (const image of svgImages) {
      const href = image.getAttribute("href") ?? image.getAttribute("xlink:href");
      const rewritten = await inlineUrl(href);
      if (rewritten) {
        image.setAttribute("href", rewritten);
        if (image.hasAttribute("xlink:href")) {
          image.setAttribute("xlink:href", rewritten);
        }
      }
    }

    const linkElements = Array.from(root.querySelectorAll("link"));
    for (const link of linkElements) {
      const rel = (link.getAttribute("rel") || "").toLowerCase();
      if (!rel.includes("stylesheet")) continue;
      const href = link.getAttribute("href");
      if (!href) continue;
      const rewrittenCss = await this.rewriteStylesheet({
        href,
        sectionHref: baseHref,
        book,
        dataUriCache,
        cssCache,
        warningCache,
      });
      if (!rewrittenCss) continue;
      const style = doc.createElement("style");
      style.textContent = rewrittenCss;
      link.replaceWith(style);
    }

    return root.innerHTML;
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
    };
    return map[ext];
  }

  private blobToDataUri(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob"));
      reader.readAsDataURL(blob);
    });
  }

  private warnInlineOnce(
    warningCache: Set<string>,
    key: string,
    message: string,
    details: Record<string, unknown>
  ) {
    if (warningCache.has(key)) return;
    warningCache.add(key);
    console.warn(message, details);
  }

  private async getAssetDataUri({
    epubPath,
    baseHref,
    ref,
    book,
    dataUriCache,
    warningCache,
  }: {
    epubPath: string;
    baseHref: string;
    ref: string;
    book: EpubBook;
    dataUriCache: Map<string, Promise<DataUriResult | null>>;
    warningCache: Set<string>;
  }) {
    if (!dataUriCache.has(epubPath)) {
      dataUriCache.set(
        epubPath,
        this.fetchAssetDataUri({
          epubPath,
          baseHref,
          ref,
          book,
          warningCache,
        })
      );
    }
    return await dataUriCache.get(epubPath)!;
  }

  private async fetchAssetDataUri({
    epubPath,
    baseHref,
    ref,
    book,
    warningCache,
  }: {
    epubPath: string;
    baseHref: string;
    ref: string;
    book: EpubBook;
    warningCache: Set<string>;
  }): Promise<DataUriResult | null> {
    const asset = await this.fetchEpubAsset({
      epubPath,
      baseHref,
      ref,
      book,
      warningCache,
      expectImage: true,
    });
    if (!asset) return null;
    const dataUri = await this.blobToDataUri(asset.blob);
    if (/^data:text\/(html|plain)/i.test(dataUri)) {
      this.warnInlineOnce(warningCache, `html-data:${epubPath}`, `${INLINE_WARNING_PREFIX} fetched HTML instead of image`, {
        baseHref,
        ref,
        epubPath,
        contentType: asset.mimeType,
      });
      return null;
    }
    return { dataUri, mimeType: asset.mimeType };
  }

  private async fetchEpubAsset({
    epubPath,
    baseHref,
    ref,
    book,
    warningCache,
    expectImage,
  }: {
    epubPath: string;
    baseHref: string;
    ref: string;
    book: EpubBook;
    warningCache: Set<string>;
    expectImage: boolean;
  }) {
    let fetchUrl = epubPath;
    let revokeUrl = false;
    const prefersArchive = book.archived === true || Boolean(book.archive?.createUrl);
    if (prefersArchive && book.archive?.createUrl) {
      fetchUrl = book.archive.createUrl(epubPath);
      revokeUrl = fetchUrl.startsWith("blob:");
    } else if (!prefersArchive && book.resolve) {
      fetchUrl = book.resolve(epubPath);
    } else if (book.archive?.createUrl) {
      fetchUrl = book.archive.createUrl(epubPath);
      revokeUrl = fetchUrl.startsWith("blob:");
    }

    try {
      const response = await fetch(fetchUrl);
      if (!response.ok) {
        this.warnInlineOnce(warningCache, `fetch:${epubPath}`, `${INLINE_WARNING_PREFIX} failed to fetch asset`, {
          baseHref,
          ref,
          epubPath,
          contentType: response.headers.get("content-type") ?? "unknown",
        });
        return null;
      }
      const blob = await response.blob();
      const contentType = blob.type || "";
      if (contentType === "text/html" || contentType === "text/plain") {
        this.warnInlineOnce(warningCache, `html:${epubPath}`, `${INLINE_WARNING_PREFIX} fetched HTML instead of image`, {
          baseHref,
          ref,
          epubPath,
          contentType,
        });
        return null;
      }

      const inferred = blob.type || this.inferMimeType(epubPath) || "application/octet-stream";
      if (expectImage && blob.size < 200 && !isImageMimeType(inferred)) {
        this.warnInlineOnce(warningCache, `small:${epubPath}`, `${INLINE_WARNING_PREFIX} skipping non-image asset`, {
          baseHref,
          ref,
          epubPath,
          contentType: inferred,
        });
        return null;
      }

      const typedBlob = blob.type ? blob : new Blob([blob], { type: inferred });
      return { blob: typedBlob, mimeType: inferred };
    } catch (error) {
      this.warnInlineOnce(warningCache, `error:${epubPath}`, `${INLINE_WARNING_PREFIX} failed to load asset`, {
        baseHref,
        ref,
        epubPath,
        contentType: "unknown",
        error,
      });
      return null;
    } finally {
      if (revokeUrl) {
        URL.revokeObjectURL(fetchUrl);
      }
    }
  }

  private async rewriteStylesheet({
    href,
    sectionHref,
    book,
    dataUriCache,
    cssCache,
    warningCache,
  }: {
    href: string;
    sectionHref: string;
    book: EpubBook;
    dataUriCache: Map<string, Promise<DataUriResult | null>>;
    cssCache: Map<string, Promise<string | null>>;
    warningCache: Set<string>;
  }) {
    const trimmed = href.trim();
    if (!trimmed || /^(data:|blob:|https?:)/i.test(trimmed)) {
      return null;
    }
    const { path } = resolveRelativePath(sectionHref, trimmed);
    if (!path) return null;

    if (!cssCache.has(path)) {
      cssCache.set(
        path,
        (async () => {
          const asset = await this.fetchEpubAsset({
            epubPath: path,
            baseHref: sectionHref,
            ref: trimmed,
            book,
            warningCache,
            expectImage: false,
          });
          if (!asset) return null;
          const cssText = await asset.blob.text();
          return await this.rewriteCssUrls({
            cssText,
            cssHref: path,
            book,
            dataUriCache,
            warningCache,
          });
        })()
      );
    }

    return await cssCache.get(path)!;
  }

  private async rewriteCssUrls({
    cssText,
    cssHref,
    book,
    dataUriCache,
    warningCache,
  }: {
    cssText: string;
    cssHref: string;
    book: EpubBook;
    dataUriCache: Map<string, Promise<DataUriResult | null>>;
    warningCache: Set<string>;
  }) {
    const rewriteUrl = async (rawUrl: string | null): Promise<string | null> => {
      if (!rawUrl) return null;
      const trimmed = rawUrl.trim();
      if (!trimmed || trimmed.startsWith("#")) return rawUrl;
      if (/^(data:|blob:|https?:)/i.test(trimmed)) return rawUrl;
      const { path, fragment } = resolveRelativePath(cssHref, trimmed);
      if (!path) return rawUrl;

      const asset = await this.getAssetDataUri({
        epubPath: path,
        baseHref: cssHref,
        ref: trimmed,
        book,
        dataUriCache,
        warningCache,
      });
      if (!asset) return rawUrl;
      return `${asset.dataUri}${fragment}`;
    };

    const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    const importPattern = /@import\s+(?:url\()?['"]?([^'")]+)['"]?\)?/gi;

    let rewritten = "";
    let lastIndex = 0;
    for (const match of cssText.matchAll(urlPattern)) {
      const [full, quote, url] = match;
      if (match.index === undefined) continue;
      rewritten += cssText.slice(lastIndex, match.index);
      const nextUrl = (await rewriteUrl(url)) || url;
      rewritten += `url(${quote}${nextUrl}${quote})`;
      lastIndex = match.index + full.length;
    }
    rewritten += cssText.slice(lastIndex);

    let importRewritten = "";
    lastIndex = 0;
    for (const match of rewritten.matchAll(importPattern)) {
      const [full, url] = match;
      if (match.index === undefined) continue;
      importRewritten += rewritten.slice(lastIndex, match.index);
      const nextUrl = (await rewriteUrl(url)) || url;
      importRewritten += full.replace(url, nextUrl);
      lastIndex = match.index + full.length;
    }
    importRewritten += rewritten.slice(lastIndex);

    return importRewritten;
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

export class PdfService {
  async htmlToPdfBlob(html: string, title: string) {
    const container = this.createContainer(html);
    document.body.appendChild(container);
    try {
      return await html2pdf()
        .from(container)
        .set({
          margin: [18, 18, 18, 18],
          filename: `${title || "book"}.pdf`,
          image: { type: "jpeg", quality: 0.98 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: "pt", format: "a4", orientation: "portrait" },
          pagebreak: { mode: ["css", "legacy"] },
        })
        .outputPdf("blob");
    } finally {
      container.remove();
    }
  }

  private createContainer(html: string) {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const container = document.createElement("div");
    container.style.position = "fixed";
    container.style.left = "-10000px";
    container.style.top = "0";
    container.style.width = "794px";
    container.style.background = "#fff";

    const styleText = Array.from(parsed.querySelectorAll("style"))
      .map((style) => style.textContent || "")
      .join("\n");
    if (styleText.trim()) {
      const style = document.createElement("style");
      style.textContent = styleText;
      container.appendChild(style);
    }

    const content = document.createElement("div");
    content.innerHTML = parsed.body?.innerHTML || html;
    container.appendChild(content);
    return container;
  }
}

export class FileNameService {
  static baseName(file: File | null) {
    const rawName = file?.name || "book";
    return rawName.replace(/\.epub$/i, "") || "book";
  }
}
