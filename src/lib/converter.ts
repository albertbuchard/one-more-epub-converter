import DOMPurify from "dompurify";
import ePub, { type Book } from "epubjs";
import html2canvas from "html2canvas";
import JSZip from "jszip";
import { jsPDF } from "jspdf";
import { ProgressPublishInput, WeightedProgress } from "./progress";

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

  openBook(arrayBuffer: ArrayBuffer): Book {
    if (!this.ready) {
      throw new Error("EPUB runtime not initialized");
    }
    return ePub(arrayBuffer);
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

const OPF_DIR_CACHE = new WeakMap<Book, string>();
const ZIP_INDEX_CACHE = new WeakMap<Book, Map<string, string>>();

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getOpfDir(book: Book): string {
  const cached = OPF_DIR_CACHE.get(book);
  if (cached !== undefined) return cached;

  const packaging = (book as any)?.packaging ?? (book as any)?.package ?? null;
  const opfPath =
    packaging?.path || packaging?.opfPath || (book as any)?.packaging?.path || (book as any)?.packaging?.opfPath;
  if (typeof opfPath === "string" && opfPath) {
    const normalized = opfPath.replace(/^\/+/, "");
    const idx = normalized.lastIndexOf("/");
    const dir = idx >= 0 ? normalized.slice(0, idx + 1) : "";
    OPF_DIR_CACHE.set(book, dir);
    return dir;
  }

  const cache = book?.archive?.urlCache;
  if (cache && typeof cache === "object") {
    const counts = new Map<string, number>();
    for (const key of Object.keys(cache)) {
      const cleaned = key.replace(/^\/+/, "");
      const [segment] = cleaned.split("/");
      if (!segment) continue;
      counts.set(segment, (counts.get(segment) || 0) + 1);
    }
    let best = "";
    let bestCount = 0;
    for (const [segment, count] of counts) {
      if (count > bestCount) {
        best = segment;
        bestCount = count;
      }
    }
    const dir = best ? `${best}/` : "";
    OPF_DIR_CACHE.set(book, dir);
    return dir;
  }

  OPF_DIR_CACHE.set(book, "");
  return "";
}

function getZipIndex(book: Book): Map<string, string> {
  const cached = ZIP_INDEX_CACHE.get(book);
  if (cached) return cached;

  const idx = new Map<string, string>();
  const zip = (book as any)?.archive?.zip;
  if (zip?.files && typeof zip.files === "object") {
    for (const name of Object.keys(zip.files)) {
      const decoded = safeDecodeURIComponent(name);
      idx.set(name.toLowerCase(), name);
      idx.set(decoded.toLowerCase(), name);
    }
  }

  ZIP_INDEX_CACHE.set(book, idx);
  return idx;
}

function sectionBaseHref(book: Book, sectionHref: string): string {
  const opfDir = getOpfDir(book);
  const clean = (sectionHref || "").replace(/^\/+/, "");
  return `/${opfDir}${clean}`;
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function candidateEpubPaths(book: Book, baseHref: string, ref: string): string[] {
  const opfDir = getOpfDir(book);
  if (ref.startsWith("/")) {
    const noLead = ref.replace(/^\/+/, "");
    const candidates = [
      `/${noLead}`,
      opfDir ? `/${opfDir}${noLead}` : "",
    ].filter(Boolean);

    if (import.meta.env.DEV) {
      console.info("[export-assets] root-relative candidates", {
        ref,
        baseHref,
        opfDir,
        candidates,
      });
    }

    return uniq(candidates);
  }

  const resolved = "/" + resolveRelativePath(baseHref, ref).path;
  const resolvedNoLead = resolved.replace(/^\/+/, "");
  return uniq([resolved, opfDir ? `/${opfDir}${resolvedNoLead}` : ""].filter(Boolean));
}

function stripQueryAndFragment(ref: string) {
  return ref.split("#")[0].split("?")[0];
}

function normalizeLeadingSlash(path: string) {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function looksLikeWindowsPath(ref: string) {
  return /^[a-zA-Z]:\\/.test(ref);
}

function candidateArchiveUrls(
  book: Book,
  baseHref: string,
  rawRef: string,
  blobToOriginal: Map<string, string>
) {
  const ref = (rawRef || "").trim();
  if (!ref || ref.startsWith("#")) return [];
  if (looksLikeWindowsPath(ref)) return [];
  if (/^(?:data:|https?:|mailto:|tel:|sms:)/i.test(ref)) return [];

  if (ref.startsWith("blob:")) {
    const original = blobToOriginal.get(ref);
    if (!original) return [];
    return [normalizeLeadingSlash(stripQueryAndFragment(original))];
  }

  const cleaned = stripQueryAndFragment(ref);
  const baseCandidates = candidateEpubPaths(book, baseHref, cleaned).map((url) => normalizeLeadingSlash(url));
  const opfDir = getOpfDir(book);
  const expanded: string[] = [];

  for (const candidate of baseCandidates) {
    expanded.push(candidate);
    const noLead = candidate.replace(/^\/+/, "");
    if (opfDir && noLead && !noLead.toLowerCase().startsWith(opfDir.toLowerCase())) {
      expanded.push(`/${opfDir}${noLead}`);
    }
  }

  const zipIndex = getZipIndex(book);
  const final: string[] = [];
  for (const candidate of expanded) {
    const key = safeDecodeURIComponent(candidate.replace(/^\/+/, "")).toLowerCase();
    const exact = zipIndex.get(key);
    if (exact) final.push(`/${exact}`);
    final.push(candidate);
  }

  return Array.from(new Set(final));
}

type FetchedAsset = {
  blob: Blob;
  mimeType: string;
  sourcePathHint: string;
};

type FetchedDataUri = {
  dataUri: string;
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

function invertArchiveUrlCache(book: Book) {
  const out = new Map<string, string>();
  const cache = book?.archive?.urlCache;
  if (!cache || typeof cache !== "object") return out;
  for (const [original, blobUrl] of Object.entries(cache)) {
    if (typeof blobUrl === "string") out.set(blobUrl, original);
  }
  return out;
}

async function fetchAssetBlob(
  book: Book,
  baseHref: string,
  rawRef: string,
  blobToOriginal: Map<string, string>
): Promise<FetchedAsset | null> {
  const archive = (book as any)?.archive;
  if (!archive?.getBlob) return null;

  const candidates = candidateArchiveUrls(book, baseHref, rawRef, blobToOriginal);
  if (!candidates.length) return null;

  for (const url of candidates) {
    try {
      const blob = await archive.getBlob(url);
      if (!blob) continue;
      const mimeType = blob.type || guessMimeFromPath(url);
      return { blob, mimeType, sourcePathHint: url };
    } catch {
      // try next candidate
    }
  }

  return null;
}

async function fetchAssetDataUri(
  book: Book,
  baseHref: string,
  rawRef: string,
  blobToOriginal: Map<string, string>
): Promise<FetchedDataUri | null> {
  const archive = (book as any)?.archive;
  if (!archive?.getBase64) return null;

  const candidates = candidateArchiveUrls(book, baseHref, rawRef, blobToOriginal);
  if (!candidates.length) return null;

  for (const url of candidates) {
    try {
      const dataUri = await archive.getBase64(url);
      if (!dataUri) continue;
      const mimeType = dataUri.slice(5).split(";", 1)[0] || guessMimeFromPath(url);
      return { dataUri, mimeType, sourcePathHint: url };
    } catch {
      // try next candidate
    }
  }

  return null;
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
  book: Book,
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
        if (mode === "inline") {
          const fetched = await fetchAssetDataUri(book, baseHref, srcAttr, blobToOriginal);
          if (!fetched) {
            stats.skipped += 1;
          } else {
            const dataUri = fetched.dataUri;
            if (el.hasAttribute("src")) el.setAttribute("src", dataUri);
            else if (el.hasAttribute("href")) el.setAttribute("href", dataUri);
            else el.setAttribute("xlink:href", dataUri);
            stats.inlined += 1;
          }
        } else {
          const fetched = await fetchAssetBlob(book, baseHref, srcAttr, blobToOriginal);
          if (!fetched) {
            stats.skipped += 1;
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
          if (mode === "inline") {
            const fetched = await fetchAssetDataUri(book, baseHref, part.url, blobToOriginal);
            if (!fetched) {
              rewritten.push(part);
              continue;
            }
            rewritten.push({ url: fetched.dataUri, desc: part.desc });
          } else {
            const fetched = await fetchAssetBlob(book, baseHref, part.url, blobToOriginal);
            if (!fetched) {
              rewritten.push(part);
              continue;
            }
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
    const book = this.runtime.openBook(arrayBuffer);

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

  private async *iterateSpine(book: Book) {
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

  async toHtml(book: Book) {
    const { html } = await this.buildHtmlForExport(book, "inline");
    return html;
  }

  async toTxt(book: Book) {
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

  async toHtmlWithAssets(book: Book, options: { mode: HtmlExportMode }) {
    const mode = options.mode === "inline" ? "inline" : "zip";
    const { html, assets } = await this.buildHtmlForExport(book, mode);

    if (mode === "inline") {
      return { html } as const;
    }

    const zipBlob = await buildHtmlZip(html, assets);
    return { zipBlob, htmlPreview: html } as const;
  }

  private async buildHtmlForExport(book: Book, mode: AssetMode) {
    const sections: string[] = [];
    const dataUriCache = new Map<string, Promise<DataUriResult | null>>();
    const cssCache = new Map<string, Promise<string | null>>();
    const warningCache = new Set<string>();
    const stats: InlineStats = { inlined: 0, skipped: 0 };
    const mergedAssets = new Map<string, Blob>();

    for await (const { html, href } of this.iterateSpine(book)) {
      const safeHtml = this.sanitizer.sanitize(html);
      const baseHref = sectionBaseHref(book, href);
      const cssInlined = await this.inlineStylesheetsInHtml({
        html: safeHtml,
        baseHref,
        book,
        dataUriCache,
        cssCache,
        warningCache,
      });
      const { html: rewritten, assets, stats: rewriteStats } = await rewriteHtmlAssetsForExport(
        book,
        baseHref,
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
    book: Book;
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
    book: Book;
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
    book: Book;
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

  private async fetchFromEpubArchive(book: Book, path: string): Promise<Blob> {
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
    book: Book;
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
    book: Book;
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
    book: Book;
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
  openPopup(title: string) {
    const popup = window.open("", "_blank");
    if (!popup) {
      throw new Error("Popup blocked. Allow popups to open printable view.");
    }
    popup.document.open();
    popup.document.write(
      "<!doctype html><title>Loading printable view…</title><style>body{font-family:system-ui;margin:32px;color:#111}</style><p>Preparing printable view…</p>"
    );
    popup.document.close();
    popup.document.title = title || "EPUB";
    return popup;
  }

  renderPrintable(popup: Window, html: string, title: string) {
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    popup.document.title = title || "EPUB";
    setTimeout(() => popup.print(), 250);
  }
}

export class PdfService {
  async htmlToPdfBlob(html: string, opts?: { filename?: string; progress?: (event: ProgressPublishInput) => void }) {
    const { title, styles, bodyHtml } = extractPrintableBody(html);
    const marginMm = 18;
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    const pageWmm = pdf.internal.pageSize.getWidth();
    const pageHmm = pdf.internal.pageSize.getHeight();
    const contentWmm = pageWmm - 2 * marginMm;
    const contentHmm = pageHmm - 2 * marginMm;

    const hostWidthPx = 794;
    const viewportHeightPx = Math.round((contentHmm * hostWidthPx) / contentWmm);

    const viewport = document.createElement("div");
    viewport.setAttribute("data-pdf-viewport", "true");
    viewport.style.position = "fixed";
    viewport.style.left = "-100000px";
    viewport.style.top = "0";
    viewport.style.width = `${hostWidthPx}px`;
    viewport.style.height = `${viewportHeightPx}px`;
    viewport.style.overflow = "hidden";
    viewport.style.background = "#ffffff";
    viewport.style.pointerEvents = "none";
    viewport.style.zIndex = "2147483647";

    const content = document.createElement("div");
    content.setAttribute("data-pdf-content", "true");
    content.style.width = `${hostWidthPx}px`;
    content.style.background = "#ffffff";
    content.style.color = "#111";
    content.style.transform = "translateY(0px)";
    content.style.transformOrigin = "top left";

    content.innerHTML = `<style>${styles}</style><div>${bodyHtml}</div>`;

    viewport.appendChild(content);
    document.body.appendChild(viewport);

    const progress = opts?.progress;
    const weighted = new WeightedProgress([
      { phase: "prepare", weight: 0.05 },
      { phase: "measure", weight: 0.05 },
      { phase: "capture", weight: 0.8 },
      { phase: "assemble", weight: 0.07 },
      { phase: "finalize", weight: 0.03 },
    ]);

    const publish = (event: Omit<ProgressPublishInput, "percent"> & { percent: number }) => {
      if (!progress) return;
      progress(event);
    };

    try {
      publish({
        running: true,
        phase: "prepare",
        percent: weighted.percentFor("prepare", 0),
        stage: "Preparing PDF…",
        detail: "Setting up render surface…",
      });
      await nextFrame();
      await waitForFonts(document);
      await waitForImages(content);
      await nextFrame();

      const filename =
        opts?.filename ||
        `${title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120) || "document"}.pdf`;

      const totalHeightPx = content.scrollHeight;
      const pages = Math.max(1, Math.ceil(totalHeightPx / viewportHeightPx));

      publish({
        running: true,
        phase: "measure",
        percent: weighted.percentFor("measure", 1),
        stage: "Measuring content…",
        detail: `Found ${pages} ${pages === 1 ? "page" : "pages"}.`,
        unit: { label: "pages", current: 0, total: pages },
      });
      await nextFrame();

      console.info(
        "[pdf] totalHeightPx",
        totalHeightPx,
        "viewportHeightPx",
        viewportHeightPx,
        "pages",
        pages
      );

      const scale = 2;
      const win = document.defaultView ?? window;

      for (let i = 0; i < pages; i += 1) {
        const y = i * viewportHeightPx;
        const sliceHeightPx = Math.min(viewportHeightPx, totalHeightPx - y);

        const canvas = await html2canvas(content, {
          scale,
          useCORS: true,
          backgroundColor: "#ffffff",
          width: hostWidthPx,
          height: sliceHeightPx,
          x: 0,
          y,
          windowWidth: hostWidthPx,
          windowHeight: sliceHeightPx,
          scrollX: -win.scrollX,
          scrollY: -win.scrollY,
          logging: false,
        });

        const imgData = canvas.toDataURL("image/jpeg", 0.95);
        const imgHmm = (sliceHeightPx / viewportHeightPx) * contentHmm;

        if (i > 0) pdf.addPage();
        pdf.addImage(imgData, "JPEG", marginMm, marginMm, contentWmm, imgHmm, undefined, "FAST");

        canvas.width = 0;
        canvas.height = 0;
        const current = i + 1;
        publish({
          running: true,
          phase: "capture",
          percent: weighted.percentFor("capture", current / pages),
          stage: "Exporting PDF…",
          detail: `Capturing page ${current}/${pages}`,
          unit: { label: "pages", current, total: pages },
        });
        await nextFrame();
      }

      publish({
        running: true,
        phase: "assemble",
        percent: weighted.percentFor("assemble", 1),
        stage: "Assembling PDF…",
        detail: "Encoding pages…",
        unit: { label: "pages", current: pages, total: pages },
      });

      const blob = pdf.output("blob");
      if (!(blob instanceof Blob)) {
        throw new Error("PDF generation returned no data.");
      }

      publish({
        running: true,
        phase: "finalize",
        percent: weighted.percentFor("finalize", 1),
        stage: "Finalizing PDF…",
        detail: "Wrapping up download…",
        unit: { label: "pages", current: pages, total: pages },
      });

      if (opts?.filename) {
        Object.defineProperty(blob, "name", { value: filename });
      }

      publish({
        running: false,
        phase: "done",
        percent: 100,
        stage: "PDF ready.",
        detail: `Captured ${pages}/${pages} pages.`,
        unit: { label: "pages", current: pages, total: pages },
      });

      return blob;
    } catch (error) {
      publish({
        running: false,
        phase: "error",
        percent: weighted.percentFor("finalize", 1),
        stage: `PDF export failed.`,
        detail: (error as Error)?.message || String(error),
      });
      throw error;
    } finally {
      viewport.remove();
    }
  }
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function waitForImages(root: HTMLElement, timeoutMs = 20000) {
  const images = Array.from(root.querySelectorAll("img"));
  if (!images.length) return;

  const timeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout waiting for ${images.length} images`)), timeoutMs)
  );

  const jobs = images.map(async (img) => {
    if (img.complete && img.naturalWidth > 0) return;
    try {
      if (typeof img.decode === "function") {
        await img.decode();
        return;
      }
      await new Promise<void>((resolve, reject) => {
        img.addEventListener("load", () => resolve(), { once: true });
        img.addEventListener("error", () => reject(new Error("Image failed to load")), { once: true });
      });
    } catch {
      await new Promise<void>((resolve) => {
        if (img.complete) return resolve();
        img.addEventListener("load", () => resolve(), { once: true });
        img.addEventListener("error", () => resolve(), { once: true });
      });
    }
  });

  await Promise.race([Promise.all(jobs).then(() => undefined), timeout]);
}

async function waitForFonts(doc: Document, timeoutMs = 20000) {
  const anyDoc = doc as Document & { fonts?: { ready?: Promise<unknown> } };
  if (!anyDoc.fonts?.ready) return;

  const timeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error("Timeout waiting for fonts")), timeoutMs)
  );
  await Promise.race([anyDoc.fonts.ready.then(() => undefined), timeout]);
}

function extractPrintableBody(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const styles = Array.from(doc.querySelectorAll("style"))
    .map((style) => style.textContent || "")
    .join("\n");
  const title = doc.title || "document";
  const bodyHtml = doc.body?.innerHTML || html;

  return { title, styles, bodyHtml };
}

export class FileNameService {
  static baseName(file: File | null) {
    const rawName = file?.name || "book";
    return rawName.replace(/\.epub$/i, "") || "book";
  }
}
