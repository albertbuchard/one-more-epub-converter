import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileRejection, useDropzone } from "react-dropzone";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
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
  PrintService,
} from "./lib/converter";
import { cn } from "./lib/utils";

type ThemeMode = "system" | "light" | "dark";

type ConversionState = {
  stage: string;
  progress: number;
  running: boolean;
};

const defaultConversion: ConversionState = {
  stage: "Ready. Choose an .epub or .zip file.",
  progress: 0,
  running: false,
};

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
  const printRef = useRef(new PrintService());

  const [theme, setTheme] = useState<ThemeMode>("system");
  const [file, setFile] = useState<File | null>(null);
  const [book, setBook] = useState<Awaited<ReturnType<EpubConverter["loadBook"]>> | null>(null);
  const [lastHtml, setLastHtml] = useState<string>("");
  const [lastTxt, setLastTxt] = useState<string>("");
  const [outputTab, setOutputTab] = useState("preview");
  const [monospace, setMonospace] = useState(true);
  const [conversion, setConversion] = useState<ConversionState>(defaultConversion);

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
      setConversion({ stage: "Loading EPUB runtime…", progress: 12, running: true });
      try {
        await runtimeRef.current.init();
        setConversion({ stage: "Ready. Choose an .epub or .zip file.", progress: 100, running: false });
      } catch (error) {
        console.error(error);
        setConversion({
          stage: `Failed to load runtime: ${(error as Error)?.message || error}`,
          progress: 0,
          running: false,
        });
        toast.error("Failed to load EPUB runtime.");
      }
    };

    init();
  }, []);

  const resetState = useCallback(() => {
    setFile(null);
    setBook(null);
    setLastHtml("");
    setLastTxt("");
    setOutputTab("preview");
    setConversion({ stage: "Cleared. Choose an .epub or .zip file.", progress: 0, running: false });
  }, []);

  const handleFile = useCallback(async (nextFile: File) => {
    setLastHtml("");
    setLastTxt("");
    setOutputTab("preview");
    setConversion({ stage: `Reading ${nextFile.name}…`, progress: 25, running: true });
    try {
      const { buf, displayName } = await normalizeToEpubArrayBuffer(nextFile);
      const displayFile = new File([buf], displayName, { type: "application/epub+zip" });
      setFile(displayFile);
      const loadedBook = await converterRef.current.loadBook(buf);
      setBook(loadedBook);
      setConversion({
        stage: `Loaded ${displayName}. Choose TXT or Printable.`,
        progress: 100,
        running: false,
      });
      toast.success("EPUB loaded successfully.");
    } catch (error) {
      console.error(error);
      setConversion({ stage: `Error: ${(error as Error)?.message || error}`, progress: 0, running: false });
      toast.error("Failed to load the EPUB file.");
    }
  }, []);

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

  const canRun = Boolean(book) && !conversion.running;

  const baseName = useMemo(() => FileNameService.baseName(file), [file]);

  const convertTxt = useCallback(async () => {
    if (!book) return;
    setConversion({ stage: "Converting to TXT…", progress: 55, running: true });
    try {
      const text = await converterRef.current.toTxt(book);
      setLastTxt(text);
      setOutputTab("preview");
      setConversion({ stage: "TXT ready. Downloading…", progress: 90, running: true });
      downloadRef.current.downloadBlob(
        new Blob([text], { type: "text/plain;charset=utf-8" }),
        `${baseName}.txt`
      );
      setConversion({ stage: "Done.", progress: 100, running: false });
      toast.success("TXT generated and downloaded.");
    } catch (error) {
      console.error(error);
      setConversion({ stage: `Error: ${(error as Error)?.message || error}`, progress: 0, running: false });
      toast.error("TXT conversion failed.");
    }
  }, [baseName, book]);

  const buildHtml = useCallback(async () => {
    if (!book) return "";
    setConversion({ stage: "Converting to HTML…", progress: 60, running: true });
    try {
      const html = await converterRef.current.toHtml(book);
      setLastHtml(html);
      setConversion({ stage: "HTML ready.", progress: 100, running: false });
      toast.success("HTML generated.");
      return html;
    } catch (error) {
      console.error(error);
      setConversion({ stage: `Error: ${(error as Error)?.message || error}`, progress: 0, running: false });
      toast.error("HTML conversion failed.");
      return "";
    }
  }, [book]);

  const downloadHtml = useCallback(async () => {
    if (!book) return;
    const html = lastHtml || (await buildHtml());
    if (!html) return;
    downloadRef.current.downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), `${baseName}.html`);
    toast.success("HTML downloaded.");
  }, [baseName, book, buildHtml, lastHtml]);

  const openPrintable = useCallback(async () => {
    if (!book) return;
    setConversion({ stage: "Building printable view…", progress: 70, running: true });
    const html = lastHtml || (await buildHtml());
    if (!html) return;
    try {
      setConversion({ stage: "Opening printable view…", progress: 95, running: true });
      printRef.current.openPrintable(html, baseName);
      setConversion({
        stage: "Printable view opened. Use Print → Save as PDF.",
        progress: 100,
        running: false,
      });
      toast.success("Printable view opened.");
    } catch (error) {
      console.error(error);
      setConversion({ stage: `Error: ${(error as Error)?.message || error}`, progress: 0, running: false });
      toast.error("Failed to open printable view.");
    }
  }, [baseName, book, buildHtml, lastHtml]);

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

  const copyDisabled = outputTab === "html" ? !lastHtml : !lastTxt;

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.18),_transparent_55%)] pb-12">
        <Toaster richColors position="top-right" />
        <header className="container flex flex-wrap items-center justify-between gap-4 py-6">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-muted-foreground">One More EPUB</p>
            <h1 className="text-3xl font-semibold leading-tight md:text-4xl">EPUB to TXT + Printable HTML</h1>
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
                  {conversion.running ? (
                    <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-primary" />
                  ) : conversion.stage.startsWith("Error") || conversion.stage.startsWith("Failed") ? (
                    <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 text-primary" />
                  )}
                  <div>
                    <AlertTitle>Status</AlertTitle>
                    <AlertDescription>{conversion.stage}</AlertDescription>
                  </div>
                </div>
              </Alert>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Conversion progress</span>
                  <span>{conversion.progress}%</span>
                </div>
                <Progress value={conversion.progress} />
              </div>

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
                    Printable / PDF
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
                  Tip: Use Printable → Save as PDF for a clean copy. Large books may take a minute.
                </p>
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
                  <Textarea
                    readOnly
                    value={lastHtml || "Generate HTML to preview it here."}
                    className="min-h-[220px] resize-y font-mono"
                  />
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
