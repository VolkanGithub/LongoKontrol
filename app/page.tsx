'use client';
import { useState, useEffect, useRef } from "react";
import * as XLSX from "xlsx";

// ── Veri Şablonları ────────────────────────────────────────────────
export interface OrderItem {
  id: number;
  stokAdi: string;
  tedarikci: string;
  miktar: number;
  birim: string;
  birimFiyat: number;
}

export interface ReceiptItem {
  stokAdi: string;
  miktar: number;
  birim: string;
  netBFiyat: number;
  toplam: number;
}

export interface ParsedPDF {
  fileName: string;
  detected: string;
  assigned: string;
  items: ReceiptItem[];
  warnings: string[];
}

export interface DiffResult {
  order: OrderItem;
  receipt: ReceiptItem;
  mB: number; mT: number; fB: number; fT: number; tT: number;
  excelToplam: number; pdfToplam: number; expectedPdfToplam: number;
  hasQtyErr: boolean; hasPriceErr: boolean; hasTotalErr: boolean;
  mathMismatch: boolean; hasErr: boolean;
  // YENİ (Blok 1): Brüt fazla ödeme hesabı + yön alanları
  overpayment: number;                          // TL — brüt aleyhte toplam (bu kalem için)
  qtyDir: "short" | "over" | "exact";           // miktar yönü (eksik/fazla/doğru)
  priceDir: "high" | "low" | "same";            // fiyat yönü (yüksek/düşük/aynı)
}

export interface SuppResult {
  key: string;
  name: string;
  matched: DiffResult[];
  unmatchedExcel: OrderItem[];
  unmatchedPdf: ReceiptItem[];
  hasPdf: boolean;
  hasOrders: boolean;
}

export interface Candidate extends ReceiptItem {
  score: number;
}

export interface PendingMatch {
  order: OrderItem;
  candidates: Candidate[];
  choice: string;
  supplier: string;
  suppKey: string;
}

export interface StatsData {
  suppCount: number;
  errCount: number;
  okCount: number;
  // Blok 3: Temizlik — aşağıdaki eski alanlar UI'dan kaldırıldı:
  // impact, qtyOnlyCount, qtyOnlyImpact, priceOnlyCount, priceOnlyImpact,
  // combinedCount, combinedImpact, mathMismatchCount, unmatchedCount
  // Yeni alanlar (Blok 1): 3 ana metrik + detay sayımlar
  overpayment: number;              // TL — brüt fazla ödeme (tedarikçiye gösterilen rakam)
  deliveryMismatchCount: number;    // Adet — eksik/fazla/yetkisiz teslim kalem sayısı
  deliveryMismatchValue: number;    // TL — risk göstergesi (ödenen değil, risk altındaki)
  dataSuspectCount: number;         // Adet — matematik tutarsızlığı olan kalem sayısı
  criticalCount: number;            // 🔴 KRİTİK
  mixedCount: number;               // 🟡 KARMA
  operationalCount: number;         // 🟠 OPERASYONEL
  suspiciousCount: number;          // 🟣 ŞÜPHE
  infoCount: number;                // 🔵 BİLGİ
  cleanCount: number;               // ⚪ TEMİZ
  unmatchedExcelCount: number;      // Siparişte var, tesellümde yok
  unmatchedPdfCount: number;        // Yetkisiz teslimat
}

interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  w: number;
}

declare global {
  interface Window {
    pdfjsLib: unknown;
  }
}

// ── Utils ──────────────────────────────────────────────────────────
const norm = (s: string | null | undefined): string =>
  String(s ?? "").toUpperCase().replace(/\s+/g, " ").trim();

const parseNum = (v: unknown): number => {
  if (typeof v === "number") return v;
  let s = String(v ?? 0).trim();
  // Strip currency symbols and whitespace
  s = s.replace(/\s/g, "").replace(/₺|TL|TRY/gi, "");
  // Strip any non-number characters except . , -
  s = s.replace(/[^\d,\.\-]/g, "");
  if (!s) return 0;
  // Turkish format: . is thousands separator, , is decimal
  // "20.000,0000" → 20000
  // "1.340,50"    → 1340.5
  // "20,320"      → 20.32
  // "0,8081"      → 0.8081
  // "20000"       → 20000 (no separator)
  if (s.includes(",")) {
    // Has decimal separator — dots are thousands, strip them
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(".")) {
    // No comma — dots might be thousands or US decimal
    const parts = s.split(".");
    // If all groups after first are exactly 3 digits → thousands separator
    const allGroups3 = parts.slice(1).every(p => /^\d{3}$/.test(p));
    if (parts.length > 1 && allGroups3 && /^\d{1,3}$/.test(parts[0]!)) {
      s = parts.join("");
    }
    // else leave as-is (e.g., "1.34" stays as 1.34)
  }
  return parseFloat(s) || 0;
};

const fmt = (n: number, d: number = 2): string =>
  (typeof n === "number" ? n : 0).toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtS = (n: number): string => (n > 0 ? "+" : "") + fmt(n);
const approxEq = (a: number, b: number, tol: number = 0.02): boolean => Math.abs(a - b) < tol;

// ── Tooltip Component (Blok 3 — Portal yok, CSS fixed) ──────────────
// createPortal kullanmıyor (artifact uyumluluğu).
// Hover ile detay gösterir. Pozisyon hesabı JS ile.
interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  maxWidth?: number;
}
function Tooltip({ content, children, maxWidth = 320 }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, above: true });
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const updatePos = () => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const spaceAbove = r.top;
    const above = spaceAbove >= 150;
    let left = r.left + r.width / 2 - maxWidth / 2;
    if (left + maxWidth > window.innerWidth - 8) left = window.innerWidth - maxWidth - 8;
    if (left < 8) left = 8;
    const top = above ? r.top - 8 : r.bottom + 8;
    setPos({ top, left, above });
  };

  const show = () => { updatePos(); setVisible(true); };
  const hide = () => setVisible(false);

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <span
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        tabIndex={0}
        style={{ cursor: "help", display: "inline-block" }}
      >
        {children}
      </span>
      {visible && (
        <div
          ref={tooltipRef}
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            width: maxWidth,
            transform: pos.above ? "translateY(-100%)" : "translateY(0)",
            zIndex: 9999,
            pointerEvents: "none",
          }}
        >
          <div className="bg-gray-950 border border-gray-700 rounded-lg shadow-2xl px-3 py-2.5 text-xs text-gray-200">
            {content}
          </div>
        </div>
      )}
    </span>
  );
}

// ── Learning Storage ───────────────────────────────────────────────
const LS_KEY = "longokontrol_mappings_v1";
async function loadMappings(): Promise<Record<string, string>> {
  try {
    const r = localStorage.getItem(LS_KEY);
    return r ? JSON.parse(r) : {};
  } catch { return {}; }
}
async function saveMappings(m: Record<string, string>): Promise<void> {
  try { localStorage.setItem(LS_KEY, JSON.stringify(m)); } catch { }
}

// ── Supplier matching ─────────────────────────────────────────────
function suppMatch(a: string, b: string): boolean {
  const na = norm(a), nb = norm(b); if (na === nb) return true;
  const cleanA = na.replace(/TİC\.|PAZ\.|SAN\.|LTD\.|ŞTİ\.|A\.Ş\.|DAĞ\.|VE/g, " ").replace(/\s+/g, " ").trim();
  const cleanB = nb.replace(/TİC\.|PAZ\.|SAN\.|LTD\.|ŞTİ\.|A\.Ş\.|DAĞ\.|VE/g, " ").replace(/\s+/g, " ").trim();
  if (cleanA === cleanB) return true;
  const wa = cleanA.split(" ").filter(w => w.length > 2).slice(0, 2).join(" ");
  const wb = cleanB.split(" ").filter(w => w.length > 2).slice(0, 2).join(" ");
  return !!wa && !!wb && (cleanA.includes(wb) || cleanB.includes(wa));
}

function simScore(a: string, b: string): number {
  const wa = new Set(norm(a).split(" ").filter(w => w.length > 2));
  const wb = new Set(norm(b).split(" ").filter(w => w.length > 2));
  if (!wa.size || !wb.size) return 0;
  let c = 0; for (const w of Array.from(wa)) if (wb.has(w)) c++;
  return c / Math.max(wa.size, wb.size);
}

// ── Row end-detection regex (FIXED: "TOPLAM" keyword too aggressive) ────
const END_OF_TABLE_RE = /^\s*(Ara\s+Toplam|Genel\s+Toplam|Kdv\s+Toplam|Kdv\s+Matrah|Kdv\s+%|Hesap\s+Kodu|Yekün|Ödenecek\s+Tutar|Sayfa\s+\d)/i;

// ── PDF Parser (Coordinate-based, primary) ────────────────────────
async function parsePDFCoordinate(file: File): Promise<{ tedarikci: string, items: ReceiptItem[], warnings: string[] }> {
  const buf = await file.arrayBuffer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs = window.pdfjsLib as any;
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const all: PdfTextItem[] = [];
  const warnings: string[] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const { items } = await page.getTextContent();
    const pageOffset = p * 5000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const t of items as any[]) {
      if (!t.str.trim()) continue;
      all.push({ text: t.str.trim(), x: t.transform[4], y: pageOffset + (vp.height - t.transform[5]), w: t.width ?? 0 });
    }
  }

  const rowMap = new Map<number, PdfTextItem[]>();
  for (const it of all) {
    let key = null;
    for (const k of Array.from(rowMap.keys())) { if (Math.abs(k - it.y) <= 4) { key = k; break; } }
    if (key === null) { key = it.y; rowMap.set(key, []); }
    rowMap.get(key)?.push(it);
  }
  const rows = Array.from(rowMap.entries()).sort(([a], [b]) => a - b).map(([y, its]) => {
    const s = its.sort((a: PdfTextItem, b: PdfTextItem) => a.x - b.x);
    return { y, items: s, text: s.map((i: PdfTextItem) => i.text).join(" ") };
  });

  // Detect supplier
  let tedarikci = file.name.replace(/\.pdf$/i, "").replace(/[_-]/g, " ");
  const CO = /TİC\.|PAZ\.|SAN\.|LTD|A\.Ş\.|GIDA|SÜT|MARKET|GRUP|KOLA|ET |ÜRÜ/i;
  for (const row of rows) {
    if (/Stok Kodu/i.test(row.text)) break;
    const left = row.items[0];
    if (left && CO.test(left.text) && !/longosphere/i.test(left.text)) { tedarikci = left.text; break; }
  }

  // Find header
  const hIdx = rows.findIndex(r => /Stok Kodu/i.test(r.text));
  if (hIdx === -1) {
    warnings.push("Header satırı (Stok Kodu) bulunamadı — parse başarısız");
    return { tedarikci, items: [], warnings };
  }

  // End of table (FIXED regex)
  let eIdx = rows.findIndex((r, i) => i > hIdx && END_OF_TABLE_RE.test(r.text));
  if (eIdx === -1) eIdx = rows.length;

  // Detect column X positions
  let miktarX = -1, birimX = -1, netFiyatX = -1, toplamX = -1;
  const headerItems: PdfTextItem[] = [];
  for (let i = Math.max(0, hIdx - 1); i <= Math.min(rows.length - 1, hIdx + 2); i++) {
    headerItems.push(...(rows[i]?.items ?? []));
  }

  for (const it of headerItems) {
    const txt = it.text.toLowerCase();
    const cX = it.x + (it.w / 2);
    if ((txt === "miktar" || txt === "miktari" || txt === "miktarı") && miktarX === -1) miktarX = cX;
    else if ((txt === "birim" || txt === "brm") && birimX === -1) birimX = cX;
    else if ((txt.includes("net b.fiyat") || txt.includes("net b. fyt") || txt === "net") && netFiyatX === -1) netFiyatX = cX;
    else if ((txt === "toplam" || txt === "tutar") && toplamX === -1) toplamX = cX;
  }

  // Fallback for netFiyat: rightmost "fiyat" header
  if (netFiyatX === -1) {
    const fiyatItems = headerItems.filter(it => it.text.toLowerCase().includes("fiyat") || it.text.toLowerCase().includes("fyt"));
    if (fiyatItems.length > 0) {
      fiyatItems.sort((a, b) => b.x - a.x);
      netFiyatX = fiyatItems[0]!.x + (fiyatItems[0]!.w / 2);
    }
  }

  if (miktarX === -1) warnings.push("Miktar kolonu tespit edilemedi");
  if (netFiyatX === -1) warnings.push("Net B.Fiyat kolonu tespit edilemedi");
  if (toplamX === -1) warnings.push("Toplam kolonu tespit edilemedi");

  const activeCols = [
    { key: "miktar", x: miktarX },
    { key: "birim", x: birimX },
    { key: "netFiyat", x: netFiyatX },
    { key: "toplam", x: toplamX }
  ].filter(c => c.x !== -1);

  const lineItems: ReceiptItem[] = [];
  let lastItem: ReceiptItem | null = null;
  let skippedCount = 0;

  for (let i = hIdx + 1; i < eIdx; i++) {
    const row = rows[i]!;
    if (row.text.trim() === "") continue;
    if (END_OF_TABLE_RE.test(row.text)) continue;

    const rowVals: Record<string, { text: string, dist: number }> = {};
    const nameItems: PdfTextItem[] = [];

    for (const it of row.items) {
      const cX = it.x + (it.w / 2);

      if (miktarX !== -1 && (it.x + it.w) < miktarX - 15) {
        nameItems.push(it);
        continue;
      }

      let bestCol = null;
      let minD = 35;
      for (const col of activeCols) {
        const d = Math.abs(cX - col.x);
        if (d < minD) { minD = d; bestCol = col.key; }
      }

      if (bestCol) {
        if (!rowVals[bestCol] || minD < rowVals[bestCol]!.dist) {
          rowVals[bestCol] = { text: it.text, dist: minD };
        }
      }
    }

    const mStr = rowVals["miktar"]?.text;
    const tStr = rowVals["toplam"]?.text;

    if (mStr || tStr) {
      let stokAdi = nameItems.map(it => it.text).join(" ").trim();
      stokAdi = stokAdi.replace(/^[\d\.\-]+\s+/, "").trim();

      const miktar = mStr ? parseNum(mStr) : 0;
      const netBFiyat = rowVals["netFiyat"] ? parseNum(rowVals["netFiyat"].text) : 0;
      const toplam = tStr ? parseNum(tStr) : 0;
      const birim = rowVals["birim"] ? rowVals["birim"].text.toLowerCase() : "";

      if (stokAdi && (miktar !== 0 || toplam !== 0)) {
        lastItem = { stokAdi, miktar, birim, netBFiyat, toplam };
        lineItems.push(lastItem);
      } else if (!stokAdi) {
        skippedCount++;
      }
    } else {
      // Continuation line (product name wrap)
      if (lastItem && nameItems.length > 0) {
        const extraText = nameItems.map(it => it.text).join(" ").trim();
        if (extraText) lastItem.stokAdi += " " + extraText;
      }
    }
  }

  if (skippedCount > 0) warnings.push(`${skippedCount} satır parse edilemedi (ürün adı eksik)`);

  // Merge returns (negative lines)
  const merged: ReceiptItem[] = [];
  for (const it of lineItems) {
    if (it.miktar < 0 || it.toplam < 0) {
      const existing = merged.find(m => norm(m.stokAdi) === norm(it.stokAdi) && m.miktar > 0);
      if (existing) {
        existing.miktar += it.miktar;
        existing.toplam += it.toplam;
        continue;
      }
    }
    merged.push({ ...it });
  }
  const final = merged.filter(m => m.miktar > 0 || m.toplam > 0);
  return { tedarikci, items: final, warnings };
}

// ── PDF Parser (String-based, fallback) ──────────────────────────
async function parsePDFString(file: File): Promise<{ tedarikci: string, items: ReceiptItem[], warnings: string[] }> {
  const buf = await file.arrayBuffer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs = window.pdfjsLib as any;
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const warnings: string[] = ["Fallback (string-based) parse kullanıldı"];
  const allRows: string[] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const { items } = await page.getTextContent();
    const rowMap = new Map<number, string[]>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const t of items as any[]) {
      if (!t.str.trim()) continue;
      const y = vp.height - t.transform[5];
      let key = null;
      for (const k of Array.from(rowMap.keys())) { if (Math.abs(k - y) <= 4) { key = k; break; } }
      if (key === null) { key = y; rowMap.set(key, []); }
      rowMap.get(key)?.push(t.str.trim());
    }
    const sorted = Array.from(rowMap.entries()).sort(([a], [b]) => a - b);
    for (const [, parts] of sorted) allRows.push(parts.join(" "));
  }

  let tedarikci = file.name.replace(/\.pdf$/i, "").replace(/[_-]/g, " ");
  const CO = /TİC\.|PAZ\.|SAN\.|LTD|A\.Ş\.|GIDA|SÜT|MARKET|GRUP|KOLA/i;
  for (const row of allRows) {
    if (/Stok Kodu/i.test(row)) break;
    if (CO.test(row) && !/longosphere/i.test(row)) {
      tedarikci = row.split(/\s+Şube|\s+Vize/)[0]!.trim();
      break;
    }
  }

  const hIdx = allRows.findIndex(r => /Stok Kodu/i.test(r));
  if (hIdx === -1) return { tedarikci, items: [], warnings: [...warnings, "Header bulunamadı"] };

  let eIdx = allRows.findIndex((r, i) => i > hIdx && END_OF_TABLE_RE.test(r));
  if (eIdx === -1) eIdx = allRows.length;

  const STOK_ANY = /(\d{3}\.\d{4})/g;
  const BRM_RE = /\b(Adet|Kg|Lt|Koli|Litre|Paket|Kutu|KG|LT|ML|AD)\b/i;
  const lineItems: ReceiptItem[] = [];

  for (let i = hIdx + 1; i < eIdx; i++) {
    const text = allRows[i]!.trim();
    const matches = Array.from(text.matchAll(STOK_ANY));
    if (matches.length === 0) continue;

    const segments: string[] = [];
    for (let m = 0; m < matches.length; m++) {
      const start = matches[m]!.index!;
      const end = m + 1 < matches.length ? matches[m + 1]!.index! : text.length;
      segments.push(text.substring(start, end).trim());
    }

    for (const seg of segments) {
      const stokMatch = seg.match(/^(\d{3}\.\d{4})\s+(.+)$/);
      if (!stokMatch) continue;
      const rest = stokMatch[2]!;
      const numRegex = /-?\d{1,3}(?:\.\d{3})+,\d+|-?\d+,\d+|-?\d+\.\d+/g;
      const allNums = rest.match(numRegex) || [];
      if (allNums.length < 2) continue;

      const firstNumStr = allNums[0]!;
      const miktar = parseNum(firstNumStr);
      if (miktar === 0) continue;

      const firstNumIdx = rest.indexOf(firstNumStr);
      let stokAdi = rest.substring(0, firstNumIdx).replace(/\s+/g, " ").trim();
      stokAdi = stokAdi.replace(/\s*(Kdv|Matrah).*$/i, "").trim();

      const afterMiktar = rest.substring(firstNumIdx + firstNumStr.length).trim();
      const birimMatch = afterMiktar.match(BRM_RE);
      const birim = (birimMatch?.[1] ?? "").toLowerCase();

      const toplam = parseNum(allNums[allNums.length - 1]!);
      const netBFiyat = parseNum(allNums[allNums.length - 2]!);

      lineItems.push({ stokAdi, miktar, birim, netBFiyat, toplam });
    }
  }

  // Merge negatives
  const merged: ReceiptItem[] = [];
  for (const it of lineItems) {
    if (it.miktar < 0 || it.toplam < 0) {
      const existing = merged.find(m => norm(m.stokAdi) === norm(it.stokAdi) && m.miktar > 0);
      if (existing) {
        existing.miktar += it.miktar;
        existing.toplam += it.toplam;
        continue;
      }
    }
    merged.push({ ...it });
  }
  const final = merged.filter(m => m.miktar > 0 || m.toplam > 0);
  return { tedarikci, items: final, warnings };
}

// ── PDF Parser (with fallback chain) ──────────────────────────────
async function parsePDF(file: File): Promise<{ tedarikci: string, items: ReceiptItem[], warnings: string[] }> {
  const primary = await parsePDFCoordinate(file);

  if (primary.items.length > 0) return primary;

  // Fallback: primary returned 0 items
  const fallback = await parsePDFString(file);
  return {
    ...fallback,
    warnings: [
      "Koordinat parse 0 kalem döndürdü",
      ...primary.warnings,
      ...fallback.warnings
    ]
  };
}

// ── Comparison Logic ──────────────────────────────────────────────
function buildDiff(order: OrderItem, receipt: ReceiptItem): DiffResult {
  const mB = order.miktar - receipt.miktar;
  const mT = mB * order.birimFiyat;
  const fB = receipt.netBFiyat - order.birimFiyat;
  const fT = fB * receipt.miktar;
  const excelToplam = order.miktar * order.birimFiyat;
  const pdfToplam = receipt.toplam;
  const tT = excelToplam - pdfToplam;
  const expectedPdfToplam = receipt.miktar * receipt.netBFiyat;
  const mathMismatch = !approxEq(expectedPdfToplam, pdfToplam, 0.5);

  // ── YENİ (Blok 1): Yön tespiti + Brüt fazla ödeme hesabı ──────────
  // mB > 0 → eksik geldi (lehte miktar)
  // mB < 0 → fazla geldi (aleyhte miktar)
  // fB > 0 → yüksek fiyat kesildi (aleyhte)
  // fB < 0 → düşük fiyat kesildi (lehte)
  const qtyDir: "short" | "over" | "exact" =
    mB > 0.0001 ? "short" : mB < -0.0001 ? "over" : "exact";
  const priceDir: "high" | "low" | "same" =
    fB > 0.001 ? "high" : fB < -0.001 ? "low" : "same";

  // BRÜT FAZLA ÖDEME: Sadece aleyhte durumlar toplanır, lehte durumlar DÜŞÜLMEZ
  // Bu "tedarikçiye gösterilen pazarlık rakamı"dır — net hesap değil
  let overpayment = 0;
  // Miktar aleyhe (fazla geldi): fazla miktar × anlaşılan birim fiyat
  if (qtyDir === "over") {
    overpayment += Math.abs(mB) * order.birimFiyat;
  }
  // Fiyat aleyhe (yüksek kesildi): fiyat farkı × gelen miktar
  if (priceDir === "high") {
    overpayment += fB * receipt.miktar;
  }

  return {
    order, receipt, mB, mT, fB, fT, tT, excelToplam, pdfToplam, expectedPdfToplam,
    hasQtyErr: mB !== 0,
    hasPriceErr: !approxEq(fB, 0, 0.001),
    hasTotalErr: !approxEq(tT, 0, 0.1),
    mathMismatch,
    hasErr: mB !== 0 || !approxEq(fB, 0, 0.001) || !approxEq(tT, 0, 0.1) || mathMismatch,
    overpayment,
    qtyDir,
    priceDir,
  };
}

function runComparison(orderItems: OrderItem[], parsedPdfs: ParsedPDF[], savedMappings: Record<string, string> = {}) {
  const oByS: Record<string, { name: string, items: OrderItem[] }> = {};
  const pByS: Record<string, { name: string, items: ReceiptItem[] }> = {};

  for (const o of orderItems) {
    const k = norm(o.tedarikci);
    if (!oByS[k]) oByS[k] = { name: o.tedarikci, items: [] };
    oByS[k]?.items.push(o);
  }
  for (const pdf of parsedPdfs) {
    const pName = pdf.assigned || pdf.detected;
    let matchedKey = Object.keys(oByS).find(k => k === norm(pName));
    if (!matchedKey) matchedKey = Object.keys(oByS).find(k => suppMatch(oByS[k]?.name ?? "", pName));
    const k = matchedKey ?? norm(pName);
    if (!pByS[k]) pByS[k] = { name: oByS[k]?.name || pName, items: [] };
    pByS[k]?.items.push(...pdf.items);
  }

  const allKeys = new Set([...Object.keys(oByS), ...Object.keys(pByS)]);
  const suppResults: SuppResult[] = [];
  const pendingM: PendingMatch[] = [];

  for (const key of Array.from(allKeys)) {
    const orders = oByS[key]?.items ?? [];
    const receipts = [...(pByS[key]?.items ?? [])];
    const name = oByS[key]?.name ?? pByS[key]?.name ?? key;
    const matched: DiffResult[] = [];
    const unmatchedExcel: OrderItem[] = [];

    for (const order of orders) {
      const no = norm(order.stokAdi);
      let ri = receipts.findIndex(r => norm(r.stokAdi) === no);
      if (ri === -1 && savedMappings[no]) {
        const savedTarget = savedMappings[no];
        ri = receipts.findIndex(r => norm(r.stokAdi) === savedTarget);
      }
      if (ri === -1) {
        ri = receipts.findIndex(r => {
          const nr = norm(r.stokAdi);
          return nr.includes(no) || no.includes(nr);
        });
      }
      if (ri !== -1) matched.push(buildDiff(order, receipts.splice(ri, 1)[0]!));
      else unmatchedExcel.push(order);
    }

    const remainingReceipts = [...receipts];
    for (const order of unmatchedExcel) {
      const cands = remainingReceipts.map(r => ({ ...r, score: simScore(order.stokAdi, r.stokAdi) }))
        .filter(r => r.score > 0.2).sort((a, b) => b.score - a.score).slice(0, 5);
      if (cands.length) {
        pendingM.push({ order, candidates: cands, choice: "skip", supplier: name, suppKey: key });
      }
    }

    suppResults.push({ key, name, matched, unmatchedExcel, unmatchedPdf: receipts, hasPdf: !!pByS[key], hasOrders: !!oByS[key] });
  }

  return { suppResults, pendingM };
}

// ── Issue Typology Helpers (Blok 1 — Yeniden Yazıldı) ─────────────
// 6 durum: clean / info / operational / mixed / suspicious / critical
// İşaret-bilinçli: qtyDir ve priceDir bileşenleri ile 9 senaryo matrisi
type IssueType = "clean" | "info" | "operational" | "mixed" | "suspicious" | "critical";

function getIssueType(m: DiffResult): IssueType {
  // Veri şüphesi önce — başka hiçbir şeyi değerlendirmeden önce veri doğruluğunu sorgula
  if (m.mathMismatch) return "suspicious";

  const q = m.qtyDir;
  const p = m.priceDir;

  // ── 9 Senaryo Matrisi ───────────────────────────────────────────
  // #5: Doğru miktar + aynı fiyat → TEMİZ
  if (q === "exact" && p === "same") return "clean";

  // #6: Doğru miktar + düşük fiyat → BİLGİ (sadece lehte, bilinçli kontrol)
  if (q === "exact" && p === "low") return "info";

  // #4: Doğru miktar + yüksek fiyat → KRİTİK (fiyat manipülasyonu)
  if (q === "exact" && p === "high") return "critical";

  // #8: Eksik + aynı fiyat → OPERASYONEL (enflasyon risk notu)
  if (q === "short" && p === "same") return "operational";

  // #9: Eksik + düşük fiyat → OPERASYONEL (lehte fiyat ama eksik teslim riski)
  if (q === "short" && p === "low") return "operational";

  // #7: Eksik + yüksek fiyat → KRİTİK (fiyat kısmı gerçek zarar)
  if (q === "short" && p === "high") return "critical";

  // #2: Fazla + aynı fiyat → KRİTİK (yetkisiz ek miktar, fazla ödeme)
  if (q === "over" && p === "same") return "critical";

  // #1: Fazla + yüksek fiyat → KRİTİK (iki yönlü aleyhe, en kötü senaryo)
  if (q === "over" && p === "high") return "critical";

  // #3: Fazla + düşük fiyat → KARMA (çelişkili, manuel inceleme)
  if (q === "over" && p === "low") return "mixed";

  return "clean"; // Teorik olarak ulaşılmaz, güvenlik fallback
}

function issueBadge(t: IssueType): { icon: string, label: string, className: string, title: string } {
  switch (t) {
    case "critical":
      return {
        icon: "🔴", label: "KRİTİK",
        className: "bg-red-900/60 text-red-200 border border-red-700 font-bold",
        title: "Aleyhe finansal durum — fazla mal ve/veya yüksek fiyat"
      };
    case "mixed":
      return {
        icon: "🟡", label: "KARMA",
        className: "bg-yellow-900/50 text-yellow-200 border border-yellow-700",
        title: "Çelişkili: fazla mal ama düşük fiyat — manuel incele"
      };
    case "operational":
      return {
        icon: "🟠", label: "OPR",
        className: "bg-orange-900/50 text-orange-200 border border-orange-700",
        title: "Eksik teslimat — enflasyon riski notu"
      };
    case "suspicious":
      return {
        icon: "🟣", label: "ŞÜPHE",
        className: "bg-purple-900/50 text-purple-200 border border-purple-700",
        title: "Miktar × fiyat ≠ Toplam — iskonto/KDV/parse kontrolü"
      };
    case "info":
      return {
        icon: "🔵", label: "BİLGİ",
        className: "bg-blue-900/40 text-blue-200 border border-blue-800",
        title: "Lehte fiyat — bilinçli kontrol için bilgi"
      };
    case "clean":
    default:
      return {
        icon: "⚪", label: "TEMİZ",
        className: "bg-emerald-900/40 text-emerald-300 border border-emerald-800",
        title: "Sorunsuz"
      };
  }
}

// Sıralama önceliği: critical (5) > mixed (4) > suspicious (3) > operational (2) > info (1) > clean (0)
function issuePriority(m: DiffResult): number {
  const t = getIssueType(m);
  if (t === "critical") return 5;
  if (t === "mixed") return 4;
  if (t === "suspicious") return 3;
  if (t === "operational") return 2;
  if (t === "info") return 1;
  return 0;
}

// Sıralama için etki ölçüsü — YENİ: overpayment kullanıyor (abs(tT) değil)
function issueImpact(m: DiffResult): number {
  return m.overpayment;
}

// ── Screens ────────────────────────────────────────────────────────
interface UploadScreenProps { excelFile: File | null; pdfFiles: File[]; onExcel: (f: File) => void; onAddPdfs: (fs: File[]) => void; onRemovePdf: (i: number) => void; onNext: () => void; err: string; }
function UploadScreen({ excelFile, pdfFiles, onExcel, onAddPdfs, onRemovePdf, onNext, err }: UploadScreenProps) {
  return (
    <div className="max-w-xl mx-auto">
      <h2 className="text-2xl font-bold mb-1">Dosya Yükleme</h2>
      <p className="text-gray-400 text-sm mb-8">1 Sipariş Listesi + birden fazla Tesellüm Fişi yükleyin.</p>
      <div className="mb-5">
        <p className="text-sm font-medium text-gray-300 mb-2">📊 Sipariş Listesi (Excel)</p>
        <label className={`flex flex-col items-center justify-center w-full h-28 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${excelFile ? "border-emerald-600 bg-emerald-950" : "border-gray-700 hover:border-gray-500 bg-gray-900"}`}>
          <input type="file" accept=".xlsx,.xls" className="hidden" onChange={(e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) onExcel(f); }} />
          {excelFile ? <><span className="text-2xl mb-1">✅</span><span className="text-sm text-emerald-400 px-3 text-center">{excelFile.name}</span></> : <><span className="text-2xl mb-1">📂</span><span className="text-sm text-gray-500">Tıkla veya sürükle</span></>}
        </label>
      </div>
      <div className="mb-6">
        <p className="text-sm font-medium text-gray-300 mb-2">📄 Tesellüm Fişleri (birden fazla PDF)</p>
        <label className="flex flex-col items-center justify-center w-full h-24 rounded-xl border-2 border-dashed border-gray-700 hover:border-gray-500 bg-gray-900 cursor-pointer transition-colors">
          <input type="file" accept=".pdf" multiple className="hidden" onChange={(e: React.ChangeEvent<HTMLInputElement>) => { const fs = Array.from(e.target.files ?? []).filter(f => f.name.toLowerCase().endsWith(".pdf")); if (fs.length) onAddPdfs(fs); }} />
          <span className="text-2xl mb-1">📑</span>
          <span className="text-sm text-gray-500">Her tedarikçi için ayrı PDF — çoklu seçin</span>
        </label>
        {pdfFiles.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {pdfFiles.map((f, i) => (
              <div key={i} className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2">
                <span className="text-sm text-blue-300 truncate">📄 {f.name}</span>
                <button onClick={() => onRemovePdf(i)} className="text-gray-600 hover:text-red-400 ml-3">✕</button>
              </div>
            ))}
            <p className="text-xs text-gray-600 text-center pt-1">{pdfFiles.length} PDF seçildi</p>
          </div>
        )}
      </div>
      {err && <p className="text-red-400 text-sm mb-4">⚠ {err}</p>}
      <button onClick={onNext} className="w-full bg-emerald-600 hover:bg-emerald-500 font-semibold py-3 rounded-xl transition-colors">Devam Et →</button>
    </div>
  );
}

interface MappingScreenProps { headers: string[]; colMap: Record<string, string>; onChange: (map: Record<string, string>) => void; onBack: () => void; onNext: () => void; err: string; }
function MappingScreen({ headers, colMap, onChange, onBack, onNext, err }: MappingScreenProps) {
  const fields = [
    { key: "stokAdi", label: "Ürün / Stok Adı", hint: "Ürün adlarının bulunduğu sütun" },
    { key: "tedarikci", label: "Tedarikçi (Notlar)", hint: "Genellikle 'Notlar' sütunu tedarikçi adını taşır" },
    { key: "miktar", label: "Sipariş Miktarı", hint: "Sipariş edilen miktar" },
    { key: "birim", label: "Birim", hint: "Kg, Adet, Lt vb." },
    { key: "birimFiyat", label: "Birim Fiyat", hint: "PDF'deki Net B.Fiyat ile karşılaştırılacak referans fiyat" }
  ];
  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-2xl font-bold mb-1">Sütun Eşleştirme</h2>
      <p className="text-gray-400 text-sm mb-7">Excel&apos;deki sütunları eşleştirin.</p>
      <div className="space-y-3">
        {fields.map(f => (
          <div key={f.key} className="bg-gray-900 rounded-xl p-4">
            <p className="font-semibold text-sm mb-0.5">{f.label}</p>
            <p className="text-xs text-gray-500 mb-2">{f.hint}</p>
            <select value={colMap[f.key]} onChange={e => onChange({ ...colMap, [f.key]: e.target.value })} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
              <option value="">— Sütun seçin —</option>
              {headers.map((h, i) => <option key={`${h}-${i}`} value={h}>{h}</option>)}
            </select>
          </div>
        ))}
      </div>
      {err && <p className="text-red-400 text-sm mt-4">⚠ {err}</p>}
      <div className="flex gap-3 mt-6">
        <button onClick={onBack} className="flex-1 bg-gray-800 hover:bg-gray-700 py-3 rounded-xl text-sm">← Geri</button>
        <button onClick={onNext} className="flex-1 bg-emerald-600 hover:bg-emerald-500 font-semibold py-3 rounded-xl">PDF&apos;leri İşle →</button>
      </div>
    </div>
  );
}

interface SupplierAssignScreenProps { pdfParsed: ParsedPDF[]; excelSupps: string[]; onChange: (i: number, v: string) => void; onBack: () => void; onNext: () => void; err: string; }
function SupplierAssignScreen({ pdfParsed, excelSupps, onChange, onBack, onNext, err }: SupplierAssignScreenProps) {
  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-2xl font-bold mb-1">Tedarikçi Onayı</h2>
      <p className="text-gray-400 text-sm mb-7">Her PDF için tedarikçi atamasını onaylayın.</p>
      <div className="space-y-3">
        {pdfParsed.map((p, i) => (
          <div key={i} className={`bg-gray-900 rounded-xl p-4 border ${p.assigned ? "border-emerald-700" : "border-yellow-700"}`}>
            <p className="text-sm font-semibold">📄 {p.fileName}</p>
            <p className="text-xs text-gray-400 mt-0.5 mb-3">Tespit edilen: <span className="text-yellow-300">{p.detected}</span> · {p.items.length} kalem</p>
            <select value={p.assigned} onChange={e => onChange(i, e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
              <option value="">— Tedarikçi seçin —</option>
              {excelSupps.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        ))}
      </div>
      {err && <p className="text-red-400 text-sm mt-4">⚠ {err}</p>}
      <div className="flex gap-3 mt-6">
        <button onClick={onBack} className="flex-1 bg-gray-800 hover:bg-gray-700 py-3 rounded-xl text-sm">← Geri</button>
        <button onClick={onNext} className="flex-1 bg-emerald-600 hover:bg-emerald-500 font-semibold py-3 rounded-xl">Ham Veriyi Gör →</button>
      </div>
    </div>
  );
}

interface RawPreviewScreenProps { pdfParsed: ParsedPDF[]; onBack: () => void; onNext: () => void; }
function RawPreviewScreen({ pdfParsed, onBack, onNext }: RawPreviewScreenProps) {
  return (
    <div className="max-w-5xl mx-auto">
      <div className="bg-yellow-950/40 border border-yellow-800 rounded-xl p-4 mb-6">
        <p className="text-sm font-semibold text-yellow-300 mb-1">🛠️ Ham Veri Önizleme</p>
        <p className="text-xs text-gray-400">PDF&apos;lerden parse edilen veriler aşağıda. Karşılaştırmaya geçmeden önce doğru okunduğunu kontrol edin. Sorun varsa geri dönün.</p>
      </div>

      <div className="space-y-6">
        {pdfParsed.map((p, i) => (
          <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="bg-gray-800/50 px-5 py-3 border-b border-gray-800">
              <p className="text-sm font-semibold">📄 {p.fileName}</p>
              <p className="text-xs text-gray-400 mt-0.5">Tedarikçi: <span className="text-emerald-300">{p.assigned || p.detected}</span> · <span className="text-blue-300">{p.items.length} kalem</span></p>
              {p.warnings.length > 0 && (
                <div className="mt-2 bg-yellow-950/50 border border-yellow-900 rounded-lg px-3 py-2">
                  {p.warnings.map((w, j) => <p key={j} className="text-xs text-yellow-300">⚠ {w}</p>)}
                </div>
              )}
            </div>
            {p.items.length === 0 ? (
              <div className="px-5 py-8 text-center">
                <p className="text-red-400 text-sm">⚠ Bu PDF&apos;den hiç kalem parse edilemedi.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-max">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="text-left py-2 px-4 font-medium">#</th>
                      <th className="text-left py-2 px-4 font-medium">Ürün Adı</th>
                      <th className="text-right py-2 px-4 font-medium">Miktar</th>
                      <th className="text-left py-2 px-4 font-medium">Birim</th>
                      <th className="text-right py-2 px-4 font-medium">Net B.Fiyat</th>
                      <th className="text-right py-2 px-4 font-medium">Toplam</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.items.map((it, j) => (
                      <tr key={j} className="border-b border-gray-800/50">
                        <td className="py-2 px-4 text-gray-600">{j + 1}</td>
                        <td className="py-2 px-4 font-medium">{it.stokAdi}</td>
                        <td className="py-2 px-4 text-right text-gray-300">{fmt(it.miktar, 3)}</td>
                        <td className="py-2 px-4 text-gray-400">{it.birim}</td>
                        <td className="py-2 px-4 text-right text-gray-300 font-mono">{fmt(it.netBFiyat)}</td>
                        <td className="py-2 px-4 text-right text-gray-300 font-mono">{fmt(it.toplam)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex gap-3 mt-8">
        <button onClick={onBack} className="flex-1 bg-gray-800 hover:bg-gray-700 py-3 rounded-xl text-sm">← Tedarikçi Onayına Dön</button>
        <button onClick={onNext} className="flex-1 bg-emerald-600 hover:bg-emerald-500 font-semibold py-3 rounded-xl">Veriler Doğru, Karşılaştır →</button>
      </div>
    </div>
  );
}

interface MatchingScreenProps { pending: PendingMatch[]; pIdx: number; onChange: (c: string) => void; onPrev: () => void; onNext: () => void; isLast: boolean; }
function MatchingScreen({ pending, pIdx, onChange, onPrev, onNext, isLast }: MatchingScreenProps) {
  const p = pending[pIdx]; if (!p) return null;
  return (
    <div className="max-w-lg mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">Manuel Eşleştirme</h2>
        <span className="text-sm text-gray-400 bg-gray-800 px-3 py-1 rounded-lg">{pIdx + 1} / {pending.length}</span>
      </div>
      <div className="bg-yellow-950 border border-yellow-700 rounded-xl p-4 mb-5">
        <p className="text-xs text-yellow-400 font-medium mb-1">Eşleştirilemeyen sipariş kalemi</p>
        <p className="font-bold">{p.order.stokAdi}</p>
        <p className="text-xs text-gray-400 mt-1">{p.supplier} · {fmt(p.order.miktar, 3)} {p.order.birim} · {fmt(p.order.birimFiyat)} ₺/birim</p>
      </div>
      <p className="text-sm text-gray-400 mb-3">PDF&apos;deki karşılığı hangisi?</p>
      <div className="space-y-2 mb-4">
        {p.candidates.map((c: Candidate, i: number) => (
          <label key={i} className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer border transition-colors ${p.choice === c.stokAdi ? "border-emerald-500 bg-emerald-950" : "border-gray-700 bg-gray-900 hover:border-gray-600"}`}>
            <input type="radio" name="match" checked={p.choice === c.stokAdi} onChange={() => onChange(c.stokAdi)} className="accent-emerald-500" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{c.stokAdi}</p>
              <p className="text-xs text-gray-400">{fmt(c.miktar, 3)} {c.birim} · {fmt(c.netBFiyat)} ₺</p>
            </div>
            <span className="text-xs text-gray-600 shrink-0">%{Math.round(c.score * 100)}</span>
          </label>
        ))}
        <label className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer border transition-colors ${p.choice === "skip" ? "border-gray-500 bg-gray-800" : "border-gray-700 bg-gray-900 hover:border-gray-600"}`}>
          <input type="radio" name="match" checked={p.choice === "skip"} onChange={() => onChange("skip")} className="accent-gray-500" />
          <span className="text-sm text-gray-400">Eşleşme yok — atla</span>
        </label>
      </div>
      <p className="text-xs text-gray-600 mb-5">💡 Seçtiğin eşleştirme hatırlanacak.</p>
      <div className="flex gap-3">
        <button onClick={onPrev} disabled={pIdx === 0} className="flex-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-30 py-3 rounded-xl text-sm">← Önceki</button>
        <button onClick={onNext} className="flex-1 bg-emerald-600 hover:bg-emerald-500 font-semibold py-3 rounded-xl">{isLast ? "Sonuçları Gör →" : "Sonraki →"}</button>
      </div>
    </div>
  );
}

interface ResultsScreenProps { results: SuppResult[]; stats: StatsData; onExport: () => void; }
function ResultsScreen({ results, stats, onExport }: ResultsScreenProps) {
  const [open, setOpen] = useState<Set<string>>(() => {
    const s = new Set<string>();
    results.forEach(r => {
      if (r.matched.filter((m: DiffResult) => m.hasErr).length + r.unmatchedExcel.length + r.unmatchedPdf.length > 0) s.add(r.key);
    });
    return s;
  });
  const toggle = (key: string) => setOpen(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const TH = "text-left py-2 pr-3 font-medium whitespace-nowrap";
  const TD = "py-2 pr-3 whitespace-nowrap";

  // Sort suppliers: ones with issues first, sorted by total impact
  const sortedResults = [...results].sort((a, b) => {
    const aErr = a.matched.filter(m => m.hasErr).length + a.unmatchedExcel.length + a.unmatchedPdf.length;
    const bErr = b.matched.filter(m => m.hasErr).length + b.unmatchedExcel.length + b.unmatchedPdf.length;
    if (aErr === 0 && bErr > 0) return 1;
    if (bErr === 0 && aErr > 0) return -1;
    const aImpact = a.matched.reduce((sum, m) => sum + issueImpact(m), 0);
    const bImpact = b.matched.reduce((sum, m) => sum + issueImpact(m), 0);
    return bImpact - aImpact;
  });

  return (
    <div>
      {/* ── YENİ 3 ANA KART (Blok 2) ─────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">

        {/* Kart 1: Fazla Ödeme */}
        <div className="bg-red-950/40 border border-red-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">💰</span>
            <Tooltip content={
              <>
                <div className="font-semibold mb-1">💰 Fazla Ödeme — Nasıl Hesaplanır?</div>
                <div className="text-[11px] space-y-1.5 text-gray-300">
                  <div>Yalnızca <strong className="text-red-300">ALEYHİNİZE</strong> olan durumlar toplanır:</div>
                  <div className="pl-2 space-y-0.5">
                    <div>• Fazla gelen miktar × sipariş fiyatı</div>
                    <div>• Yüksek kesilen fiyat × gelen miktar</div>
                    <div>• Yetkisiz teslim → tam tutar</div>
                  </div>
                  <div className="border-t border-gray-800 pt-1.5 text-gray-400">
                    Lehte fiyatlar <strong>düşülmez</strong> (brüt hesap).
                  </div>
                  <div className="text-red-300 italic">→ Tedarikçiye gösterilebilecek pazarlık rakamıdır.</div>
                </div>
              </>
            }>
              <p className="text-sm font-semibold text-red-300 uppercase tracking-wide cursor-help">Fazla Ödeme ⓘ</p>
            </Tooltip>
          </div>
          <p className="text-3xl font-extrabold text-red-400 mb-1">{fmt(stats.overpayment)} ₺</p>
          <p className="text-[11px] text-red-500/80 mb-3">Tedarikçiye gösterilebilecek brüt fazla ödeme rakamı</p>
          <div className="border-t border-red-900 pt-3 space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">🔴 Kritik kalem</span>
              <span className="font-medium text-red-300">{stats.criticalCount} kalem</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">🟡 Karma (incele)</span>
              <span className="font-medium text-yellow-300">{stats.mixedCount} kalem</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">⚪ Temiz</span>
              <span className="font-medium text-emerald-400">{stats.cleanCount} kalem</span>
            </div>
          </div>
        </div>

        {/* Kart 2: Teslimat Uyumsuzluğu */}
        <div className="bg-orange-950/40 border border-orange-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">📦</span>
            <p className="text-sm font-semibold text-orange-300 uppercase tracking-wide">Teslimat Uyumsuzluğu</p>
          </div>
          <p className="text-3xl font-extrabold text-orange-400 mb-1">{stats.deliveryMismatchCount} kalem</p>
          <p className="text-[11px] text-orange-500/80 mb-3">
            Risk değeri: <span className="font-semibold text-orange-300">{fmt(stats.deliveryMismatchValue)} ₺</span>
          </p>
          <div className="border-t border-orange-900 pt-3 space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">🟠 Eksik teslim</span>
              <span className="font-medium text-orange-300">{stats.operationalCount} kalem</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">📥 Yetkisiz teslimat</span>
              <span className="font-medium text-orange-300">{stats.unmatchedPdfCount} kalem</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">📭 Sipariş teslim yok</span>
              <span className="font-medium text-gray-400">{stats.unmatchedExcelCount} kalem</span>
            </div>
          </div>
          <p className="text-[10px] text-orange-600/70 mt-3 italic">⚠️ Enflasyon ortamında eksik teslim bir sonraki alımda zamlı fiyata dönebilir. Tedarikçi eğilimini izle.</p>
        </div>

        {/* Kart 3: Veri Şüphesi */}
        <div className="bg-purple-950/40 border border-purple-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">🔍</span>
            <p className="text-sm font-semibold text-purple-300 uppercase tracking-wide">Veri Şüphesi</p>
          </div>
          <p className="text-3xl font-extrabold text-purple-400 mb-1">{stats.dataSuspectCount} kalem</p>
          <p className="text-[11px] text-purple-500/80 mb-3">Miktar × fiyat ≠ toplam tutarsızlığı</p>
          <div className="border-t border-purple-900 pt-3 space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">🔵 Lehte fiyat</span>
              <span className="font-medium text-blue-300">{stats.infoCount} kalem</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">🟣 Matematik şüphesi</span>
              <span className="font-medium text-purple-300">{stats.suspiciousCount} kalem</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">🔢 Toplam tedarikçi</span>
              <span className="font-medium text-gray-300">{stats.suppCount}</span>
            </div>
          </div>
          <p className="text-[10px] text-purple-600/70 mt-3 italic">📌 İskonto, KDV veya parse hatası olabilir. Faturayı elden kontrol et.</p>
        </div>
      </div>

      <div className="flex items-center justify-between mb-5 gap-3">
        <h2 className="text-xl font-bold">Karşılaştırma Sonuçları</h2>
        <button onClick={onExport} className="bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold px-4 py-2 rounded-lg transition-colors whitespace-nowrap">📥 Excel Rapor</button>
      </div>

      <div className="space-y-3">
        {sortedResults.map(s => {
          const errCount = s.matched.filter((m: DiffResult) => m.hasErr).length + s.unmatchedExcel.length + s.unmatchedPdf.length;
          const isOpen = open.has(s.key);

          // Sort matched items: worst issues first, then by impact
          const sortedMatched = [...s.matched].sort((a, b) => {
            const pa = issuePriority(a);
            const pb = issuePriority(b);
            if (pa !== pb) return pb - pa;
            return issueImpact(b) - issueImpact(a);
          });

          return (
            <div key={s.key} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <button onClick={() => toggle(s.key)} className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-800 transition-colors text-left">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${errCount > 0 ? "bg-red-500" : "bg-emerald-500"}`} />
                  <span className="font-semibold truncate">{s.name}</span>
                  {!s.hasPdf && <span className="text-xs bg-orange-900 text-orange-300 px-2 py-0.5 rounded shrink-0">Tesellüm yok</span>}
                  {!s.hasOrders && <span className="text-xs bg-purple-900 text-purple-300 px-2 py-0.5 rounded shrink-0">Siparişte yok</span>}
                </div>
                <div className="flex items-center gap-3 ml-3 shrink-0">
                  <span className="text-xs text-gray-500 hidden sm:block">{s.matched.length} eşleşti · {errCount} sorun</span>
                  <span className="text-gray-600 text-sm">{isOpen ? "▲" : "▼"}</span>
                </div>
              </button>
              {isOpen && (
                <div className="px-5 pb-5 border-t border-gray-800 pt-4">
                  {s.matched.length > 0 && (
                    <div className="mb-5">
                      <p className="text-xs text-gray-500 uppercase tracking-widest mb-3">Eşleşen Kalemler</p>
                      <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
                        <table className="w-full text-xs min-w-max">
                          <thead className="sticky top-0 bg-gray-900 z-10">
                            <tr className="text-gray-400 border-b border-gray-700">
                              <th className={TH + " bg-gray-900"}>Durum</th>
                              <th className={TH + " bg-gray-900"}>Ürün</th>
                              <th className={TH + " bg-gray-900"} title="Sipariş miktarı / Gelen miktar">⚖️ Miktar (Sip/Gel)</th>
                              <th className={TH + " bg-gray-900"} title="Sipariş birim fiyatı / Kesilen birim fiyat">🏷️ Fiyat (Sip/Gel)</th>
                              <th className={TH + " bg-gray-900"} title="Miktar farkının TL karşılığı — yön önemli">₺ Mik.Fark</th>
                              <th className={TH + " bg-gray-900"} title="Fiyat farkının TL karşılığı — yön önemli">₺ Fiy.Fark</th>
                              <th className={TH + " bg-gray-900"} title="Sipariş toplamı / Fatura toplamı">🧮 Toplam (Sip/Gel)</th>
                              <th className={TH + " bg-gray-900"} title="Bu satır için brüt fazla ödeme — sadece aleyhte">💰 Fazla Ödeme</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedMatched.map((m: DiffResult, i: number) => {
                              const t = getIssueType(m);
                              const badge = issueBadge(t);
                              // Yön renkleri
                              const qtyColor = m.qtyDir === "over" ? "text-red-400" : m.qtyDir === "short" ? "text-orange-400" : "text-gray-500";
                              const priceColor = m.priceDir === "high" ? "text-red-400" : m.priceDir === "low" ? "text-blue-400" : "text-gray-500";
                              const qtyArrow = m.qtyDir === "over" ? "▲" : m.qtyDir === "short" ? "▼" : "";
                              const priceArrow = m.priceDir === "high" ? "▲" : m.priceDir === "low" ? "▼" : "";
                              // Miktar farkı TL: + fazla geldi (aleyh), - eksik geldi (lehe/risk)
                              const mFarkTL = m.qtyDir === "over" ? Math.abs(m.mB) * m.order.birimFiyat : m.qtyDir === "short" ? -(m.mB * m.order.birimFiyat) : 0;
                              // Fiyat farkı TL: + yüksek kesildi (aleyh), - düşük kesildi (lehe)
                              const fFarkTL = m.fB * m.receipt.miktar;
                              return (
                                <tr key={i} className={`border-b border-gray-800/50 ${t === "critical" ? "bg-red-950/30" : t === "mixed" ? "bg-yellow-950/20" : t === "operational" ? "bg-orange-950/20" : t === "suspicious" ? "bg-purple-950/20" : t === "info" ? "bg-blue-950/10" : ""}`}>
                                  <td className={TD}>
                                    <Tooltip content={
                                      <>
                                        <div className="font-semibold mb-1">{badge.icon} {badge.label}</div>
                                        <div className="text-gray-400 mb-2">{badge.title}</div>
                                        <div className="border-t border-gray-800 pt-2 text-[11px] space-y-1">
                                          {t === "critical" && (
                                            <>
                                              <div className="text-red-300">❗ Aleyhinizde bir durum tespit edildi:</div>
                                              {m.qtyDir === "over" && <div>▲ Sipariş ettiğinizden fazla miktar geldi</div>}
                                              {m.priceDir === "high" && <div>▲ Anlaştığınızdan yüksek fiyat kesildi</div>}
                                              {m.qtyDir === "short" && m.priceDir === "high" && <div>▼ Eksik geldi + ▲ yüksek fiyat (fiyat kısmı aleyhe)</div>}
                                              <div className="text-red-400 mt-1">→ Tedarikçiyle görüşülmeli.</div>
                                            </>
                                          )}
                                          {t === "mixed" && (
                                            <>
                                              <div>Çelişkili sinyal: fazla mal geldi ama düşük fiyattan kesildi.</div>
                                              <div className="text-yellow-400 mt-1">→ Manuel incele: istenmemiş mal kabul mü edilsin?</div>
                                            </>
                                          )}
                                          {t === "operational" && (
                                            <>
                                              <div>Sipariş ettiğiniz miktardan eksik geldi.</div>
                                              <div className="text-orange-400 mt-1">⚠️ Enflasyon riski: tekrar alım gerekirse zamlı fiyat olabilir.</div>
                                            </>
                                          )}
                                          {t === "suspicious" && (
                                            <>
                                              <div>Miktar × Fiyat ≠ Fatura Toplamı</div>
                                              <div className="text-purple-400 mt-1">→ İskonto, KDV veya parse hatası olabilir — faturayı kontrol et.</div>
                                            </>
                                          )}
                                          {t === "info" && (
                                            <>
                                              <div>Tedarikçi anlaştığınızdan düşük fiyat kesmiş.</div>
                                              <div className="text-blue-400 mt-1">→ Zarar değil, bilgi için. Dikkat: sonradan fark talep edebilir.</div>
                                            </>
                                          )}
                                          {t === "clean" && <div className="text-emerald-400">Sorunsuz — sipariş ve tesellüm birebir eşleşiyor.</div>}
                                        </div>
                                      </>
                                    }>
                                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${badge.className}`}>
                                        {badge.icon} {badge.label}
                                      </span>
                                    </Tooltip>
                                  </td>
                                  <td className={TD}><span className="font-medium">{m.order.stokAdi}</span></td>
                                  {/* Miktar sütunu: Sip/Gel */}
                                  <td className={TD}>
                                    <Tooltip content={
                                      <>
                                        <div className="font-semibold mb-1">⚖️ Miktar Karşılaştırması</div>
                                        <div className="space-y-1 text-[11px]">
                                          <div>📋 Sipariş: <span className="font-mono">{fmt(m.order.miktar, 3)} {m.order.birim}</span></div>
                                          <div>📦 Gelen: <span className="font-mono">{fmt(m.receipt.miktar, 3)} {m.order.birim}</span></div>
                                          <div className="border-t border-gray-800 pt-1.5 mt-1.5">
                                            {m.qtyDir === "over" && <div className="text-red-400">▲ <strong>{fmt(Math.abs(m.mB), 3)} {m.order.birim}</strong> FAZLA geldi<br />Anlaşılan fiyatta değeri: <strong>{fmt(Math.abs(m.mB) * m.order.birimFiyat)} ₺</strong></div>}
                                            {m.qtyDir === "short" && <div className="text-orange-400">▼ <strong>{fmt(m.mB, 3)} {m.order.birim}</strong> EKSİK geldi<br />Risk değeri: <strong>{fmt(m.mB * m.order.birimFiyat)} ₺</strong></div>}
                                            {m.qtyDir === "exact" && <div className="text-emerald-400">✓ Miktar doğru eşleşiyor</div>}
                                          </div>
                                        </div>
                                      </>
                                    }>
                                      <span>
                                        <span className="text-gray-400">{fmt(m.order.miktar, 2)} {m.order.birim}</span>
                                        {m.qtyDir !== "exact" && <>
                                          <span className="text-gray-600 mx-1">/</span>
                                          <span className={`font-semibold ${qtyColor}`}>{fmt(m.receipt.miktar, 2)} {qtyArrow}</span>
                                        </>}
                                        {m.qtyDir === "exact" && <span className="text-gray-600 ml-1">/ ⚪</span>}
                                      </span>
                                    </Tooltip>
                                  </td>
                                  {/* Fiyat sütunu: Sip/Gel */}
                                  <td className={TD}>
                                    <Tooltip content={
                                      <>
                                        <div className="font-semibold mb-1">🏷️ Fiyat Karşılaştırması</div>
                                        <div className="space-y-1 text-[11px]">
                                          <div>📋 Sipariş fiyatı: <span className="font-mono">{fmt(m.order.birimFiyat)} ₺/{m.order.birim}</span></div>
                                          <div>🧾 Kesilen fiyat: <span className="font-mono">{fmt(m.receipt.netBFiyat)} ₺/{m.order.birim}</span></div>
                                          <div className="border-t border-gray-800 pt-1.5 mt-1.5">
                                            {m.priceDir === "high" && <div className="text-red-400">▲ <strong>{fmt(m.fB)} ₺/{m.order.birim}</strong> YÜKSEK kesildi<br />{fmt(m.receipt.miktar, 2)} × {fmt(m.fB)} = <strong>{fmt(m.fB * m.receipt.miktar)} ₺</strong> fazla ödeme</div>}
                                            {m.priceDir === "low" && <div className="text-blue-400">▼ <strong>{fmt(Math.abs(m.fB))} ₺/{m.order.birim}</strong> DÜŞÜK kesildi<br />Lehte: <strong>{fmt(Math.abs(m.fB) * m.receipt.miktar)} ₺</strong> (bilgi — zarar değil)</div>}
                                            {m.priceDir === "same" && <div className="text-emerald-400">✓ Fiyat doğru</div>}
                                          </div>
                                        </div>
                                      </>
                                    }>
                                      <span>
                                        <span className="text-gray-400">{fmt(m.order.birimFiyat)} ₺</span>
                                        {m.priceDir !== "same" && <>
                                          <span className="text-gray-600 mx-1">/</span>
                                          <span className={`font-semibold ${priceColor}`}>{fmt(m.receipt.netBFiyat)} ₺ {priceArrow}</span>
                                        </>}
                                        {m.priceDir === "same" && <span className="text-gray-600 ml-1">/ ⚪</span>}
                                      </span>
                                    </Tooltip>
                                  </td>
                                  {/* Miktar farkı TL */}
                                  <td className={TD + " font-mono"}>
                                    <Tooltip content={
                                      <>
                                        <div className="font-semibold mb-1">₺ Miktar Farkı</div>
                                        <div className="text-[11px] space-y-1">
                                          <div>Formül: <span className="font-mono">|Miktar Farkı| × Sipariş Fiyatı</span></div>
                                          <div className="border-t border-gray-800 pt-1.5">
                                            <span className="font-mono">{fmt(Math.abs(m.mB), 3)} {m.order.birim} × {fmt(m.order.birimFiyat)} ₺ = <strong>{fmt(Math.abs(mFarkTL))} ₺</strong></span>
                                          </div>
                                          {m.qtyDir === "over" && <div className="text-red-400 mt-1">🔴 Fazla miktar → Fazla Ödeme'ye eklendi.</div>}
                                          {m.qtyDir === "short" && <div className="text-orange-400 mt-1">🟠 Eksik miktar → Fazla Ödeme'ye dahil edilmedi, risk metriğine girdi.</div>}
                                        </div>
                                      </>
                                    }>
                                      <span>
                                        {m.qtyDir === "over" && <span className="text-red-400">+{fmt(mFarkTL)} ₺</span>}
                                        {m.qtyDir === "short" && <span className="text-orange-400/70">{fmt(mFarkTL)} ₺</span>}
                                        {m.qtyDir === "exact" && <span className="text-gray-700">—</span>}
                                      </span>
                                    </Tooltip>
                                  </td>
                                  {/* Fiyat farkı TL */}
                                  <td className={TD + " font-mono"}>
                                    <Tooltip content={
                                      <>
                                        <div className="font-semibold mb-1">₺ Fiyat Farkı</div>
                                        <div className="text-[11px] space-y-1">
                                          <div>Formül: <span className="font-mono">Birim Fiyat Farkı × Gelen Miktar</span></div>
                                          <div className="border-t border-gray-800 pt-1.5">
                                            <span className="font-mono">{fmtS(m.fB)} ₺/{m.order.birim} × {fmt(m.receipt.miktar, 2)} {m.order.birim} = <strong>{fmtS(fFarkTL)} ₺</strong></span>
                                          </div>
                                          {m.priceDir === "high" && <div className="text-red-400 mt-1">🔴 Yüksek fiyat → Fazla Ödeme'ye eklendi.</div>}
                                          {m.priceDir === "low" && <div className="text-blue-400 mt-1">🔵 Düşük fiyat → Lehte bilgi, hesaba dahil edilmedi.</div>}
                                        </div>
                                      </>
                                    }>
                                      <span>
                                        {m.priceDir === "high" && <span className="text-red-400">+{fmt(fFarkTL)} ₺</span>}
                                        {m.priceDir === "low" && <span className="text-blue-400">{fmt(fFarkTL)} ₺</span>}
                                        {m.priceDir === "same" && <span className="text-gray-700">—</span>}
                                      </span>
                                    </Tooltip>
                                  </td>
                                  {/* Toplam Sip/Gel */}
                                  <td className={TD + " text-gray-500"}>
                                    {fmt(m.excelToplam)} / <span className={m.hasTotalErr ? "text-red-400/60" : ""}>{fmt(m.pdfToplam)}</span>
                                  </td>
                                  {/* Fazla Ödeme */}
                                  <td className={TD + " font-mono font-bold"}>
                                    <Tooltip content={
                                      <>
                                        <div className="font-semibold mb-1">💰 Fazla Ödeme (Brüt)</div>
                                        {m.overpayment > 0.01 ? (
                                          <div className="text-[11px] space-y-1">
                                            <div className="text-gray-400">Bu satırdaki brüt fazla ödeme:</div>
                                            {m.qtyDir === "over" && <div>• Fazla miktar: <span className="font-mono">{fmt(Math.abs(m.mB), 3)} × {fmt(m.order.birimFiyat)} = {fmt(Math.abs(m.mB) * m.order.birimFiyat)} ₺</span></div>}
                                            {m.priceDir === "high" && <div>• Yüksek fiyat: <span className="font-mono">{fmt(m.fB)} × {fmt(m.receipt.miktar, 2)} = {fmt(m.fB * m.receipt.miktar)} ₺</span></div>}
                                            <div className="border-t border-gray-800 pt-1.5 text-red-300">
                                              💸 Toplam: <strong>{fmt(m.overpayment)} ₺</strong>
                                            </div>
                                            <div className="text-gray-500 italic mt-1">Bu rakamı tedarikçiye gösterebilirsin.</div>
                                          </div>
                                        ) : m.priceDir === "low" ? (
                                          <div className="text-[11px] text-blue-300">Lehte durum — fazla ödeme yok. Bilgi amaçlı not edildi.</div>
                                        ) : (
                                          <div className="text-[11px] text-emerald-400">Sorunsuz — fazla ödeme yok.</div>
                                        )}
                                      </>
                                    }>
                                      <span>
                                        {m.overpayment > 0.01
                                          ? <span className="text-red-400">💸 {fmt(m.overpayment)} ₺</span>
                                          : m.priceDir === "low"
                                            ? <span className="text-blue-400/70 text-[10px]">🔵 lehte</span>
                                            : <span className="text-gray-700">—</span>
                                        }
                                      </span>
                                    </Tooltip>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      {/* Enflasyon notu — OPR/OPERASYONEL etiketli kalemler için */}
                      {sortedMatched.some((m: DiffResult) => getIssueType(m) === "operational") && (
                        <div className="mt-3 flex items-start gap-2 bg-orange-950/20 border border-orange-900/50 rounded-lg px-3 py-2 text-xs text-orange-400/80">
                          <span>⚠️</span>
                          <span><strong>Enflasyon Riski:</strong> Eksik teslimat olan kalemleri tekrar alman gerekirse zamlı fiyattan almak zorunda kalabilirsin. Tedarikçi eğilimini ve piyasayı izle.</span>
                        </div>
                      )}
                    </div>
                  )}
                  {s.unmatchedExcel.length > 0 && (
                    <div className="mb-4">
                      <p className="text-xs text-orange-400 uppercase tracking-widest mb-2">⚠ Siparişte Var, Tesellümde Yok</p>
                      <div className="space-y-1.5">
                        {s.unmatchedExcel.map((o: OrderItem, i: number) => (
                          <div key={i} className="flex justify-between items-center bg-orange-950/30 border border-orange-900 rounded-lg px-3 py-2 text-xs">
                            <span className="font-medium">{o.stokAdi}</span>
                            <span className="text-orange-300 ml-3 whitespace-nowrap">{fmt(o.miktar, 3)} {o.birim} · {fmt(o.birimFiyat)} ₺</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {s.unmatchedPdf.length > 0 && (
                    <div>
                      <p className="text-xs text-purple-400 uppercase tracking-widest mb-2">🚨 Yetkisiz Teslimat (Siparişte Yok)</p>
                      <div className="space-y-1.5">
                        {s.unmatchedPdf.map((r: ReceiptItem, i: number) => (
                          <div key={i} className="flex justify-between items-center bg-purple-950/30 border border-purple-900 rounded-lg px-3 py-2 text-xs">
                            <span className="font-medium">{r.stokAdi}</span>
                            <span className="text-purple-300 ml-3 whitespace-nowrap">{fmt(r.miktar, 3)} {r.birim} · {fmt(r.netBFiyat)} ₺ · Top: {fmt(r.toplam)} ₺</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────
export default function Page() {
  const [screen, setScreen] = useState<string>("upload");
  const [loading, setLoading] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<(string | number)[][]>([]);
  const [colMap, setColMap] = useState<Record<string, string>>({ stokAdi: "", tedarikci: "", miktar: "", birim: "", birimFiyat: "" });
  const [excelSupps, setExcelSupps] = useState<string[]>([]);
  const [pdfParsed, setPdfParsed] = useState<ParsedPDF[]>([]);
  const [results, setResults] = useState<SuppResult[] | null>(null);
  const [pending, setPending] = useState<PendingMatch[]>([]);
  const [pIdx, setPIdx] = useState<number>(0);
  const [savedMappings, setSavedMappings] = useState<Record<string, string>>({});
  const [pdfReady, setPdfReady] = useState<boolean>(false);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    if (typeof window !== "undefined" && w.pdfjsLib) {
      setTimeout(() => setPdfReady(true), 0);
    } else if (typeof document !== "undefined") {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = () => {
        if (w.pdfjsLib) {
          w.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
          setPdfReady(true);
        }
      };
      document.head.appendChild(s);
    }
    loadMappings().then(setSavedMappings);
  }, []);

  const readExcel = (file: File) => {
    setExcelFile(file);
    const r = new FileReader();
    r.onload = (e: ProgressEvent<FileReader>) => {
      const res = e.target?.result;
      if (!res) return;
      const wb = XLSX.read(res, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0] ?? ""];
      if (!ws) return;
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as (string | number)[][];
      const rawHdrs = (data[0] ?? []).map(String);
      const hdrs = Array.from(new Set(rawHdrs.filter(h => h.trim() !== "")));
      setHeaders(hdrs);
      setRawRows(data.slice(1).filter(r => r.some(c => c !== "")));
      const auto = { stokAdi: "", tedarikci: "", miktar: "", birim: "", birimFiyat: "" };
      for (const h of hdrs) {
        const n = norm(h);
        if (!auto.stokAdi && n.includes("STOK")) auto.stokAdi = h;
        if (!auto.tedarikci && (n === "NOTLAR" || n.includes("TEDAR"))) auto.tedarikci = h;
        if (!auto.miktar && (n === "MİKTAR" || n === "MIKTAR")) auto.miktar = h;
        if (!auto.birim && (n === "BİRİM" || n === "BIRIM")) auto.birim = h;
        if (!auto.birimFiyat && n.includes("BIRIM") && n.includes("FIYAT")) auto.birimFiyat = h;
        if (!auto.birimFiyat && n.includes("BİRİM") && n.includes("FİYAT")) auto.birimFiyat = h;
      }
      setColMap(auto);
    };
    r.readAsArrayBuffer(file);
  };

  const buildOrders = (): OrderItem[] => {
    const [si, ti, mi, bi, fi] = ["stokAdi", "tedarikci", "miktar", "birim", "birimFiyat"].map(k => headers.indexOf(colMap[k] ?? ""));
    return rawRows.map((row, id) => ({
      id,
      stokAdi: String(row[si!] ?? "").trim(),
      tedarikci: String(row[ti!] ?? "").trim(),
      miktar: parseNum(row[mi!]),
      birim: String(row[bi!] ?? "").trim(),
      birimFiyat: parseNum(row[fi!])
    })).filter(o => o.stokAdi && o.tedarikci && o.miktar > 0);
  };

  const finalize = (parsedPdfs: ParsedPDF[], orderItems: OrderItem[]) => {
    const { suppResults, pendingM } = runComparison(orderItems, parsedPdfs, savedMappings);
    setResults(suppResults);
    if (pendingM.length > 0) { setPending(pendingM); setPIdx(0); setScreen("matching"); }
    else setScreen("results");
  };

  const handleProcess = async () => {
    if (!Object.values(colMap).every(v => v)) { setErr("Tüm sütunları doldurun."); return; }
    if (!pdfReady) { setErr("PDF motoru henüz yüklenmedi, 2 sn bekleyin."); return; }
    setErr(""); setLoading("PDF'ler işleniyor...");
    try {
      const orders = buildOrders();
      if (orders.length === 0) { setLoading(""); setErr("Excel'den sipariş kalemi okunamadı."); return; }
      const supps = Array.from(new Set(orders.map(o => o.tedarikci)));
      setExcelSupps(supps);
      const parsed: ParsedPDF[] = [];
      for (const f of pdfFiles) {
        setLoading("Okunuyor: " + f.name);
        const result = await parsePDF(f);
        const match = supps.find(s => suppMatch(s, result.tedarikci));
        parsed.push({ fileName: f.name, detected: result.tedarikci, assigned: match ?? "", items: result.items, warnings: result.warnings });
      }
      setLoading("");
      setPdfParsed(parsed);
      setScreen("supplierAssign");
    } catch (errObj: unknown) {
      setLoading("");
      setErr("Hata: " + (errObj instanceof Error ? errObj.message : String(errObj)));
    }
  };

  const applyManual = async () => {
    if (!results) return;
    const upd = results.map(s => ({ ...s, matched: [...s.matched], unmatchedExcel: [...s.unmatchedExcel], unmatchedPdf: [...s.unmatchedPdf] }));
    const newMappings = { ...savedMappings };
    for (const p of pending) {
      if (!p.choice || p.choice === "skip") continue;
      const si = upd.findIndex(s => s.key === p.suppKey); if (si === -1) continue;
      const s = upd[si]!;
      const ri = s.unmatchedPdf.findIndex((r: ReceiptItem) => norm(r.stokAdi) === norm(p.choice));
      const oi = s.unmatchedExcel.findIndex((o: OrderItem) => o.id === p.order.id);
      if (ri !== -1 && oi !== -1) {
        const receipt = s.unmatchedPdf.splice(ri, 1)[0]!;
        s.unmatchedExcel.splice(oi, 1);
        s.matched.push(buildDiff(p.order, receipt));
        newMappings[norm(p.order.stokAdi)] = norm(p.choice);
      }
    }
    setResults(upd);
    setSavedMappings(newMappings);
    await saveMappings(newMappings);
    setScreen("results");
  };

  const exportReport = () => {
    if (!results || !stats) return;
    // Özet sayfası
    const summary: (string | number)[][] = [
      ["LONGOKONTROL — RAPOR ÖZETİ", "", ""],
      ["Tarih", new Date().toLocaleDateString("tr-TR"), ""],
      ["", "", ""],
      ["💰 FAZLA ÖDEME (BRÜT)", stats.overpayment, "₺"],
      ["📦 Teslimat Uyumsuzluğu", stats.deliveryMismatchCount, "kalem"],
      ["📦 Teslimat Risk Değeri", stats.deliveryMismatchValue, "₺"],
      ["🔍 Veri Şüphesi", stats.dataSuspectCount, "kalem"],
      ["", "", ""],
      ["🔴 Kritik kalem", stats.criticalCount, ""],
      ["🟡 Karma kalem", stats.mixedCount, ""],
      ["🟠 Operasyonel (eksik)", stats.operationalCount, ""],
      ["🔵 Bilgi (lehte)", stats.infoCount, ""],
      ["⚪ Temiz kalem", stats.cleanCount, ""],
      ["🟣 Şüphe (matematik)", stats.suspiciousCount, ""],
    ];
    // Detay sayfası
    const data: (string | number)[][] = [[
      "Tedarikçi", "Ürün", "Durum",
      "Sip.Miktar", "Gel.Miktar", "Birim", "Miktar Yönü",
      "Sip.Fiyat", "Gel.Fiyat", "Fiyat Yönü",
      "💰 Fazla Ödeme (₺)", "Sip.Toplam", "Gel.Toplam", "Not"
    ]];
    for (const s of results) {
      for (const m of s.matched) {
        const t = getIssueType(m);
        const badge = issueBadge(t);
        const notes: string[] = [];
        if (m.qtyDir === "over") notes.push("FAZLA MİKTAR");
        if (m.qtyDir === "short") notes.push("EKSİK TESLİM");
        if (m.priceDir === "high") notes.push("YÜKSEK FİYAT");
        if (m.priceDir === "low") notes.push("DÜŞÜK FİYAT");
        if (m.mathMismatch) notes.push("ŞÜPHE");
        data.push([
          s.name, m.order.stokAdi, badge.label,
          m.order.miktar, m.receipt.miktar, m.order.birim, m.qtyDir === "over" ? "▲ Fazla" : m.qtyDir === "short" ? "▼ Eksik" : "✓ Doğru",
          m.order.birimFiyat, m.receipt.netBFiyat, m.priceDir === "high" ? "▲ Yüksek" : m.priceDir === "low" ? "▼ Düşük" : "✓ Aynı",
          m.overpayment, m.excelToplam, m.pdfToplam, notes.join(" + "),
        ]);
      }
      for (const o of s.unmatchedExcel) {
        data.push([s.name, o.stokAdi, "📭 TESLİMAT YOK", o.miktar, 0, o.birim, "▼ Eksik", o.birimFiyat, 0, "—", 0, o.miktar * o.birimFiyat, 0, "Sipariş edildi, tesellüm yok"]);
      }
      for (const r of s.unmatchedPdf) {
        data.push([s.name, r.stokAdi, "🚨 YETKİSİZ", 0, r.miktar, r.birim, "▲ Yetkisiz", 0, r.netBFiyat, "—", r.toplam, 0, r.toplam, "Siparişte yok — tam fazla ödeme"]);
      }
    }

    const wb2 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(summary), "Özet");
    XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(data), "Detay");

    // ── Blok 3: Her tedarikçi için AKSİYON ŞABLONU sayfası ──
    // Sadece sorunu olan tedarikçiler için oluşturulur. Sayfa adı: "Aksiyon-<Tedarikçi>"
    const tarihStr = new Date().toLocaleDateString("tr-TR");
    for (const s of results) {
      const criticalItems = s.matched.filter(m => {
        const t = getIssueType(m);
        return t === "critical" || t === "mixed";
      });
      const suspiciousItems = s.matched.filter(m => getIssueType(m) === "suspicious");
      const operationalItems = s.matched.filter(m => getIssueType(m) === "operational");
      const unauth = s.unmatchedPdf;
      const missing = s.unmatchedExcel;

      const hasAnyIssue = criticalItems.length > 0 || unauth.length > 0 || operationalItems.length > 0 || suspiciousItems.length > 0 || missing.length > 0;
      if (!hasAnyIssue) continue;

      const totalOverpay = s.matched.reduce((sum, m) => sum + m.overpayment, 0) +
        unauth.reduce((sum, r) => sum + r.toplam, 0);

      const action: (string | number)[][] = [];
      action.push([`TEDARİKÇİ AKSİYON ŞABLONU — ${s.name}`]);
      action.push([`Tarih: ${tarihStr}`]);
      action.push([""]);
      action.push(["Sayın Yetkili,"]);
      action.push([""]);
      action.push(["Son tesellüm fişiniz üzerinde yaptığımız kontrollerde aşağıdaki uyuşmazlıklar tespit edilmiştir."]);
      action.push(["Gerekli düzeltmelerin (iade faturası / bir sonraki siparişte mahsup / açıklama) yapılmasını rica ederiz."]);
      action.push([""]);

      if (criticalItems.length > 0) {
        action.push(["🔴 FAZLA ÖDEME — İADE TALEBİ"]);
        action.push(["#", "Ürün", "Sipariş", "Kesilen", "Fazla Ödeme (₺)", "Açıklama"]);
        criticalItems.forEach((m, i) => {
          const aciklama = [];
          if (m.qtyDir === "over") aciklama.push(`${fmt(Math.abs(m.mB), 2)} ${m.order.birim} FAZLA teslim`);
          if (m.priceDir === "high") aciklama.push(`${fmt(m.fB)} ₺/${m.order.birim} YÜKSEK fiyat`);
          action.push([
            i + 1,
            m.order.stokAdi,
            `${fmt(m.order.miktar, 2)} ${m.order.birim} × ${fmt(m.order.birimFiyat)} ₺`,
            `${fmt(m.receipt.miktar, 2)} ${m.order.birim} × ${fmt(m.receipt.netBFiyat)} ₺`,
            m.overpayment,
            aciklama.join(" + "),
          ]);
        });
        action.push([""]);
      }

      if (unauth.length > 0) {
        action.push(["🚨 YETKİSİZ TESLİMAT — SİPARİŞİMİZDE YOK"]);
        action.push(["#", "Ürün", "Miktar", "Fiyat", "Toplam (₺)", "Açıklama"]);
        unauth.forEach((r, i) => {
          action.push([i + 1, r.stokAdi, `${fmt(r.miktar, 2)} ${r.birim}`, fmt(r.netBFiyat), r.toplam, "Sipariş listemizde bu kalem yok"]);
        });
        action.push([""]);
      }

      if (missing.length > 0) {
        action.push(["📭 EKSİK TESLİMAT — SİPARİŞİMİZDE VAR AMA TESELLÜM YOK"]);
        action.push(["#", "Ürün", "Sipariş Miktarı", "Birim Fiyat", "Değer (₺)"]);
        missing.forEach((o, i) => {
          action.push([i + 1, o.stokAdi, `${fmt(o.miktar, 2)} ${o.birim}`, fmt(o.birimFiyat), o.miktar * o.birimFiyat]);
        });
        action.push([""]);
      }

      if (operationalItems.length > 0) {
        action.push(["🟠 EKSİK MİKTAR — TAMAMLAYICI TESLİMAT TALEBİ"]);
        action.push(["#", "Ürün", "Sipariş", "Gelen", "Eksik"]);
        operationalItems.forEach((m, i) => {
          action.push([i + 1, m.order.stokAdi, `${fmt(m.order.miktar, 2)} ${m.order.birim}`, `${fmt(m.receipt.miktar, 2)} ${m.order.birim}`, `${fmt(m.mB, 2)} ${m.order.birim}`]);
        });
        action.push([""]);
      }

      if (suspiciousItems.length > 0) {
        action.push(["🟣 MATEMATİK TUTARSIZLIĞI — AÇIKLAMA TALEBİ"]);
        action.push(["#", "Ürün", "Beklenen Toplam", "Fatura Toplamı", "Fark"]);
        suspiciousItems.forEach((m, i) => {
          action.push([i + 1, m.order.stokAdi, m.expectedPdfToplam, m.pdfToplam, m.expectedPdfToplam - m.pdfToplam]);
        });
        action.push([""]);
      }

      action.push([""]);
      action.push(["💰 TOPLAM TALEP (FAZLA ÖDEME):", totalOverpay, "₺"]);
      action.push([""]);
      action.push(["Saygılarımızla,"]);
      action.push(["Longosphere Glamping — Cost Control"]);

      // Sheet adı max 31 karakter, özel karakter yasak
      let sheetName = `Aksiyon-${s.name.substring(0, 22)}`.replace(/[\\/\?\*\[\]:]/g, "");
      if (sheetName.length > 31) sheetName = sheetName.substring(0, 31);
      XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(action), sheetName);
    }

    XLSX.writeFile(wb2, "LongoKontrol_Rapor_" + new Date().toISOString().slice(0, 10) + ".xlsx");
  };

  const reset = () => { setScreen("upload"); setExcelFile(null); setPdfFiles([]); setResults(null); setErr(""); setPending([]); setPIdx(0); };

  const stats: StatsData | null = results ? (() => {
    // Blok 3: Eski karmaşık tipoloji hesapları temizlendi
    let okCount = 0;
    let errCount = 0;

    // ── YENİ (Blok 1) metrikler ──
    let overpayment = 0;               // TL — brüt fazla ödeme
    let deliveryMismatchCount = 0;     // Adet — eksik/fazla/yetkisiz
    let deliveryMismatchValue = 0;     // TL — risk göstergesi
    let dataSuspectCount = 0;          // Adet — matematik tutarsızlığı
    let criticalCount = 0, mixedCount = 0, operationalCount = 0;
    let suspiciousCount = 0, infoCount = 0, cleanCount = 0;
    let unmatchedExcelCount = 0, unmatchedPdfCount = 0;

    for (const s of results) {
      for (const m of s.matched) {
        // ── Yeni metrikler ──
        overpayment += m.overpayment;
        const t = getIssueType(m);

        if (t === "critical") criticalCount++;
        else if (t === "mixed") mixedCount++;
        else if (t === "operational") {
          operationalCount++;
          deliveryMismatchCount++;
          // Risk değeri: eksik kısmın TL karşılığı (ödenen değil, alınamayan)
          if (m.qtyDir === "short") {
            deliveryMismatchValue += Math.abs(m.mB) * m.order.birimFiyat;
          }
        }
        else if (t === "suspicious") { suspiciousCount++; dataSuspectCount++; }
        else if (t === "info") infoCount++;
        else cleanCount++;

        // ── errCount / okCount (tedarikçi kart dotları için hâlâ lazım) ──
        if (!m.hasErr) { okCount++; continue; }
        errCount++;
      }

      // ── Unmatched sayımlar ──
      unmatchedExcelCount += s.unmatchedExcel.length;
      unmatchedPdfCount += s.unmatchedPdf.length;
      errCount += s.unmatchedExcel.length + s.unmatchedPdf.length;

      // Siparişte var, tesellümde yok → risk altındaki değer
      for (const o of s.unmatchedExcel) {
        deliveryMismatchCount++;
        deliveryMismatchValue += o.miktar * o.birimFiyat;
      }

      // ── KRİTİK BUG FIX (Blok 1) ──
      // Yetkisiz teslimat (siparişte yok, PDF'de var):
      // Bunu ödeyeceğiz → overpayment'e EKLENMELİ
      for (const r of s.unmatchedPdf) {
        deliveryMismatchCount++;
        deliveryMismatchValue += r.toplam;
        overpayment += r.toplam; // İstemediğimiz mal → %100 aleyhte fazla ödeme
      }
    }

    return {
      suppCount: results.length,
      errCount, okCount,
      overpayment,
      deliveryMismatchCount,
      deliveryMismatchValue,
      dataSuspectCount,
      criticalCount, mixedCount, operationalCount, suspiciousCount, infoCount, cleanCount,
      unmatchedExcelCount, unmatchedPdfCount,
    };
  })() : null;

  if (loading) return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center gap-4">
      <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      <p className="text-white text-sm">{loading}</p>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-950 text-white" style={{ fontFamily: "system-ui,sans-serif" }}>
      <header className="bg-gray-900 border-b border-gray-800 px-5 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 bg-emerald-500 rounded-md flex items-center justify-center font-bold text-black text-xs">LK</div>
          <span className="font-bold">LongoKontrol</span>
          <span className="text-xs text-gray-600 hidden sm:block">Tesellüm Kontrolü</span>
        </div>
        {screen !== "upload" && <button onClick={reset} className="text-xs text-gray-400 hover:text-white border border-gray-700 px-3 py-1.5 rounded-lg transition-colors">↩ Yeni</button>}
      </header>
      <main className="max-w-6xl mx-auto px-4 py-8">
        {screen === "upload" && <UploadScreen excelFile={excelFile} pdfFiles={pdfFiles} onExcel={readExcel} onAddPdfs={fs => setPdfFiles(p => [...p, ...fs])} onRemovePdf={i => setPdfFiles(p => p.filter((_, idx) => idx !== i))} onNext={() => { if (!excelFile || !pdfFiles.length) { setErr("Excel ve en az 1 PDF yükleyin."); return; } setErr(""); setScreen("mapping"); }} err={err} />}
        {screen === "mapping" && <MappingScreen headers={headers} colMap={colMap} onChange={setColMap} onBack={() => setScreen("upload")} onNext={handleProcess} err={err} />}
        {screen === "supplierAssign" && <SupplierAssignScreen pdfParsed={pdfParsed} excelSupps={excelSupps} onChange={(i, v) => { const u = [...pdfParsed]; u[i] = { ...u[i]!, assigned: v }; setPdfParsed(u); }} onBack={() => setScreen("mapping")} onNext={() => { if (pdfParsed.some(p => !p.assigned)) { setErr("Tüm PDF'leri atayın."); return; } setErr(""); setScreen("rawPreview"); }} err={err} />}
        {screen === "rawPreview" && <RawPreviewScreen pdfParsed={pdfParsed} onBack={() => setScreen("supplierAssign")} onNext={() => finalize(pdfParsed, buildOrders())} />}
        {screen === "matching" && <MatchingScreen pending={pending} pIdx={pIdx} onChange={c => { const u = [...pending]; u[pIdx] = { ...u[pIdx]!, choice: c }; setPending(u); }} onPrev={() => setPIdx(i => Math.max(0, i - 1))} onNext={() => { if (pIdx < pending.length - 1) setPIdx(i => i + 1); else applyManual(); }} isLast={pIdx === pending.length - 1} />}
        {screen === "results" && results && stats && <ResultsScreen results={results} stats={stats} onExport={exportReport} />}
      </main>
    </div>
  );
}