// src/pages/api/generar-pdf.ts
// Endpoint agnóstico de generación de PDF con pdf-lib.
//
// MODELO DE EJECUCIÓN:
//   - El cliente (fotos.astro) es responsable de entregar imágenes ya
//     orientadas correctamente (rotadas via canvas offscreen si hace falta).
//   - Este endpoint solo posiciona y embebe — sin transformaciones de rotación.
//   - Coordenadas en el layout usan origen TOP-LEFT (como CSS/canvas).
//     La conversión a bottom-left de PDF se hace aquí internamente.
//
// POST /api/generar-pdf
//   Body: PDFLayout (JSON)
//   Response: application/pdf

import type { APIRoute } from 'astro';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

export const prerender = false;

// ── Tipos ────────────────────────────────────────────────────────────────────

export type PDFUnit = 'mm' | 'cm' | 'pt' | 'px';

export interface PDFImageElement {
  type: 'image';
  /** data-URL base64 — imagen YA orientada correctamente por el cliente */
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 'fill' estira al slot | 'contain' respeta aspecto con padding | 'cover' recorta */
  fit?: 'fill' | 'contain' | 'cover';
  opacity?: number;
}

export interface PDFTextElement {
  type: 'text';
  text: string;
  x: number;
  y: number;
  /** Siempre en pt, independiente de la unidad de la página */
  fontSize?: number;
  font?: 'helvetica' | 'helvetica-bold' | 'courier' | 'times';
  color?: [number, number, number];
  align?: 'left' | 'center' | 'right';
  maxWidth?: number;
  lineHeight?: number;
  opacity?: number;
}

export interface PDFRectElement {
  type: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: [number, number, number];
  fillOpacity?: number;
  stroke?: [number, number, number];
  strokeWidth?: number;
  opacity?: number;
}

export interface PDFLineElement {
  type: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke?: [number, number, number];
  strokeWidth?: number;
  dashArray?: number[];
  opacity?: number;
}

export type PDFElement =
  | PDFImageElement
  | PDFTextElement
  | PDFRectElement
  | PDFLineElement;

export interface PDFPageLayout {
  width: number;
  height: number;
  unit?: PDFUnit;
  elements: PDFElement[];
}

export interface PDFLayout {
  filename?: string;
  unit: PDFUnit;
  pages: PDFPageLayout[];
}

// ── Conversión de unidades ───────────────────────────────────────────────────

const TO_PT: Record<PDFUnit, number> = {
  pt: 1,
  mm: 72 / 25.4,
  cm: 72 / 2.54,
  px: 72 / 96,
};

function toPt(value: number, unit: PDFUnit): number {
  return value * TO_PT[unit];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) throw new Error('data-URL sin coma separadora');
  const header = dataUrl.slice(0, commaIdx);
  const b64    = dataUrl.slice(commaIdx + 1);
  const mime   = header.match(/:(.*?);/)?.[1] ?? 'image/jpeg';
  // Decodificación compatible con Cloudflare Workers (no hay Buffer)
  const binStr = atob(b64);
  const bytes  = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  return { bytes, mime };
}

// Caché de fonts por documento para no re-embedarlos en cada texto
const fontCache = new WeakMap<PDFDocument, Map<string, Awaited<ReturnType<PDFDocument['embedFont']>>>>();

async function getFont(doc: PDFDocument, name?: string) {
  const key = name ?? 'helvetica';
  if (!fontCache.has(doc)) fontCache.set(doc, new Map());
  const cache = fontCache.get(doc)!;
  if (cache.has(key)) return cache.get(key)!;
  const stdMap: Record<string, (typeof StandardFonts)[keyof typeof StandardFonts]> = {
    'helvetica':      StandardFonts.Helvetica,
    'helvetica-bold': StandardFonts.HelveticaBold,
    'courier':        StandardFonts.Courier,
    'times':          StandardFonts.TimesRoman,
  };
  const font = await doc.embedFont(stdMap[key] ?? StandardFonts.Helvetica);
  cache.set(key, font);
  return font;
}

// ── Dibujado ─────────────────────────────────────────────────────────────────

async function drawImage(
  page: ReturnType<PDFDocument['addPage']>,
  el: PDFImageElement,
  unit: PDFUnit,
  pageHPt: number,
  doc: PDFDocument,
) {
  const { bytes, mime } = parseDataUrl(el.src);

  let pdfImg;
  try {
    // Intentar JPEG primero; si falla, intentar PNG
    if (mime === 'image/png') {
      pdfImg = await doc.embedPng(bytes);
    } else {
      try {
        pdfImg = await doc.embedJpg(bytes);
      } catch {
        // Algunos JPEG con metadatos inusuales fallan embedJpg → intentar como PNG
        pdfImg = await doc.embedPng(bytes);
      }
    }
  } catch (e) {
    // Fallback visual: rect gris con borde para indicar el slot
    const xPt = toPt(el.x, unit);
    const yPt = pageHPt - toPt(el.y, unit) - toPt(el.height, unit);
    page.drawRectangle({
      x: xPt, y: yPt,
      width: toPt(el.width, unit), height: toPt(el.height, unit),
      color: rgb(0.85, 0.85, 0.85),
      borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5,
    });
    console.error('[generar-pdf] embed falló:', (e as Error).message);
    return;
  }

  // Slot en pt (origen top-left del layout → bottom-left de PDF)
  const slotX = toPt(el.x, unit);
  const slotW = toPt(el.width, unit);
  const slotH = toPt(el.height, unit);
  const slotY = pageHPt - toPt(el.y, unit) - slotH; // PDF: y crece hacia arriba

  const fit = el.fit ?? 'fill';

  let drawX = slotX;
  let drawY = slotY;
  let drawW = slotW;
  let drawH = slotH;

  if (fit === 'contain') {
    const imgAspect  = pdfImg.width / pdfImg.height;
    const slotAspect = slotW / slotH;
    if (imgAspect > slotAspect) {
      // imagen más ancha → ajustar por ancho
      drawW = slotW;
      drawH = slotW / imgAspect;
      drawX = slotX;
      drawY = slotY + (slotH - drawH) / 2;
    } else {
      // imagen más alta → ajustar por alto
      drawH = slotH;
      drawW = slotH * imgAspect;
      drawX = slotX + (slotW - drawW) / 2;
      drawY = slotY;
    }
  } else if (fit === 'cover') {
    // cover sin clipping: centramos y dejamos que sobresalga
    // (pdf-lib no tiene clip paths simples; el cliente debería enviar fit=fill)
    const imgAspect  = pdfImg.width / pdfImg.height;
    const slotAspect = slotW / slotH;
    if (imgAspect > slotAspect) {
      drawH = slotH;
      drawW = slotH * imgAspect;
      drawX = slotX - (drawW - slotW) / 2;
      drawY = slotY;
    } else {
      drawW = slotW;
      drawH = slotW / imgAspect;
      drawX = slotX;
      drawY = slotY - (drawH - slotH) / 2;
    }
  }
  // fit === 'fill': drawX/Y/W/H ya apuntan al slot completo

  page.drawImage(pdfImg, {
    x: drawX, y: drawY,
    width: drawW, height: drawH,
    opacity: el.opacity ?? 1,
  });
}

async function drawText(
  page: ReturnType<PDFDocument['addPage']>,
  el: PDFTextElement,
  unit: PDFUnit,
  pageHPt: number,
  doc: PDFDocument,
) {
  const font       = await getFont(doc, el.font);
  const fontSize   = el.fontSize ?? 12;
  const color      = el.color ? rgb(...el.color) : rgb(0, 0, 0);
  const lineHeightPt = (el.lineHeight ?? 1.2) * fontSize;
  const xPt        = toPt(el.x, unit);
  const maxWPt     = el.maxWidth ? toPt(el.maxWidth, unit) : undefined;

  // Word-wrap + saltos de línea explícitos
  const lines: string[] = [];
  for (const raw of el.text.split('\n')) {
    if (!maxWPt) { lines.push(raw); continue; }
    let current = '';
    for (const word of raw.split(' ')) {
      const test = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(test, fontSize) > maxWPt && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
  }

  lines.forEach((line, i) => {
    let drawX = xPt;
    if (maxWPt) {
      const lw = font.widthOfTextAtSize(line, fontSize);
      if      (el.align === 'center') drawX = xPt + (maxWPt - lw) / 2;
      else if (el.align === 'right')  drawX = xPt + maxWPt - lw;
    }
    // Baseline en PDF: pageH - y_top - fontSize (línea 0 = top del bloque)
    const yPt = pageHPt - toPt(el.y, unit) - fontSize - i * lineHeightPt;
    page.drawText(line, { x: drawX, y: yPt, size: fontSize, font, color, opacity: el.opacity ?? 1 });
  });
}

function drawRect(
  page: ReturnType<PDFDocument['addPage']>,
  el: PDFRectElement,
  unit: PDFUnit,
  pageHPt: number,
) {
  const wPt = toPt(el.width,  unit);
  const hPt = toPt(el.height, unit);
  const xPt = toPt(el.x, unit);
  const yPt = pageHPt - toPt(el.y, unit) - hPt;

  page.drawRectangle({
    x: xPt, y: yPt, width: wPt, height: hPt,
    ...(el.fill   ? { color:       rgb(...el.fill),   opacity:     el.fillOpacity ?? el.opacity ?? 1 } : {}),
    ...(el.stroke ? { borderColor: rgb(...el.stroke), borderWidth: el.strokeWidth ?? 0.5 } : {}),
  });
}

function drawLine(
  page: ReturnType<PDFDocument['addPage']>,
  el: PDFLineElement,
  unit: PDFUnit,
  pageHPt: number,
) {
  page.drawLine({
    start: { x: toPt(el.x1, unit), y: pageHPt - toPt(el.y1, unit) },
    end:   { x: toPt(el.x2, unit), y: pageHPt - toPt(el.y2, unit) },
    color:     el.stroke ? rgb(...el.stroke) : rgb(0, 0, 0),
    thickness: el.strokeWidth ?? 0.5,
    dashArray: el.dashArray,
    opacity:   el.opacity ?? 1,
  });
}

// ── Handler ──────────────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request }) => {
  let layout: PDFLayout;
  try {
    layout = await request.json() as PDFLayout;
  } catch {
    return jsonError(400, 'JSON inválido en el body.');
  }

  if (!Array.isArray(layout.pages) || layout.pages.length === 0) {
    return jsonError(400, 'El layout debe incluir al menos una página.');
  }

  const globalUnit: PDFUnit = layout.unit ?? 'mm';

  try {
    const doc = await PDFDocument.create();
    doc.setTitle(layout.filename?.replace(/\.pdf$/i, '') ?? 'Documento');
    doc.setProducer('edetools / generar-pdf');

    for (const pageLayout of layout.pages) {
      const unit     = (pageLayout.unit ?? globalUnit) as PDFUnit;
      const pageWPt  = toPt(pageLayout.width,  unit);
      const pageHPt  = toPt(pageLayout.height, unit);
      const page     = doc.addPage([pageWPt, pageHPt]);

      for (const el of pageLayout.elements ?? []) {
        try {
          switch (el.type) {
            case 'image': await drawImage(page, el, unit, pageHPt, doc); break;
            case 'text':  await drawText (page, el, unit, pageHPt, doc); break;
            case 'rect':  drawRect(page, el, unit, pageHPt);              break;
            case 'line':  drawLine(page, el, unit, pageHPt);              break;
          }
        } catch (elemErr) {
          console.error(`[generar-pdf] elemento ${el.type} falló:`, elemErr);
          // Continúa con el resto de la página
        }
      }
    }

    const pdfBytes = await doc.save();

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        ...cors(),
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${layout.filename ?? 'documento.pdf'}"`,
        'Content-Length':      String(pdfBytes.byteLength),
      },
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[generar-pdf] error fatal:', msg);
    return jsonError(500, 'Error generando el PDF: ' + msg);
  }
};

export const OPTIONS: APIRoute = () =>
  new Response(null, { status: 204, headers: cors() });

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...cors(), 'Content-Type': 'application/json' },
  });
}