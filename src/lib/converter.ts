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
    request?: (path: string, type: string) => Promise<Blob>;
    urlCache?: Record<string, string>;
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
const SKIP_URI_RE = /^(?:data:|https?:|mailto:|tel:|sms:)/i;
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
};

function isImageMimeType(mimeType: string) {
  return IMAGE_MIME_PATTERN.test(mimeType);
}

function isSkippableUri(value: string) {
  const trimmed = value.trim();
  return !trimmed || trimmed.startsWith("#") || SKIP_URI_RE.test(trimmed);
}

function guessMimeFromPath(path: string) {
  const clean = path.split("?")[0].split("#")[0];
  const ext = clean.includes(".") ? clean.split(".").pop()!.toLowerCase() : "";
  return EXT_MIME[ext] || "application/octet-stream";
}

function resolveRelativePath(baseHref: string, ref: string): { path: string; fragment: string } {
  const [refPath, fragment = ""] = ref.split("#", 2);
  const baseDir = baseHref.includes("/") ? baseHref.slice(0, baseHref.lastIndexOf("/") + 1) : "";
  const url = new URL(refPath, `https://epub.local/${baseDir}`);
  const path = url.pathname.replace(/^\/+/, "");
  return { path, fragment: fragment ? `#${fragment}` : "" };
}

type FetchedAsset = {
  blob: Blob;
  mimeType: string;
  sourcePathHint: string;
};

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

function extFromMime(mimeType: string) {
  const normalized = (mimeType || "").split(";")[0].trim().toLowerCase();
  return MIME_TO_EXT[normalized] || "bin";
}

function invertArchiveUrlCache(book: EpubBook) {
  const out = new Map<string, string>();
  const cache = book?.archive?.urlCache;
  if (!cache || typeof cache !== "object") return out;
  for (const [original, blobUrl] of Object.entries(cache)) {
    if (typeof blobUrl === "string") out.set(blobUrl, original);
  }
  return out;
}

async function fetchAssetBlob(
  book: EpubBook,
  baseHref: string,
  rawRef: string,
  blobToOriginal: Map<string, string>
): Promise<FetchedAsset | null> {
  const ref = (rawRef || "").trim();
  if (!ref || ref.startsWith("#")) return null;

  if (ref.startsWith("data:")) return null;

  if (/^https?:/i.test(ref) || /^mailto:/i.test(ref) || /^tel:/i.test(ref) || /^sms:/i.test(ref)) {
    return null;
  }

  if (ref.startsWith("blob:")) {
    const original = blobToOriginal.get(ref);
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`Failed to fetch blob asset (${res.status}): ${ref}`);
    const blob = await res.blob();
    const mimeType = blob.type || (original ? guessMimeFromPath(original) : "application/octet-stream");
    return {
      blob,
      mimeType,
      sourcePathHint: original || `blob-asset.${extFromMime(mimeType)}`,
    };
  }

  let epubPath = ref;
  if (!epubPath.startsWith("/")) {
    epubPath = "/" + resolveRelativePath(baseHref, epubPath).path;
  }

  const archive = book?.archive;
  if (archive?.request) {
    const blob = await archive.request(epubPath, "blob");
    if (!(blob instanceof Blob)) {
      throw new Error(`Archive request did not return a Blob for ${epubPath}`);
    }

    const mimeType = blob.type || guessMimeFromPath(epubPath);
    return { blob, mimeType, sourcePathHint: epubPath.replace(/^\/+/, "") };
  }

  if (!archive?.createUrl) {
    throw new Error("EPUB archive is not available (book.archive.request missing).");
  }

  const blobUrl = archive.createUrl(epubPath.replace(/^\/+/, ""));
  const response = await fetch(blobUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch EPUB asset: ${epubPath} (${response.status})`);
  }
  const blob = await response.blob();

  const mimeType = blob.type || guessMimeFromPath(epubPath);
  return { blob, mimeType, sourcePathHint: epubPath.replace(/^\/+/, "") };
}

function sanitizeZipPath(path: string) {
  const cleaned = path
    .replace(/^\/+/, "")
    .split("/")
    .filter((p) => p && p !== "." && p !== "..")
    .join("/");
  return cleaned.replace(/[<>:"|?*\u0000-\u001F]/g, "_");
}

async function blobToDataUri(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read blob as data URL"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

type AssetMode = "inline" | "zip";

type RewriteResult = {
  html: string;
  assets: Map<string, Blob>;
  stats: { inlined: number; skipped: number };
};

function parseSrcset(value: string) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [url, ...rest] = part.split(/\s+/);
      return { url, desc: rest.join(" ") };
    });
}

function serializeSrcset(entries: Array<{ url: string; desc: string }>) {
  return entries.map((e) => (e.desc ? `${e.url} ${e.desc}` : e.url)).join(", ");
}

async function rewriteHtmlAssetsForExport(
  book: EpubBook,
  baseHref: string,
  htmlFragment: string,
  mode: AssetMode
): Promise<RewriteResult> {
  const blobToOriginal = invertArchiveUrlCache(book);
  const assets = new Map<string, Blob>();
  const usedZipPaths = new Set<string>();
  const stats = { inlined: 0, skipped: 0 };

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="__root__">${htmlFragment}</div>`, "text/html");
  const root = doc.getElementById("__root__");
  if (!root) return { html: htmlFragment, assets, stats };

  const elements = root.querySelectorAll(
    "img[src], image[href], image[xlink\\:href], source[src], source[srcset]"
  );

  for (const el of Array.from(elements)) {
    const srcAttr = el.getAttribute("src") || el.getAttribute("href") || el.getAttribute("xlink:href");

    if (srcAttr) {
      try {
        const fetched = await fetchAssetBlob(book, baseHref, srcAttr, blobToOriginal);
        if (!fetched) {
          stats.skipped += 1;
        } else if (mode === "inline") {
          const dataUri = await blobToDataUri(fetched.blob);
          if (el.hasAttribute("src")) el.setAttribute("src", dataUri);
          else if (el.hasAttribute("href")) el.setAttribute("href", dataUri);
          else el.setAttribute("xlink:href", dataUri);
          stats.inlined += 1;
        } else {
          const safeHint = sanitizeZipPath(fetched.sourcePathHint);
          const ext = extFromMime(fetched.mimeType);
          const baseName = safeHint && safeHint.includes(".") ? safeHint : `${safeHint || "asset"}.${ext}`;
          let zipPath = `assets/${baseName}`;
          zipPath = sanitizeZipPath(zipPath);

          if (usedZipPaths.has(zipPath)) {
            const dot = zipPath.lastIndexOf(".");
            const stem = dot >= 0 ? zipPath.slice(0, dot) : zipPath;
            const suffix = dot >= 0 ? zipPath.slice(dot) : "";
            let i = 2;
            while (usedZipPaths.has(`${stem}-${i}${suffix}`)) i += 1;
            zipPath = `${stem}-${i}${suffix}`;
          }
          usedZipPaths.add(zipPath);

          assets.set(zipPath, fetched.blob);

          const rel = zipPath;
          if (el.hasAttribute("src")) el.setAttribute("src", rel);
          else if (el.hasAttribute("href")) el.setAttribute("href", rel);
          else el.setAttribute("xlink:href", rel);
          stats.inlined += 1;
        }
      } catch (error) {
        console.warn("[export-assets] failed:", error);
        stats.skipped += 1;
      }
    }

    const srcset = el.getAttribute("srcset");
    if (srcset) {
      const parts = parseSrcset(srcset);
      const rewritten: Array<{ url: string; desc: string }> = [];

      for (const part of parts) {
        try {
          const fetched = await fetchAssetBlob(book, baseHref, part.url, blobToOriginal);
          if (!fetched) {
            rewritten.push(part);
            continue;
          }

          if (mode === "inline") {
            const dataUri = await blobToDataUri(fetched.blob);
            rewritten.push({ url: dataUri, desc: part.desc });
          } else {
            const safeHint = sanitizeZipPath(fetched.sourcePathHint);
            const ext = extFromMime(fetched.mimeType);
            const baseName = safeHint && safeHint.includes(".") ? safeHint : `${safeHint || "asset"}.${ext}`;
            let zipPath = sanitizeZipPath(`assets/${baseName}`);

            if (usedZipPaths.has(zipPath)) {
              const dot = zipPath.lastIndexOf(".");
              const stem = dot >= 0 ? zipPath.slice(0, dot) : zipPath;
              const suffix = dot >= 0 ? zipPath.slice(dot) : "";
              let i = 2;
              while (usedZipPaths.has(`${stem}-${i}${suffix}`)) i += 1;
              zipPath = `${stem}-${i}${suffix}`;
            }
            usedZipPaths.add(zipPath);

            assets.set(zipPath, fetched.blob);
            rewritten.push({ url: zipPath, desc: part.desc });
          }
        } catch (error) {
          console.warn("[export-srcset] failed:", error);
          rewritten.push(part);
        }
      }

      el.setAttribute("srcset", serializeSrcset(rewritten));
    }
  }

  return { html: root.innerHTML, assets, stats };
}

async function buildHtmlZip(indexHtml: string, assets: Map<string, Blob>) {
  const zip = new JSZip();

  zip.file("index.html", indexHtml);

  for (const [path, blob] of assets) {
    zip.file(path, blob, { binary: true });
  }

  return await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
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

        const href = section?.href || "";

        yield { html: html || "", href };
      } finally {
        // Important for big books: frees memory
        section?.unload?.();
      }
    }
  }

  async toHtml(book: EpubBook) {
    const { html } = await this.buildHtmlForExport(book, "inline");
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
    const mode = options.mode === "inline" ? "inline" : "zip";
    const { html, assets } = await this.buildHtmlForExport(book, mode);

    if (mode === "inline") {
      return { html } as const;
    }

    const zipBlob = await buildHtmlZip(html, assets);
    return { zipBlob, htmlPreview: html } as const;
  }

  private async buildHtmlForExport(book: EpubBook, mode: AssetMode) {
    const sections: string[] = [];
    const dataUriCache = new Map<string, Promise<DataUriResult | null>>();
    const cssCache = new Map<string, Promise<string | null>>();
    const warningCache = new Set<string>();
    const stats: InlineStats = { inlined: 0, skipped: 0 };
    const mergedAssets = new Map<string, Blob>();

    for await (const { html, href } of this.iterateSpine(book)) {
      const safeHtml = this.sanitizer.sanitize(html);
      const cssInlined = await this.inlineStylesheetsInHtml({
        html: safeHtml,
        baseHref: href,
        book,
        dataUriCache,
        cssCache,
        warningCache,
      });
      const { html: rewritten, assets, stats: rewriteStats } = await rewriteHtmlAssetsForExport(
        book,
        href,
        cssInlined,
        mode
      );
      for (const [path, blob] of assets) {
        mergedAssets.set(path, blob);
      }
      stats.inlined += rewriteStats.inlined;
      stats.skipped += rewriteStats.skipped;
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

    return { html, stats, assets: mergedAssets } as const;
  }

  private async inlineStylesheetsInHtml({
    html,
    baseHref,
    book,
    dataUriCache,
    cssCache,
    warningCache,
  }: {
    html: string;
    baseHref: string;
    book: EpubBook;
    dataUriCache: Map<string, Promise<DataUriResult | null>>;
    cssCache: Map<string, Promise<string | null>>;
    warningCache: Set<string>;
  }) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const root = doc.body ?? doc.documentElement;

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

  private async blobToDataUri(blob: Blob, mimeHint?: string): Promise<string> {
    const typed =
      mimeHint && blob.type !== mimeHint ? new Blob([await blob.arrayBuffer()], { type: mimeHint }) : blob;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob"));
      reader.readAsDataURL(typed);
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
    const dataUri = await this.blobToDataUri(asset.blob, asset.mimeType);
    return { dataUri, mimeType: asset.mimeType };
  }

  private async fetchFromEpubArchive(book: EpubBook, path: string): Promise<Blob> {
    if (!book.archive?.createUrl) {
      throw new Error("EPUB archive is not available (book.archive.createUrl missing).");
    }

    let normalized = typeof path === "string" ? path : String(path);
    normalized = normalized.replace(/^\/+/, "");

    try {
      normalized = decodeURIComponent(normalized);
    } catch {
      // ignore
    }

    const blobUrl = book.archive.createUrl(normalized);
    const response = await fetch(blobUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch EPUB asset: ${normalized} (${response.status})`);
    }
    return await response.blob();
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
    try {
      const blob = await this.fetchFromEpubArchive(book, epubPath);
      const inferred = blob.type || guessMimeFromPath(epubPath);
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
    if (isSkippableUri(trimmed)) {
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
      if (typeof rawUrl !== "string") return null;
      const trimmed = rawUrl.trim();
      if (trimmed.startsWith("blob:")) return rawUrl;
      if (isSkippableUri(trimmed)) return rawUrl;
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
