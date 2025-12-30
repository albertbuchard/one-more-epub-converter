declare module "html2pdf.js" {
  type Html2PdfPageBreakMode = "avoid-all" | "css" | "legacy";

  interface Html2PdfOptions {
    margin?: number | [number, number, number, number];
    filename?: string;
    image?: { type: "jpeg" | "png" | "webp"; quality?: number };
    html2canvas?: { scale?: number; useCORS?: boolean };
    jsPDF?: { unit?: string; format?: string | [number, number]; orientation?: "portrait" | "landscape" };
    pagebreak?: { mode?: Html2PdfPageBreakMode | Html2PdfPageBreakMode[] };
  }

  interface Html2PdfWorker {
    from: (source: HTMLElement | string) => Html2PdfWorker;
    set: (options: Html2PdfOptions) => Html2PdfWorker;
    outputPdf: (type: "blob" | "arraybuffer" | "datauristring" | "dataurlstring" | "dataurlnewwindow") => Promise<Blob>;
  }

  function html2pdf(): Html2PdfWorker;

  export default html2pdf;
}
