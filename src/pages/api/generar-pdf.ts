// src/pages/api/generar-pdf.ts
// Endpoint agnóstico de generación de PDF.
// Recibe un PDFLayout como JSON y devuelve el PDF binario.
//
// Uso desde cualquier herramienta:
//   const res = await fetch('/api/generar-pdf', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify(layout),   // PDFLayout
//   });
//   const blob = await res.blob();
//
// Compatible con Astro + adaptador Cloudflare Pages o Node.

import type { APIRoute } from 'astro';
import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib';

// Requerido en output: 'hybrid' para que Cloudflare lo trate como SSR
export const prerender = false;

// ── Tipos públicos del layout ────────────────────────────────────────────────
// (duplicados aquí para que el endpoint sea self-contained;
//  podés moverlos a src/types/pdf-layout.ts y re-exportar)

export type PDFUnit = 'mm' | 'cm' | 'pt' | 'px';

export interface PDFImageElement {
  type: 'image';
  src: string;             // data-URL base64 (image/jpeg o image/png)
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;       // grados, sentido horario, origen = centro
  fit?: 'fill' | 'contain' | 'cover';
  opacity?: number;        // 0–1, default 1
}

export interface PDFTextElement {
  type: 'text';
  text: string;
  x: number;
  y: number;
  fontSize?: number;       // en pt, independiente de la unidad de la página
  font?: 'helvetica' | 'helvetica-bold' | 'courier' | 'times';
  color?: [number, number, number]; // RGB 0–1
  align?: 'left' | 'center' | 'right';
  maxWidth?: number;       // word-wrap (en la unidad de la página)
  lineHeight?: number;     // multiplicador, default 1.2
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
  borderRadius?: number;
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
  dashArray?: number[];    // e.g. [4, 2] → guiones de 4, espacios de 2
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
  unit?: PDFUnit;          // sobreescribe la unidad global
  elements: PDFElement[];
}

export interface PDFLayout {
  filename?: string;       // default: 'documento.pdf'
  unit: PDFUnit;           // unidad global para todas las páginas
  pages: PDFPageLayout[];
}

// ── Conversión de unidades → puntos (pt) ────────────────────────────────────

const TO_PT: Record<PDFUnit, number> = {
  pt: 1,
  mm: 2.8346456692913,   // 1 mm = 72/25.4 pt
  cm: 28.346456692913,   // 1 cm = 72/2.54 pt
  px: 0.75,              // 1 px = 0.75 pt  (asume 96 dpi)
};

function toPt(value: number, unit: PDFUnit): number {
  return value * TO_PT[unit];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] ?? 'image/jpeg';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, mime };
}

function toRgb(c?: [number, number, number]) {
  return c ? rgb(c[0], c[1], c[2]) : undefined;
}

function resolveFont(doc: PDFDocument, name?: string) {
  const map: Record<string, string> = {
    'helvetica':      StandardFonts.Helvetica,
    'helvetica-bold': StandardFonts.HelveticaBold,
    'courier':        StandardFonts.Courier,
    'times':          StandardFonts.TimesRoman,
  };
  return doc.embedFont(map[name ?? 'helvetica'] ?? StandardFonts.Helvetica);
}

// ── Dibujado de elementos ────────────────────────────────────────────────────

async function drawImage(
  page: ReturnType<PDFDocument['addPage']>,
  el: PDFImageElement,
  unit: PDFUnit,
  pageHeightPt: number,
  doc: PDFDocument,
) {
  const { bytes, mime } = parseDataUrl(el.src);
  let pdfImage;
  try {
    pdfImage = mime === 'image/png'
      ? await doc.embedPng(bytes)
      : await doc.embedJpg(bytes);
  } catch {
    // Si la imagen falla, dibujamos un rect gris como fallback
    page.drawRectangle({
      x:      toPt(el.x, unit),
      y:      pageHeightPt - toPt(el.y + el.height, unit),
      width:  toPt(el.width, unit),
      height: toPt(el.height, unit),
      color:  rgb(0.8, 0.8, 0.8),
    });
    return;
  }

  const xPt = toPt(el.x, unit);
  const yTopPt = toPt(el.y, unit);
  const wPt = toPt(el.width, unit);
  const hPt = toPt(el.height, unit);

  // PDF origin = bottom-left, layout origin = top-left
  const yPt = pageHeightPt - yTopPt - hPt;

  const fit = el.fit ?? 'fill';
  let drawW = wPt;
  let drawH = hPt;
  let drawX = xPt;
  let drawY = yPt;

  if (fit !== 'fill') {
    const imgAspect = pdfImage.width / pdfImage.height;
    const slotAspect = wPt / hPt;
    if (fit === 'contain') {
      if (imgAspect > slotAspect) {
        drawW = wPt;
        drawH = wPt / imgAspect;
        drawY = yPt + (hPt - drawH) / 2;
      } else {
        drawH = hPt;
        drawW = hPt * imgAspect;
        drawX = xPt + (wPt - drawW) / 2;
      }
    } else if (fit === 'cover') {
      // clip to slot area
      if (imgAspect > slotAspect) {
        drawH = hPt;
        drawW = hPt * imgAspect;
        drawX = xPt - (drawW - wPt) / 2;
      } else {
        drawW = wPt;
        drawH = wPt / imgAspect;
        drawY = yPt - (drawH - hPt) / 2;
      }
    }
  }

  const rotation = el.rotation ?? 0;

  if (rotation !== 0) {
    // Rotate around center of slot
    const cx = xPt + wPt / 2;
    const cy = yPt + hPt / 2;
    page.drawImage(pdfImage, {
      x:        cx - drawH / 2,
      y:        cy - drawW / 2,
      width:    drawH,
      height:   drawW,
      rotate:   degrees(rotation),
      opacity:  el.opacity ?? 1,
    });
  } else {
    page.drawImage(pdfImage, {
      x:       drawX,
      y:       drawY,
      width:   drawW,
      height:  drawH,
      opacity: el.opacity ?? 1,
    });
  }
}

async function drawText(
  page: ReturnType<PDFDocument['addPage']>,
  el: PDFTextElement,
  unit: PDFUnit,
  pageHeightPt: number,
  doc: PDFDocument,
) {
  const font = await resolveFont(doc, el.font);
  const fontSize = el.fontSize ?? 12;
  const color = toRgb(el.color) ?? rgb(0, 0, 0);
  const opacity = el.opacity ?? 1;
  const lineHeight = (el.lineHeight ?? 1.2) * fontSize;
  const xPt = toPt(el.x, unit);
  const maxWidthPt = el.maxWidth ? toPt(el.maxWidth, unit) : undefined;

  // Split text into lines (respeta \n + word-wrap si maxWidth está definido)
  let lines: string[] = [];
  const rawLines = el.text.split('\n');

  if (maxWidthPt) {
    for (const raw of rawLines) {
      const words = raw.split(' ');
      let current = '';
      for (const word of words) {
        const test = current ? `${current} ${word}` : word;
        const w = font.widthOfTextAtSize(test, fontSize);
        if (w > maxWidthPt && current) {
          lines.push(current);
          current = word;
        } else {
          current = test;
        }
      }
      if (current) lines.push(current);
    }
  } else {
    lines = rawLines;
  }

  lines.forEach((line, i) => {
    const lineW = font.widthOfTextAtSize(line, fontSize);
    let drawX = xPt;
    if (el.align === 'center' && maxWidthPt) {
      drawX = xPt + (maxWidthPt - lineW) / 2;
    } else if (el.align === 'right' && maxWidthPt) {
      drawX = xPt + maxWidthPt - lineW;
    }

    // y: top-left origin → convert (text baseline in PDF = bottom of line)
    const yTopPt = toPt(el.y, unit) + i * lineHeight;
    const yPt = pageHeightPt - yTopPt - fontSize;

    page.drawText(line, {
      x: drawX,
      y: yPt,
      size: fontSize,
      font,
      color,
      opacity,
    });
  });
}

function drawRect(
  page: ReturnType<PDFDocument['addPage']>,
  el: PDFRectElement,
  unit: PDFUnit,
  pageHeightPt: number,
) {
  const xPt = toPt(el.x, unit);
  const wPt = toPt(el.width, unit);
  const hPt = toPt(el.height, unit);
  const yPt = pageHeightPt - toPt(el.y, unit) - hPt;

  page.drawRectangle({
    x: xPt, y: yPt,
    width: wPt, height: hPt,
    ...(el.fill       ? { color:       rgb(...el.fill),       opacity: el.fillOpacity ?? el.opacity ?? 1 } : {}),
    ...(el.stroke     ? { borderColor: rgb(...el.stroke),     borderWidth: el.strokeWidth ?? 0.5 } : {}),
    ...(el.borderRadius ? { borderLineCap: 'Round' as any } : {}),
  });
}

function drawLine(
  page: ReturnType<PDFDocument['addPage']>,
  el: PDFLineElement,
  unit: PDFUnit,
  pageHeightPt: number,
) {
  const x1Pt = toPt(el.x1, unit);
  const y1Pt = pageHeightPt - toPt(el.y1, unit);
  const x2Pt = toPt(el.x2, unit);
  const y2Pt = pageHeightPt - toPt(el.y2, unit);

  page.drawLine({
    start: { x: x1Pt, y: y1Pt },
    end:   { x: x2Pt, y: y2Pt },
    color: el.stroke ? rgb(...el.stroke) : rgb(0, 0, 0),
    thickness: el.strokeWidth ?? 0.5,
    dashArray: el.dashArray,
    opacity:   el.opacity ?? 1,
  });
}

// ── Handler principal ────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request }) => {
  let layout: PDFLayout;
  try {
    layout = await request.json();
  } catch {
    return error(400, 'JSON inválido en el body.');
  }

  if (!layout.pages?.length) {
    return error(400, 'El layout debe incluir al menos una página.');
  }

  const globalUnit: PDFUnit = layout.unit ?? 'mm';

  try {
    const doc = await PDFDocument.create();
    doc.setTitle(layout.filename?.replace(/\.pdf$/i, '') ?? 'Documento');
    doc.setProducer('Herramientas — generar-pdf endpoint');

    for (const pageLayout of layout.pages) {
      const unit: PDFUnit = pageLayout.unit ?? globalUnit;
      const pageWidthPt   = toPt(pageLayout.width,  unit);
      const pageHeightPt  = toPt(pageLayout.height, unit);
      const page          = doc.addPage([pageWidthPt, pageHeightPt]);

      for (const el of pageLayout.elements ?? []) {
        try {
          switch (el.type) {
            case 'image': await drawImage(page, el, unit, pageHeightPt, doc); break;
            case 'text':  await drawText (page, el, unit, pageHeightPt, doc); break;
            case 'rect':  drawRect(page, el, unit, pageHeightPt);              break;
            case 'line':  drawLine(page, el, unit, pageHeightPt);              break;
          }
        } catch (elemErr) {
          // Elemento falla en silencio — el resto de la página continúa
          console.error(`[generar-pdf] error en elemento ${el.type}:`, elemErr);
        }
      }
    }

    const pdfBytes = await doc.save();
    const filename  = layout.filename ?? 'documento.pdf';

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      String(pdfBytes.byteLength),
      },
    });

  } catch (err: any) {
    console.error('[generar-pdf] error generando PDF:', err);
    return error(500, 'Error interno generando el PDF: ' + err.message);
  }
};

// OPTIONS handler para CORS pre-flight
export const OPTIONS: APIRoute = () =>
  new Response(null, { status: 204, headers: corsHeaders() });

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function error(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}