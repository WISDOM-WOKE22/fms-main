"use client";

import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import { saveFile } from "@/core/lib/saveFile";

export type ExportPdfLocale = "en" | "ar";

export interface ExportPdfOptions {
  /** Report title (e.g. "Audit Logs") */
  title: string;
  /** Short description shown below the title */
  description: string;
  /** Optional company logo URL (absolute, relative, or data URL). If relative, pass origin for resolution. */
  logoUrl?: string | null;
  /** Origin for resolving relative logo URLs (e.g. window.location.origin) */
  origin?: string;
  /** Table column headers */
  headers: string[];
  /** Table rows (array of cell values per row) */
  rows: string[][];
  /** Optional executive summary KPI cards rendered above tables. */
  summaryCards?: Array<{ label: string; value: string }>;
  /** Optional highlight lines rendered above the productivity chart (without card UI). */
  highlights?: Array<{ label: string; value: string }>;
  /** Optional productivity section rendered with trend chart. */
  productivity?: {
    score: number;
    definition?: string;
    series?: Array<{ label: string; value: number }>;
    chartStyle?: "line" | "area";
  };
  /** Optional multi-section tables. When set, these are rendered instead of headers/rows table. */
  sections?: Array<{
    title: string;
    headers: string[];
    rows: string[][];
  }>;
  /** Output filename without extension (e.g. "audit-logs-2025-03-05") */
  filename: string;
  /** Locale for PDF content; when "ar", Noto Sans Arabic is used for correct Arabic rendering. */
  locale?: ExportPdfLocale;
}

/** Noto Sans Arabic font for PDF export (Arabic locale). CDN and local fallback. */
const NOTO_SANS_ARABIC_REGULAR_URL =
  "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosansarabic/NotoSansArabic%5Bwdth,wght%5D.ttf";
/** Local fallback when origin is available (e.g. /fonts/NotoSansArabic-Regular.ttf if you host it). */
const NOTO_SANS_ARABIC_LOCAL = "/fonts/NotoSansArabic-Regular.ttf";

const NOTO_SANS_ARABIC_FONT_ID = "NotoSansArabic";
const NOTO_SANS_ARABIC_VFS_NAME = "NotoSansArabic-Regular.ttf";

const LOGO_MAX_WIDTH_MM = 15.12; /* further 30% reduction from 21.6mm */
const LOGO_MAX_HEIGHT_MM = 14;
const MARGIN_MM = 14;
const HEADER_BOTTOM_MM = 10;
const CARD_GAP_MM = 4;
const CARD_HEIGHT_MM = 18;

function drawSummaryCards(
  doc: jsPDF,
  fontName: string,
  cards: Array<{ label: string; value: string }>,
  startY: number
): number {
  if (cards.length === 0) return startY;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const maxCardsPerRow = 4;
  const cardsPerRow = Math.min(maxCardsPerRow, cards.length);
  const cardWidth = (pageWidth - MARGIN_MM * 2 - CARD_GAP_MM * (cardsPerRow - 1)) / cardsPerRow;
  let y = startY;
  for (let i = 0; i < cards.length; i += cardsPerRow) {
    if (y + CARD_HEIGHT_MM > pageHeight - MARGIN_MM) {
      doc.addPage();
      y = MARGIN_MM;
    }
    const row = cards.slice(i, i + cardsPerRow);
    row.forEach((card, idx) => {
      const x = MARGIN_MM + idx * (cardWidth + CARD_GAP_MM);
      doc.setFillColor(248, 250, 252);
      doc.roundedRect(x, y, cardWidth, CARD_HEIGHT_MM, 2, 2, "F");
      doc.setDrawColor(226, 232, 240);
      doc.roundedRect(x, y, cardWidth, CARD_HEIGHT_MM, 2, 2, "S");
      doc.setFont(fontName, "normal");
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text(card.label, x + 3, y + 6);
      doc.setFont(fontName, "bold");
      doc.setFontSize(13);
      doc.setTextColor(15, 23, 42);
      doc.text(card.value, x + 3, y + 14);
    });
    y += CARD_HEIGHT_MM + CARD_GAP_MM;
  }
  return y + 2;
}

function drawHighlights(
  doc: jsPDF,
  fontName: string,
  highlights: Array<{ label: string; value: string }>,
  startY: number
): number {
  if (highlights.length === 0) return startY;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const availableWidth = pageWidth - MARGIN_MM * 2;
  const lineHeight = 4.6;
  const gapY = 2.2;

  let y = startY + 4;
  for (const h of highlights) {
    const label = h.label;
    const value = h.value;
    const content = `${label}: ${value}`;
    const lines = doc.splitTextToSize(content, availableWidth);
    if (y + lines.length * lineHeight > pageHeight - MARGIN_MM) {
      doc.addPage();
      y = MARGIN_MM;
    }
    doc.setFontSize(9);
    doc.setFont(fontName, "normal");
    doc.setTextColor(71, 85, 105);
    doc.text(lines as any, MARGIN_MM, y);
    y += lines.length * lineHeight + gapY;
  }
  return y;
}

function drawProductivityChart(
  doc: jsPDF,
  fontName: string,
  productivity: NonNullable<ExportPdfOptions["productivity"]>,
  startY: number
): number {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const chartX = MARGIN_MM;
  const chartY = startY + 12;
  const chartW = pageWidth - MARGIN_MM * 2;
  const chartH = 30;

  if (chartY + chartH + 18 > pageHeight - MARGIN_MM) {
    doc.addPage();
    return drawProductivityChart(doc, fontName, productivity, MARGIN_MM - 8);
  }

  doc.setFont(fontName, "bold");
  doc.setFontSize(11);
  doc.setTextColor(30, 41, 59);
  doc.text("Productivity", chartX, startY);

  doc.setFont(fontName, "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(71, 85, 105);
  const definition = productivity.definition || "Composite score based on attendance and schedule adherence.";
  const scoreText = `Score: ${Math.max(0, Math.min(100, productivity.score)).toFixed(1)}%`;
  doc.text(`${scoreText} - ${definition}`, chartX, startY + 5);

  const series = (productivity.series || []).slice(0, 16);
  if (series.length === 0) return chartY + 2;

  doc.setDrawColor(203, 213, 225);
  doc.line(chartX, chartY + chartH, chartX + chartW, chartY + chartH);
  doc.line(chartX, chartY, chartX, chartY + chartH);

  const maxVal = Math.max(100, ...series.map((s) => s.value));
  const xStep = series.length > 1 ? chartW / (series.length - 1) : chartW;

  const points = series.map((point, index) => {
    const x = chartX + index * xStep;
    const y = chartY + chartH - (Math.max(0, point.value) / maxVal) * chartH;
    return { x, y, label: point.label, value: point.value };
  });

  const chartStyle = productivity.chartStyle || "area";
  if (chartStyle === "area" && points.length > 1) {
    // Fill under the curve with a light blue area.
    const baselineY = chartY + chartH;

    // Use graphics state opacity for the fill.
    const GState = (doc as any).GState;
    if (GState) doc.setGState(new GState({ opacity: 0.12 }));

    doc.setFillColor(37, 99, 235);
    doc.setDrawColor(37, 99, 235);

    // Prefer polygon filling when supported; otherwise use a safe rect-segment fallback.
    let filled = false;
    const polygonFn = (doc as any).polygon;
    if (typeof polygonFn === "function") {
      try {
        // Some jsPDF builds support polygon(points, style) where points are [[x,y],...].
        const polyPoints: Array<[number, number]> = [
          [points[0]!.x, baselineY],
          ...points.map((p): [number, number] => [p.x, p.y]),
          [points[points.length - 1]!.x, baselineY],
        ];
        polygonFn.call(doc, polyPoints, "F");
        filled = true;
      } catch {
        filled = false;
      }
    }

    if (!filled) {
      // Fallback: approximate the filled area using vertical rect segments.
      for (let i = 1; i < points.length; i++) {
        const left = points[i - 1]!.x;
        const right = points[i]!.x;
        const w = Math.max(0.4, right - left);
        const topY = Math.min(points[i - 1]!.y, points[i]!.y);
        const h = Math.max(0, baselineY - topY);
        doc.rect(left, topY, w, h, "F");
      }
    }

    // Reset opacity after filling, otherwise it can affect subsequent rendering.
    if (GState) doc.setGState(new GState({ opacity: 1 }));
  }

  doc.setDrawColor(37, 99, 235);
  doc.setLineWidth(0.8);
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (i > 0) doc.line(points[i - 1]!.x, points[i - 1]!.y, p.x, p.y);
    doc.setFillColor(37, 99, 235);
    doc.circle(p.x, p.y, 1, "F");
    if (i % Math.ceil(points.length / 6) === 0 || i === points.length - 1) {
      doc.setFont(fontName, "normal");
      doc.setFontSize(7);
      doc.setTextColor(71, 85, 105);
      doc.text(points[i]!.label, p.x - 3, chartY + chartH + 4);
    }
  }

  return chartY + chartH + 10;
}

/**
 * Fetch a binary file (e.g. TTF) and return raw base64 string for jsPDF VFS.
 */
async function fetchFontAsBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary);
  } catch {
    return null;
  }
}

/** Cache for Noto Sans Arabic base64 so we only fetch once per session. */
let notoSansArabicBase64: string | null = null;

/**
 * Register Noto Sans Arabic with the jsPDF document for correct Arabic text rendering.
 * Uses Identity-H encoding for Unicode. Fetches font from CDN or local origin once and caches.
 */
async function registerNotoSansArabic(doc: jsPDF, origin: string): Promise<boolean> {
  if (notoSansArabicBase64) {
    doc.addFileToVFS(NOTO_SANS_ARABIC_VFS_NAME, notoSansArabicBase64);
    doc.addFont(NOTO_SANS_ARABIC_VFS_NAME, NOTO_SANS_ARABIC_FONT_ID, "normal", undefined, "Identity-H");
    doc.addFont(NOTO_SANS_ARABIC_VFS_NAME, NOTO_SANS_ARABIC_FONT_ID, "bold", undefined, "Identity-H");
    return true;
  }
  const localUrl = origin ? `${origin.replace(/\/$/, "")}${NOTO_SANS_ARABIC_LOCAL}` : "";
  const base64 = await fetchFontAsBase64(localUrl || NOTO_SANS_ARABIC_REGULAR_URL);
  if (!base64) {
    if (localUrl) {
      const fallback = await fetchFontAsBase64(NOTO_SANS_ARABIC_REGULAR_URL);
      if (fallback) {
        notoSansArabicBase64 = fallback;
        doc.addFileToVFS(NOTO_SANS_ARABIC_VFS_NAME, fallback);
        doc.addFont(NOTO_SANS_ARABIC_VFS_NAME, NOTO_SANS_ARABIC_FONT_ID, "normal", undefined, "Identity-H");
        doc.addFont(NOTO_SANS_ARABIC_VFS_NAME, NOTO_SANS_ARABIC_FONT_ID, "bold", undefined, "Identity-H");
        return true;
      }
    }
    return false;
  }
  notoSansArabicBase64 = base64;
  doc.addFileToVFS(NOTO_SANS_ARABIC_VFS_NAME, base64);
  doc.addFont(NOTO_SANS_ARABIC_VFS_NAME, NOTO_SANS_ARABIC_FONT_ID, "normal", undefined, "Identity-H");
  doc.addFont(NOTO_SANS_ARABIC_VFS_NAME, NOTO_SANS_ARABIC_FONT_ID, "bold", undefined, "Identity-H");
  return true;
}

/**
 * Load image from URL and return as base64 data URI, or return the string if it's already a data URI.
 * Fetches with credentials for same-origin; CORS may block cross-origin URLs.
 */
async function loadImageAsBase64(
  url: string,
  origin: string
): Promise<{ data: string; format: "JPEG" | "PNG" } | null> {
  const trimmed = url.trim();
  if (/^data:image\/(jpeg|jpg|png|gif|webp);base64,/.test(trimmed)) {
    const match = trimmed.match(/^data:image\/(\w+);base64,/);
    const format = (match?.[1]?.toLowerCase() === "png" ? "PNG" : "JPEG") as "JPEG" | "PNG";
    return { data: trimmed, format };
  }
  const resolved =
    /^(https?:|data:)/i.test(trimmed) ? trimmed : `${origin || ""}${trimmed.startsWith("/") ? "" : "/"}${trimmed}`;
  try {
    const res = await fetch(resolved, { mode: "cors", credentials: "same-origin" });
    if (!res.ok) return null;
    const blob = await res.blob();
    const mime = blob.type || "image/png";
    const format = mime.includes("png") ? "PNG" : "JPEG";
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const data = reader.result as string;
        resolve(data ? { data, format } : null);
      };
      reader.onerror = () => reject(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Generate and download a landscape PDF with optional logo, title, description, and table.
 * Uses jsPDF and jspdf-autotable; no print dialog.
 * When locale is "ar", Noto Sans Arabic is used for correct, readable Arabic text.
 */
export async function exportPdf(options: ExportPdfOptions): Promise<void> {
  const {
    title,
    description,
    logoUrl,
    origin = "",
    headers,
    rows,
    filename,
    locale = "en",
    summaryCards = [],
    productivity,
    sections = [],
  } = options;

  const doc = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: "a4",
  });

  const isArabic = locale === "ar";
  if (isArabic) {
    const registered = await registerNotoSansArabic(doc, origin);
    if (!registered) {
      throw new Error("Failed to load Noto Sans Arabic font for PDF export.");
    }
  }

  const fontName = isArabic ? NOTO_SANS_ARABIC_FONT_ID : "helvetica";
  let cursorY = MARGIN_MM;
  const pageWidth = doc.internal.pageSize.getWidth();
  const rightEdge = pageWidth - MARGIN_MM;

  // Logo (left side)
  if (logoUrl && logoUrl.trim()) {
    const img = await loadImageAsBase64(logoUrl.trim(), origin);
    if (img) {
      try {
        const imgW = LOGO_MAX_WIDTH_MM;
        const imgH = LOGO_MAX_HEIGHT_MM;
        doc.addImage(img.data, img.format, MARGIN_MM, cursorY, imgW, imgH);
      } catch {
        // ignore invalid image
      }
    }
  }

  // Title and description (right side)
  const textBlockWidth = 70;
  const textX = rightEdge - textBlockWidth;
  doc.setFontSize(16);
  doc.setFont(fontName, "bold");
  doc.text(title, textX, cursorY + 3);

  // Extra vertical gap so subtitle isn't cramped under the title.
  cursorY += 10;
  doc.setFontSize(9);
  doc.setFont(fontName, "normal");
  const descLines = doc.splitTextToSize(description, textBlockWidth);
  doc.text(descLines, textX, cursorY);

  cursorY += Math.max(descLines.length * 4.3, LOGO_MAX_HEIGHT_MM) + HEADER_BOTTOM_MM;

  // Summary cards
  cursorY = drawSummaryCards(doc, fontName, summaryCards, cursorY);

  // Highlight lines (no card UI)
  if (options.highlights?.length) {
    cursorY = drawHighlights(doc, fontName, options.highlights, cursorY);
  }

  // Productivity chart
  if (productivity) {
    cursorY = drawProductivityChart(doc, fontName, productivity, cursorY);
  }

  // Sectioned tables or fallback single table
  const renderTable = (tableHeaders: string[], tableRows: string[][], titleText?: string) => {
    if (titleText) {
      doc.setFont(fontName, "bold");
      doc.setFontSize(10);
      doc.setTextColor(30, 41, 59);
      doc.text(titleText, MARGIN_MM, cursorY);
      cursorY += 4;
    }
    doc.setFont(fontName, "normal");
    autoTable(doc, {
      head: [tableHeaders],
      body: tableRows,
      startY: cursorY,
      margin: { left: MARGIN_MM, right: MARGIN_MM },
      tableWidth: "auto",
      theme: "striped",
      headStyles: {
        fillColor: [59, 130, 246],
        textColor: 255,
        fontStyle: "bold",
        fontSize: 9,
        font: fontName,
      },
      bodyStyles: { fontSize: 8, font: fontName },
      alternateRowStyles: { fillColor: [245, 247, 250] },
    });
    cursorY = (((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? cursorY) + 7);
  };

  if (sections.length > 0) {
    sections.forEach((section) => renderTable(section.headers, section.rows, section.title));
  } else {
    renderTable(headers, rows);
  }

  const blob = doc.output("blob") as Blob;
  await saveFile(blob, `${filename}.pdf`);
}
