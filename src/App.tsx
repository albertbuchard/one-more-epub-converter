import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FileRejection, useDropzone } from "react-dropzone";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileDown,
  FileText,
  Loader2,
  Moon,
  Printer,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import { toast, Toaster } from "sonner";
import JSZip from "jszip";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Progress } from "./components/ui/progress";
import { Separator } from "./components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Textarea } from "./components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import {
  DownloadService,
  EpubConverter,
  EpubRuntime,
  FileNameService,
  HtmlSanitizer,
  PdfService,
  PrintService,
} from "./lib/converter";
import { createProgressStore, createRafThrottledPublisher, ProgressPublishInput } from "./lib/progress";
import { cn } from "./lib/utils";

type ThemeMode = "system" | "light" | "dark";
type HtmlExportMode = "zip" | "inline";

const formatFileSize = (bytes: number) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
};

const systemTheme = () => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

const applyTheme = (mode: ThemeMode) => {
  const root = document.documentElement;
  const target = mode === "system" ? systemTheme() : mode;
  root.classList.toggle("dark", target === "dark");
};

const CONTAINER_RE = /(^|\/)meta-inf\/container\.xml$/i;
const MIMETYPE_RE = /(^|\/)mimetype$/i;

const pickBestEpubEntry = (entries: string[]) => {
  if (entries.length === 1) return entries[0];
  return [...entries].sort((a, b) => {
    const depthA = a.split("/").length;
    const depthB = b.split("/").length;
    if (depthA !== depthB) return depthA - depthB;
    return a.length - b.length;
  })[0];
};

async function ensureRootedEpubZip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(buf);

  const names = Object.values(zip.files)
    .filter((f) => !f.dir)
    .map((f) => f.name);

  const containerPath = names.find((n) => CONTAINER_RE.test(n));
  if (!containerPath) {
    const sample = names.slice(0, 30).join(", ");
    throw new Error(
      `ZIP does not contain META-INF/container.xml (case-insensitive). First entries: ${sample}`
    );
  }

  if (containerPath === "META-INF/container.xml") {
    return buf;
  }

  const idx = containerPath.toLowerCase().lastIndexOf("meta-inf/container.xml");
  const prefix = containerPath.slice(0, idx);

  const out = new JSZip();

  const mimetypePath = names.find((n) => MIMETYPE_RE.test(n) && n.startsWith(prefix));
  if (mimetypePath) {
    const mimetype = await zip.file(mimetypePath)!.async("string");
    out.file("mimetype", mimetype, { compression: "STORE" });
  } else {
    out.file("mimetype", "application/epub+zip", { compression: "STORE" });
  }

  const underPrefix = names.filter((n) => n.startsWith(prefix) && n !== mimetypePath);
  for (const name of underPrefix) {
    const entry = zip.file(name);
    if (!entry) continue;

    let newName = name.slice(prefix.length);
    if (newName.startsWith("/")) newName = newName.slice(1);

    if (CONTAINER_RE.test(newName)) {
      newName = "META-INF/container.xml";
    }

    const content = await entry.async("arraybuffer");
    out.file(newName, content, { compression: "DEFLATE" });
  }

  return await out.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

async function normalizeToEpubArrayBuffer(
  file: File
): Promise<{ buf: ArrayBuffer; displayName: string }> {
  const lower = file.name.toLowerCase();
  const raw = await file.arrayBuffer();

  if (lower.endsWith(".zip")) {
    const zip = await JSZip.loadAsync(raw);

    const entries = Object.values(zip.files)
      .filter((f) => !f.dir)
      .map((f) => f.name);

    const epubEntries = entries.filter((n) => n.toLowerCase().endsWith(".epub"));
    if (epubEntries.length >= 1) {
      const best = pickBestEpubEntry(epubEntries);
      const entry = zip.file(best);
      if (!entry) throw new Error(`Could not read ${best} from ZIP.`);
      const inner = await entry.async("arraybuffer");
      const fixed = await ensureRootedEpubZip(inner);
      return { buf: fixed, displayName: best.split("/").pop() || best };
    }

    const fixed = await ensureRootedEpubZip(raw);
    return { buf: fixed, displayName: file.name.replace(/\.zip$/i, ".epub") };
  }

  if (lower.endsWith(".epub")) {
    const fixed = await ensureRootedEpubZip(raw);
    return { buf: fixed, displayName: file.name };
  }

  throw new Error("Unsupported file type. Please provide an .epub or a .zip containing an .epub.");
}

function App() {
  const runtimeRef = useRef(new EpubRuntime());
  const sanitizerRef = useRef(new HtmlSanitizer());
  const converterRef = useRef(new EpubConverter(runtimeRef.current, sanitizerRef.current));
  const downloadRef = useRef(new DownloadService());
  const pdfRef = useRef(new PdfService());
  const printRef = useRef(new PrintService());
  const progressStoreRef = useRef(
    createProgressStore({
      seq: 0,
      running: false,
      phase: "idle",
      percent: 0,
      stage: "Ready. Choose an .epub or .zip file.",
      timestampMs: Date.now(),
    })
  );
  const progressPublisherRef = useRef(createRafThrottledPublisher(progressStoreRef.current));

  const publishProgress = useCallback((update: ProgressPublishInput) => {
    progressPublisherRef.current(update);
  }, []);

  const progressSnapshot = useSyncExternalStore(
    progressStoreRef.current.subscribe,
    progressStoreRef.current.getSnapshot,
    progressStoreRef.current.getSnapshot
  );

  const [theme, setTheme] = useState<ThemeMode>("system");
  const [file, setFile] = useState<File | null>(null);
  const [book, setBook] = useState<Awaited<ReturnType<EpubConverter["loadBook"]>> | null>(null);
  const [lastHtml, setLastHtml] = useState<string>("");
  const [lastTxt, setLastTxt] = useState<string>("");
  const [outputTab, setOutputTab] = useState("preview");
  const [monospace, setMonospace] = useState(true);
  const [htmlExportMode, setHtmlExportMode] = useState<HtmlExportMode>("inline");
  const [previewInIframe, setPreviewInIframe] = useState(true);
  const [iframeSrc, setIframeSrc] = useState<string>("");

  useEffect(() => {
    const stored = window.localStorage.getItem("theme") as ThemeMode | null;
    const initialTheme = stored || "system";
    setTheme(initialTheme);
    applyTheme(initialTheme);
  }, []);

  useEffect(() => {
    applyTheme(theme);
    window.localStorage.setItem("theme", theme);
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [theme]);

  useEffect(() => {
    const init = async () => {
      publishProgress({ stage: "Loading EPUB runtime…", percent: 12, running: true, phase: "prepare" });
      try {
        await runtimeRef.current.init();
        publishProgress({
          stage: "Ready. Choose an .epub or .zip file.",
          percent: 100,
          running: false,
          phase: "done",
        });
      } catch (error) {
        console.error(error);
        publishProgress({
          stage: `Failed to load runtime: ${(error as Error)?.message || error}`,
          percent: 0,
          running: false,
          phase: "error",
        });
        toast.error("Failed to load EPUB runtime.");
      }
    };

    init();
  }, [publishProgress]);

  const resetState = useCallback(() => {
    setFile(null);
    setBook(null);
    setLastHtml("");
    setLastTxt("");
    setOutputTab("preview");
    setIframeSrc("");
    publishProgress({
      stage: "Cleared. Choose an .epub or .zip file.",
      percent: 0,
      running: false,
      phase: "idle",
    });
  }, [publishProgress]);

  const handleFile = useCallback(async (nextFile: File) => {
    setLastHtml("");
    setLastTxt("");
    setOutputTab("preview");
    publishProgress({
      stage: `Reading ${nextFile.name}…`,
      percent: 25,
      running: true,
      phase: "prepare",
    });
    try {
      const { buf, displayName } = await normalizeToEpubArrayBuffer(nextFile);
      const displayFile = new File([buf], displayName, { type: "application/epub+zip" });
      setFile(displayFile);
      const loadedBook = await converterRef.current.loadBook(buf);
      setBook(loadedBook);
      publishProgress({
        stage: `Loaded ${displayName}. Choose TXT, HTML, or PDF.`,
        percent: 100,
        running: false,
        phase: "done",
      });
      toast.success("EPUB loaded successfully.");
    } catch (error) {
      console.error(error);
      publishProgress({
        stage: `Error: ${(error as Error)?.message || error}`,
        percent: 0,
        running: false,
        phase: "error",
      });
      toast.error("Failed to load the EPUB file.");
    }
  }, [publishProgress]);

  const onDrop = useCallback(
    (acceptedFiles: File[], fileRejections: FileRejection[]) => {
      const nextFile = acceptedFiles[0];
      if (nextFile) {
        void handleFile(nextFile);
      }
    },
    [handleFile]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "application/epub+zip": [".epub", ".epub.zip"],
      "application/zip": [".zip"],
    },
    multiple: false,
  });

  const canRun = Boolean(book) && !progressSnapshot.running;

  const baseName = useMemo(() => FileNameService.baseName(file), [file]);

  const convertTxt = useCallback(async () => {
    if (!book) return;
    publishProgress({ stage: "Converting to TXT…", percent: 55, running: true, phase: "prepare" });
    try {
      const text = await converterRef.current.toTxt(book);
      setLastTxt(text);
      setOutputTab("preview");
      publishProgress({ stage: "TXT ready. Downloading…", percent: 90, running: true, phase: "finalize" });
      downloadRef.current.downloadBlob(
        new Blob([text], { type: "text/plain;charset=utf-8" }),
        `${baseName}.txt`
      );
      publishProgress({ stage: "Done.", percent: 100, running: false, phase: "done" });
      toast.success("TXT generated and downloaded.");
    } catch (error) {
      console.error(error);
      publishProgress({
        stage: `Error: ${(error as Error)?.message || error}`,
        percent: 0,
        running: false,
        phase: "error",
      });
      toast.error("TXT conversion failed.");
    }
  }, [baseName, book, publishProgress]);

  const buildHtml = useCallback(async () => {
    if (!book) return "";
    publishProgress({ stage: "Converting to HTML…", percent: 60, running: true, phase: "prepare" });
    try {
      const result = await converterRef.current.toHtmlWithAssets(book, { mode: "inline" });
      const html = result.html;
      setLastHtml(html);
      publishProgress({ stage: "HTML ready.", percent: 100, running: false, phase: "done" });
      toast.success("HTML generated.");
      return html;
    } catch (error) {
      console.error(error);
      publishProgress({
        stage: `Error: ${(error as Error)?.message || error}`,
        percent: 0,
        running: false,
        phase: "error",
      });
      toast.error("HTML conversion failed.");
      return "";
    }
  }, [book, publishProgress]);

  const downloadHtml = useCallback(async () => {
    if (!book) return;
    publishProgress({ stage: "Preparing HTML export…", percent: 65, running: true, phase: "prepare" });
    try {
      if (htmlExportMode === "inline") {
        const html = lastHtml || (await buildHtml());
        if (!html) return;
        downloadRef.current.downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), `${baseName}.html`);
        toast.success("Self-contained HTML downloaded.");
        return;
      }

      const result = await converterRef.current.toHtmlWithAssets(book, { mode: "zip" });
      downloadRef.current.downloadBlob(
        result.zipBlob,
        `${baseName}-html.zip`
      );
      if (result.htmlPreview) {
        setLastHtml(result.htmlPreview);
      }
      toast.success("HTML ZIP downloaded.");
    } catch (error) {
      console.error(error);
      toast.error("HTML export failed.");
    } finally {
      publishProgress({ stage: "Done.", percent: 100, running: false, phase: "done" });
    }
  }, [baseName, book, buildHtml, htmlExportMode, lastHtml, publishProgress]);

  const openPrintable = useCallback(async () => {
    if (!book) return;
    publishProgress({ stage: "Building printable view…", percent: 70, running: true, phase: "prepare" });
    const html = lastHtml || (await buildHtml());
    if (!html) return;
    try {
      publishProgress({ stage: "Opening printable view…", percent: 95, running: true, phase: "finalize" });
      printRef.current.openPrintable(html, baseName);
      publishProgress({
        stage: "Printable view opened. Use Print → Save as PDF.",
        percent: 100,
        running: false,
        phase: "done",
      });
      toast.success("Printable view opened.");
    } catch (error) {
      console.error(error);
      publishProgress({
        stage: `Error: ${(error as Error)?.message || error}`,
        percent: 0,
        running: false,
        phase: "error",
      });
      toast.error("Failed to open printable view.");
    }
  }, [baseName, book, buildHtml, lastHtml, publishProgress]);

  const downloadPdf = useCallback(async () => {
    if (!book) return;
    publishProgress({
      stage: "Building printable PDF…",
      percent: 72,
      running: true,
      phase: "prepare",
      detail: "Preparing layout…",
    });
    const html = lastHtml || (await buildHtml());
    if (!html) return;
    try {
      const blob = await pdfRef.current.htmlToPdfBlob(html, {
        filename: `${baseName}.pdf`,
        progress: publishProgress,
      });
      downloadRef.current.downloadBlob(blob, `${baseName}.pdf`);
      publishProgress({ stage: "Done.", percent: 100, running: false, phase: "done" });
      toast.success("PDF generated and downloaded.");
    } catch (error) {
      console.error(error);
      publishProgress({
        stage: `Error: ${(error as Error)?.message || error}`,
        percent: 0,
        running: false,
        phase: "error",
      });
      toast.error("PDF generation failed.");
    }
  }, [baseName, book, buildHtml, lastHtml, publishProgress]);

  const downloadTxt = useCallback(() => {
    if (!lastTxt) return;
    downloadRef.current.downloadBlob(
      new Blob([lastTxt], { type: "text/plain;charset=utf-8" }),
      `${baseName}.txt`
    );
    toast.success("TXT downloaded.");
  }, [baseName, lastTxt]);

  const copyOutput = useCallback(async () => {
    const content = outputTab === "html" ? lastHtml : lastTxt;
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      toast.success("Copied to clipboard.");
    } catch (error) {
      console.error(error);
      toast.error("Clipboard copy failed.");
    }
  }, [lastHtml, lastTxt, outputTab]);

  const outputPreview = useMemo(() => {
    if (!lastTxt) return "";
    return lastTxt.length > 200000 ? `${lastTxt.slice(0, 200000)}\n\n…(truncated for preview)` : lastTxt;
  }, [lastTxt]);

  useEffect(() => {
    if (!previewInIframe || !lastHtml) {
      setIframeSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return "";
      });
      return;
    }

    const blob = new Blob([lastHtml], { type: "text/html;charset=utf-8" });
    const nextSrc = URL.createObjectURL(blob);
    setIframeSrc((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return nextSrc;
    });
    return () => {
      URL.revokeObjectURL(nextSrc);
    };
  }, [lastHtml, previewInIframe]);

  const copyDisabled = outputTab === "html" ? !lastHtml : !lastTxt;

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.18),_transparent_55%)] pb-12">
        <Toaster richColors position="top-right" />
        <header className="container flex flex-wrap items-center justify-between gap-4 py-6">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-muted-foreground">One More EPUB</p>
            <h1 className="text-3xl font-semibold leading-tight md:text-4xl">EPUB to TXT + Printable HTML + PDF</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Private, offline-ready conversion in your browser. No uploads. No servers. Just clean output.
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" aria-label="Toggle theme">
                {theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                <span className="hidden sm:inline">Theme</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Appearance</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as ThemeMode)}>
                <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main className="container space-y-6">
          <Card className="border-none bg-gradient-to-br from-background via-background to-muted/60 shadow-soft">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Upload className="h-5 w-5 text-primary" />
                Upload your EPUB
              </CardTitle>
              <CardDescription>
                Drag and drop your .epub or .zip file or click to browse. The file never leaves your device.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div
                {...getRootProps()}
                className={cn(
                  "rounded-xl border-2 border-dashed p-6 transition hover:border-primary/60",
                  isDragActive ? "border-primary bg-primary/5" : "border-border"
                )}
              >
                <input {...getInputProps()} aria-label="Upload EPUB" />
                <div className="flex flex-col items-center justify-center text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Upload className="h-6 w-6" />
                  </div>
                  <p className="mt-4 text-sm font-medium">
                    {isDragActive ? "Drop the file to start" : "Drop EPUB here or click to upload"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">Supports .epub and .zip files.</p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {file ? (
                  <Badge variant="secondary">
                    {file.name} • {formatFileSize(file.size)}
                  </Badge>
                ) : (
                  <Badge variant="outline">No file selected</Badge>
                )}
                <Badge variant="outline">Privacy: runs locally</Badge>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Status & Actions</CardTitle>
              <CardDescription>Run conversions, download outputs, and open a print-friendly view.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert className="border-primary/20 bg-primary/5">
                <div className="flex items-start gap-3">
                  {progressSnapshot.running ? (
                    <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-primary" />
                  ) : progressSnapshot.stage.startsWith("Error") || progressSnapshot.stage.startsWith("Failed") ? (
                    <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 text-primary" />
                  )}
                  <div>
                    <AlertTitle>Status</AlertTitle>
                    <AlertDescription className="space-y-1">
                      <span className="block">{progressSnapshot.stage}</span>
                      {progressSnapshot.detail ? (
                        <span className="block text-xs text-muted-foreground">{progressSnapshot.detail}</span>
                      ) : null}
                    </AlertDescription>
                  </div>
                </div>
              </Alert>

              {progressSnapshot.running && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Conversion progress</span>
                    <span>{progressSnapshot.percent}%</span>
                  </div>
                  <Progress value={progressSnapshot.percent} />
                </div>
              )}

              <Separator />

              <div className="sticky bottom-0 z-10 -mx-6 rounded-b-xl border-t bg-background/95 px-6 py-4 backdrop-blur sm:static sm:mx-0 sm:border-none sm:bg-transparent sm:px-0 sm:py-0">
                <div className="flex flex-wrap gap-2">
                  <Button onClick={convertTxt} disabled={!canRun}>
                    <FileText className="h-4 w-4" />
                    Convert to TXT
                  </Button>
                  <Button variant="secondary" onClick={downloadHtml} disabled={!canRun}>
                    <Download className="h-4 w-4" />
                    Download HTML
                  </Button>
                  <Button variant="outline" onClick={openPrintable} disabled={!canRun}>
                    <Printer className="h-4 w-4" />
                    Printable view
                  </Button>
                  <Button variant="outline" onClick={downloadPdf} disabled={!canRun}>
                    <FileDown className="h-4 w-4" />
                    Download PDF
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" onClick={resetState}>
                        <Trash2 className="h-4 w-4" />
                        Clear
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Reset file & output</TooltipContent>
                  </Tooltip>
                  <Button variant="outline" onClick={downloadTxt} disabled={!lastTxt}>
                    <Download className="h-4 w-4" />
                    Download TXT
                  </Button>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Tip: Download PDF or use Printable → Save as PDF for a clean copy. Large books may take a minute.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">HTML export options</CardTitle>
              <CardDescription>
                Pick the HTML package style you want, then download from the action bar.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <div
                  className={cn(
                    "rounded-xl border p-4",
                    htmlExportMode === "inline" ? "border-primary/60 bg-primary/5" : "border-border"
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">Single HTML file</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Fully self-contained HTML with images and styles inlined.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant={htmlExportMode === "inline" ? "default" : "outline"}
                      onClick={() => setHtmlExportMode("inline")}
                      disabled={!book}
                    >
                      Select
                    </Button>
                  </div>
                </div>
                <div
                  className={cn(
                    "rounded-xl border p-4",
                    htmlExportMode === "zip" ? "border-primary/60 bg-primary/5" : "border-border"
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">Offline HTML project (ZIP)</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Includes index.html plus an assets folder for offline viewing.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant={htmlExportMode === "zip" ? "default" : "outline"}
                      onClick={() => setHtmlExportMode("zip")}
                      disabled={!book}
                    >
                      Select
                    </Button>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">Preview mode</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Iframe preview uses the self-contained HTML for reliable asset loading.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant={previewInIframe ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPreviewInIframe(true)}
                      disabled={!book}
                    >
                      Iframe
                    </Button>
                    <Button
                      variant={!previewInIframe ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPreviewInIframe(false)}
                      disabled={!book}
                    >
                      Raw HTML
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Output Preview</CardTitle>
              <CardDescription>Inspect the generated text or HTML before downloading.</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs value={outputTab} onValueChange={setOutputTab}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <TabsList>
                    <TabsTrigger value="preview">Preview (TXT)</TabsTrigger>
                    <TabsTrigger value="html">HTML</TabsTrigger>
                  </TabsList>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setMonospace((prev) => !prev)}
                      aria-pressed={monospace}
                    >
                      {monospace ? "Monospace on" : "Monospace off"}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={copyOutput} disabled={copyDisabled}>
                      Copy to clipboard
                    </Button>
                  </div>
                </div>
                <TabsContent value="preview">
                  <Textarea
                    readOnly
                    value={outputPreview || "TXT output will appear here."}
                    className={cn("min-h-[220px] resize-y", monospace && "font-mono")}
                  />
                </TabsContent>
                <TabsContent value="html">
                  {previewInIframe ? (
                    <div className="min-h-[220px] overflow-hidden rounded-lg border">
                      {iframeSrc ? (
                        <iframe
                          title="HTML preview"
                          src={iframeSrc}
                          className="min-h-[420px] w-full"
                          sandbox="allow-same-origin"
                        />
                      ) : (
                        <div className="p-4 text-sm text-muted-foreground">Generate HTML to preview it here.</div>
                      )}
                    </div>
                  ) : (
                    <Textarea
                      readOnly
                      value={lastHtml || "Generate HTML to preview it here."}
                      className="min-h-[220px] resize-y font-mono"
                    />
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </main>
      </div>
    </TooltipProvider>
  );
}

export default App;
