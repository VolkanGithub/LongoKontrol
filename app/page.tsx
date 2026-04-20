'use client';
import { useState, useEffect } from "react";
import * as XLSX from "xlsx";

// ── Veri Şablonları (Gümrük Memurları) ─────────────────────────────
export interface OrderItem {
  id: number;
  stokAdi: string;
  tedarikci: string;
  miktar: number;
  birim: string;
  sonAlisFiyati: number;
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
}

export interface DiffResult {
  order: OrderItem;
  receipt: ReceiptItem;
  mB: number; mT: number; fB: number; fT: number; tT: number;
  excelToplam: number; pdfToplam: number; expectedPdfToplam: number;
  hasQtyErr: boolean; hasPriceErr: boolean; hasTotalErr: boolean;
  mathMismatch: boolean; hasErr: boolean;
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
  impact: number;
}

interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  w: number;
}

// ── Dış Dünyayı Tanıtma (Next.js için) ─────────────────────────────
declare global {
  interface Window {
    pdfjsLib: unknown;
  }
}

// ── Utils ──────────────────────────────────────────────────────────
const norm = (s: string | null | undefined): string => String(s ?? "").toUpperCase().replace(/\s+/g, " ").trim();

// AKILLI SAYI AYRIŞTIRICI: İçinde harf/birim (Lt, Kg) kalsa bile onları siler atar
const parseNum = (v: unknown): number => {
  if (typeof v === "number") return v;
  let s = String(v ?? 0).replace(/\s/g, "").replace(/₺|TL|TRY/gi, "");
  // Sadece rakam, virgül, nokta ve eksi işareti kalsın, geri kalan her şeyi (harfleri) sil
  s = s.replace(/[^\d,\.\-]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  return parseFloat(s) || 0;
};

const fmt = (n: number, d: number = 2): string => (typeof n === "number" ? n : 0).toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtS = (n: number): string => (n > 0 ? "+" : "") + fmt(n);
const approxEq = (a: number, b: number, tol: number = 0.02): boolean => Math.abs(a - b) < tol;

// ── Learning Storage (Tarayıcı Hafızası) ──────────────────────────
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

// ── Supplier fuzzy matching ────────────────────────────────────────
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
  let c = 0; for (const w of wa) if (wb.has(w)) c++;
  return c / Math.max(wa.size, wb.size);
}

// ── AKILLI PDF AYRIŞTIRICI (COORDINATE-BASED ENGINE) ─────────────────────────
// ── AKILLI PDF AYRIŞTIRICI (V3 - KUSURSUZ MİMARİ) ─────────────────────────
async function parsePDF(file: File): Promise<{ tedarikci: string, items: ReceiptItem[] }> {
  const buf = await file.arrayBuffer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs = window.pdfjsLib as any;
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const all: PdfTextItem[] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const { items } = await page.getTextContent();
    const pageOffset = p * 5000; // ÇOK KRİTİK 1: Sayfaların birbirine geçmesini engeller!
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

  let tedarikci = file.name.replace(/\.pdf$/i, "").replace(/[_-]/g, " ");
  const CO = /TİC\.|PAZ\.|SAN\.|LTD|A\.Ş\.|GIDA|SÜT|MARKET|GRUP|KOLA|ET |ÜRÜ/i;
  for (const row of rows) {
    if (/Stok Kodu/i.test(row.text)) break;
    const left = row.items[0];
    if (left && CO.test(left.text) && !/longosphere/i.test(left.text)) { tedarikci = left.text; break; }
  }

  const hIdx = rows.findIndex(r => /Stok Kodu/i.test(r.text) || /Açıklama/i.test(r.text) || /Miktar/i.test(r.text));
  if (hIdx === -1) return { tedarikci, items: [] };

  // ÇOK KRİTİK 2: Fatura "Ara Toplam" ile bitmesin. Sadece Genel Toplamda dursun.
  let eIdx = rows.findIndex((r, i) => i > hIdx && (/Genel Toplam/i.test(r.text) || /Ödenecek Tutar/i.test(r.text)));
  if (eIdx === -1) eIdx = rows.length;

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

  if (netFiyatX === -1) {
    const fiyatItems = headerItems.filter(it => it.text.toLowerCase().includes("fiyat") || it.text.toLowerCase().includes("fyt"));
    if (fiyatItems.length > 0) {
      fiyatItems.sort((a, b) => b.x - a.x); // Sağdan sola
      netFiyatX = fiyatItems[0]!.x + (fiyatItems[0]!.w / 2); // En sağdaki "Fiyat" Net Fiyattır.
    }
  }

  const activeCols = [
    { key: "miktar", x: miktarX },
    { key: "birim", x: birimX },
    { key: "netFiyat", x: netFiyatX },
    { key: "toplam", x: toplamX }
  ].filter(c => c.x !== -1);

  const lineItems: ReceiptItem[] = [];
  let lastItem: ReceiptItem | null = null;

  for (let i = hIdx + 1; i < eIdx; i++) {
    const row = rows[i]!;
    if (row.text.trim() === "") continue;

    // Ara toplamları, sayfa sonu notlarını okuma
    if (/TOPLAM|KDV|MATRAH|YEKÜN|SAYFA/i.test(row.text)) continue;

    const rowVals: Record<string, { text: string, dist: number }> = {};
    const nameItems: PdfTextItem[] = [];

    for (const it of row.items) {
      const cX = it.x + (it.w / 2);

      if (miktarX !== -1 && (it.x + it.w) < miktarX - 15) {
        nameItems.push(it);
        continue;
      }

      let bestCol = null;
      let minD = 35; // ÇOK KRİTİK 3: Toleransı 120'den 35'e düşürdük! KDV Tuzağını yırttık.
      for (const col of activeCols) {
        const d = Math.abs(cX - col.x);
        if (d < minD) { minD = d; bestCol = col.key; }
      }

      if (bestCol) {
        // ÇOK KRİTİK 4: Yan yana olanları birleştirme (Kara Delik), her zaman başlığa EN YAKIN olanı al!
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
      }
    } else {
      if (lastItem && nameItems.length > 0) {
        const extraText = nameItems.map(it => it.text).join(" ").trim();
        if (extraText) lastItem.stokAdi += " " + extraText;
      }
    }
  }

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
  return { tedarikci, items: final };
}

// ── Core Comparison Logic ─────────────────────────────────────────
function buildDiff(order: OrderItem, receipt: ReceiptItem): DiffResult {
  const mB = order.miktar - receipt.miktar;
  const mT = mB * order.sonAlisFiyati;
  const fB = receipt.netBFiyat - order.sonAlisFiyati;
  const fT = fB * receipt.miktar;
  const excelToplam = order.miktar * order.sonAlisFiyati;
  const pdfToplam = receipt.toplam;
  const tT = excelToplam - pdfToplam;
  const expectedPdfToplam = receipt.miktar * receipt.netBFiyat;
  const mathMismatch = !approxEq(expectedPdfToplam, pdfToplam, 0.5);
  return {
    order, receipt, mB, mT, fB, fT, tT, excelToplam, pdfToplam, expectedPdfToplam,
    hasQtyErr: mB !== 0, hasPriceErr: !approxEq(fB, 0, 0.001), hasTotalErr: !approxEq(tT, 0, 0.1),
    mathMismatch, hasErr: mB !== 0 || !approxEq(fB, 0, 0.001) || !approxEq(tT, 0, 0.1) || mathMismatch
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
  const fields = [{ key: "stokAdi", label: "Ürün / Stok Adı", hint: "Ürün adlarının bulunduğu sütun" }, { key: "tedarikci", label: "Tedarikçi (Notlar)", hint: "Genellikle 'Notlar' sütunu tedarikçi adını taşır" }, { key: "miktar", label: "Sipariş Miktarı", hint: "Sipariş edilen miktar" }, { key: "birim", label: "Birim", hint: "Kg, Adet, Lt vb." }, { key: "sonAlisFiyati", label: "Son Alış Fiyatı", hint: "PDF'deki Net B.Fiyat ile karşılaştırılacak" }];
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
      <h2 className="text-2xl font-bold mb-1">Tedarikçi Eşleştirme</h2>
      <p className="text-gray-400 text-sm mb-7">Otomatik eşleştirilemeyen PDF&apos;leri atayın.</p>
      <div className="space-y-3">
        {pdfParsed.map((p, i) => (
          <div key={i} className={`bg-gray-900 rounded-xl p-4 border ${p.assigned ? "border-emerald-700" : "border-yellow-700"}`}>
            <p className="text-sm font-semibold">📄 {p.fileName}</p>
            <p className="text-xs text-gray-400 mt-0.5 mb-3">Tespit: <span className="text-yellow-300">{p.detected}</span> · {p.items.length} kalem</p>
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
        <button onClick={onNext} className="flex-1 bg-emerald-600 hover:bg-emerald-500 font-semibold py-3 rounded-xl">Karşılaştır →</button>
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
        <p className="text-xs text-gray-400 mt-1">{p.supplier} · {fmt(p.order.miktar, 3)} {p.order.birim} · {fmt(p.order.sonAlisFiyati)} ₺/birim</p>
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

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {[{ v: stats.suppCount, label: "Tedarikçi", c: "blue" }, { v: stats.errCount, label: "Sorunlu Kalem", c: stats.errCount > 0 ? "red" : "green" }, { v: stats.okCount, label: "Sorunsuz Kalem", c: "green" }, { v: fmt(stats.impact) + " ₺", label: "Toplam Farkların Mutlak Etkisi", c: stats.impact > 0 ? "red" : "green" }].map((s, i) => (
          <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">{s.label}</p>
            <p className={`text-xl font-bold ${s.c === "red" ? "text-red-400" : s.c === "green" ? "text-emerald-400" : "text-blue-400"}`}>{s.v}</p>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between mb-5 gap-3">
        <h2 className="text-xl font-bold">Karşılaştırma Sonuçları</h2>
        <button onClick={onExport} className="bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold px-4 py-2 rounded-lg transition-colors whitespace-nowrap">📥 Excel Rapor</button>
      </div>
      <div className="space-y-3">
        {results.map(s => {
          const errCount = s.matched.filter((m: DiffResult) => m.hasErr).length + s.unmatchedExcel.length + s.unmatchedPdf.length;
          const isOpen = open.has(s.key);
          return (
            <div key={s.key} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <button onClick={() => toggle(s.key)} className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-800 transition-colors text-left">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${errCount > 0 ? "bg-red-500" : "bg-emerald-500"}`} />
                  <span className="font-semibold truncate">{s.name}</span>
                  {!s.hasPdf && <span className="text-xs bg-orange-900 text-orange-300 px-2 py-0.5 rounded shrink-0">Tesellüm yok</span>}
                  {!s.hasOrders && <span className="text-xs bg-purple-900 text-purple-300 px-2 py-0.5 rounded shrink-0">Siparişte yok</span>}
                </div>
              </button>
              {isOpen && (
                <div className="px-5 pb-5 border-t border-gray-800 pt-4">
                  {s.matched.length > 0 && (
                    <div className="mb-5">
                      <p className="text-xs text-gray-500 uppercase tracking-widest mb-3">Eşleşen Kalemler</p>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs min-w-max">
                          <thead>
                            <tr className="text-gray-500 border-b border-gray-800">
                              {["Ürün", "Sip.Mik.", "Gel.Mik.", "Mik.F.", "Mik.F.(₺)", "Sip.Fiy.", "Gel.Fiy.", "Fiy.F.", "Fiy.F.(₺)", "Sip.Top.", "Gel.Top.", "Top.F.(₺)"].map(h => <th key={h} className={TH}>{h}</th>)}
                            </tr>
                          </thead>
                          <tbody>
                            {s.matched.map((m: DiffResult, i: number) => (
                              <tr key={i} className={`border-b border-gray-800/50 ${m.hasErr ? "bg-red-950/20" : ""}`}>
                                <td className={TD}><span className="font-medium">{m.order.stokAdi}</span></td>
                                <td className={TD + " text-gray-300"}>{fmt(m.order.miktar, 3)} {m.order.birim}</td>
                                <td className={TD + " text-gray-300"}>{fmt(m.receipt.miktar, 3)}</td>
                                <td className={TD + " font-mono " + (m.mB !== 0 ? "text-red-400" : "text-gray-600")}>{m.mB !== 0 ? fmtS(m.mB) : "—"}</td>
                                <td className={TD + " font-mono " + (Math.abs(m.mT) > 0.01 ? "text-red-400" : "text-gray-600")}>{Math.abs(m.mT) > 0.01 ? fmtS(m.mT) : "—"}</td>
                                <td className={TD + " text-gray-300"}>{fmt(m.order.sonAlisFiyati)}</td>
                                <td className={TD + " text-gray-300"}>{fmt(m.receipt.netBFiyat)}</td>
                                <td className={TD + " font-mono " + (!approxEq(m.fB, 0, 0.001) ? "text-red-400" : "text-gray-600")}>{!approxEq(m.fB, 0, 0.001) ? fmtS(m.fB) : "—"}</td>
                                <td className={TD + " font-mono " + (Math.abs(m.fT) > 0.01 ? "text-red-400" : "text-gray-600")}>{Math.abs(m.fT) > 0.01 ? fmtS(m.fT) : "—"}</td>
                                <td className={TD + " text-gray-400"}>{fmt(m.excelToplam)}</td>
                                <td className={TD + " text-gray-400"}>{fmt(m.pdfToplam)}</td>
                                <td className={TD + " font-mono " + (m.hasTotalErr ? "text-red-400 font-semibold" : "text-gray-600")}>{m.hasTotalErr ? fmtS(m.tT) : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  {s.unmatchedExcel.length > 0 && (
                    <div className="mb-4">
                      <p className="text-xs text-orange-400 uppercase tracking-widest mb-2">⚠ Siparişte Var, Tesellümde Yok</p>
                      <div className="space-y-1.5">
                        {s.unmatchedExcel.map((o: OrderItem, i: number) => (
                          <div key={i} className="flex justify-between items-center bg-orange-950/30 border border-orange-900 rounded-lg px-3 py-2 text-xs">
                            <span className="font-medium">{o.stokAdi}</span>
                            <span className="text-orange-300 ml-3 whitespace-nowrap">{fmt(o.miktar, 3)} {o.birim} · {fmt(o.sonAlisFiyati)} ₺</span>
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
  const [colMap, setColMap] = useState<Record<string, string>>({ stokAdi: "", tedarikci: "", miktar: "", birim: "", sonAlisFiyati: "" });
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

      // Boş başlıkları ve tekrarları temizle
      const rawHdrs = (data[0] ?? []).map(String);
      const hdrs = Array.from(new Set(rawHdrs.filter(h => h.trim() !== "")));

      setHeaders(hdrs);
      setRawRows(data.slice(1).filter(r => r.some(c => c !== "")));
      const auto = { stokAdi: "", tedarikci: "", miktar: "", birim: "", sonAlisFiyati: "" };
      for (const h of hdrs) {
        const n = norm(h);
        if (!auto.stokAdi && n.includes("STOK")) auto.stokAdi = h;
        if (!auto.tedarikci && (n === "NOTLAR" || n.includes("TEDAR"))) auto.tedarikci = h;
        if (!auto.miktar && (n === "MİKTAR" || n === "MIKTAR")) auto.miktar = h;
        if (!auto.birim && (n === "BİRİM" || n === "BIRIM")) auto.birim = h;
        if (!auto.sonAlisFiyati && n.includes("SON") && n.includes("FIYAT")) auto.sonAlisFiyati = h;
      }
      setColMap(auto);
    };
    r.readAsArrayBuffer(file);
  };

  const buildOrders = (): OrderItem[] => {
    const [si, ti, mi, bi, fi] = ["stokAdi", "tedarikci", "miktar", "birim", "sonAlisFiyati"].map(k => headers.indexOf(colMap[k] ?? ""));
    return rawRows.map((row, id) => ({
      id,
      stokAdi: String(row[si!] ?? "").trim(),
      tedarikci: String(row[ti!] ?? "").trim(),
      miktar: parseNum(row[mi!]),
      birim: String(row[bi!] ?? "").trim(),
      sonAlisFiyati: parseNum(row[fi!])
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
        parsed.push({ fileName: f.name, detected: result.tedarikci, assigned: match ?? "", items: result.items });
      }
      setLoading("");
      setPdfParsed(parsed);
      const unassigned = parsed.filter(p => !p.assigned);
      if (unassigned.length > 0) { setScreen("supplierAssign"); }
      else finalize(parsed, orders);
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
    if (!results) return;
    const data: (string | number)[][] = [["Tedarikçi", "Ürün", "Sip.Miktar", "Gel.Miktar", "Birim", "Mik.Farkı", "Mik.Farkı(₺)", "Sip.B.Fiyat", "Gel.B.Fiyat", "Fiy.Farkı", "Fiy.Farkı(₺)", "Sip.Toplam", "Gel.Toplam", "Top.Farkı(₺)", "Durum", "Not"]];
    for (const s of results) {
      for (const m of s.matched) {
        if (!m.hasErr) continue;
        const notes = [];
        if (m.hasQtyErr) notes.push("MİKTAR FARKI");
        if (m.hasPriceErr) notes.push("FİYAT FARKI");
        if (m.hasTotalErr) notes.push("TOPLAM FARKI");
        if (m.mathMismatch) notes.push("İSKONTO/KDV SİNYALİ");
        data.push([s.name, m.order.stokAdi, m.order.miktar, m.receipt.miktar, m.order.birim, m.mB, m.mT, m.order.sonAlisFiyati, m.receipt.netBFiyat, m.fB, m.fT, m.excelToplam, m.pdfToplam, m.tT, "UYUŞMAZLIK", notes.join(" + ")]);
      }
      for (const o of s.unmatchedExcel) { data.push([s.name, o.stokAdi, o.miktar, 0, o.birim, o.miktar, o.miktar * o.sonAlisFiyati, o.sonAlisFiyati, 0, 0, 0, o.miktar * o.sonAlisFiyati, 0, o.miktar * o.sonAlisFiyati, "TESLİMAT YOK", ""]); }
      for (const r of s.unmatchedPdf) { data.push([s.name, r.stokAdi, 0, r.miktar, r.birim, -r.miktar, 0, 0, r.netBFiyat, 0, 0, 0, r.toplam, -r.toplam, "YETKİSİZ TESLİMAT", ""]); }
    }
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Rapor");
    XLSX.writeFile(wb, "LongoKontrol_Rapor_" + new Date().toISOString().slice(0, 10) + ".xlsx");
  };

  const reset = () => { setScreen("upload"); setExcelFile(null); setPdfFiles([]); setResults(null); setErr(""); setPending([]); setPIdx(0); };

  const stats: StatsData | null = results ? {
    suppCount: results.length,
    errCount: results.reduce((a, s) => a + s.matched.filter((m: DiffResult) => m.hasErr).length + s.unmatchedExcel.length + s.unmatchedPdf.length, 0),
    okCount: results.reduce((a, s) => a + s.matched.filter((m: DiffResult) => !m.hasErr).length, 0),
    impact: results.reduce((a, s) => a + s.matched.filter((m: DiffResult) => m.hasErr).reduce((b: number, m: DiffResult) => b + Math.abs(m.tT), 0), 0),
  } : null;

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
        {screen === "supplierAssign" && <SupplierAssignScreen pdfParsed={pdfParsed} excelSupps={excelSupps} onChange={(i, v) => { const u = [...pdfParsed]; u[i] = { ...u[i]!, assigned: v }; setPdfParsed(u); }} onBack={() => setScreen("mapping")} onNext={() => { if (pdfParsed.some(p => !p.assigned)) { setErr("Tüm PDF'leri atayın."); return; } setErr(""); finalize(pdfParsed, buildOrders()); }} err={err} />}
        {screen === "matching" && <MatchingScreen pending={pending} pIdx={pIdx} onChange={c => { const u = [...pending]; u[pIdx] = { ...u[pIdx]!, choice: c }; setPending(u); }} onPrev={() => setPIdx(i => Math.max(0, i - 1))} onNext={() => { if (pIdx < pending.length - 1) setPIdx(i => i + 1); else applyManual(); }} isLast={pIdx === pending.length - 1} />}
        {screen === "results" && results && stats && <ResultsScreen results={results} stats={stats} onExport={exportReport} />}
      </main>
    </div>
  );
}