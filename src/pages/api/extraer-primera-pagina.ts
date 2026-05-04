// src/pages/api/extraer-primera-pagina.ts
//
// Cloudflare Function — reemplaza process.php
//
// Estrategia por archivo:
//   1. pdf-lib  → copia la página como XObject (equivalente a FPDI)
//   2. pdfjs-dist + OffscreenCanvas → rasteriza a PNG si pdf-lib falla
//      (equivalente al fallback Imagick del PHP original)

import { PDFDocument, rgb } from 'pdf-lib';

export const prerender = false;

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface LogEntry {
  type: 'ok' | 'info' | 'warn' | 'error';
  msg: string;
}

interface SuccessResponse {
  pdf: string;
  pages: number;
  failed: string[];
  log: LogEntry[];
}

interface ErrorResponse {
  error: string;
  log?: LogEntry[];
}

// ── Intento 1: pdf-lib (copia directa) ────────────────────────────────────────

async function tryPdfLib(
  outputDoc: PDFDocument,
  fileBytes: Uint8Array,
): Promise<boolean> {
  try {
    const srcDoc = await PDFDocument.load(fileBytes, { ignoreEncryption: true });
    if (srcDoc.getPageCount() === 0) return false;
    const [firstPage] = await outputDoc.copyPages(srcDoc, [0]);
    outputDoc.addPage(firstPage);
    return true;
  } catch {
    return false;
  }
}

// ── Intento 2: pdfjs-dist + OffscreenCanvas (rasterización) ───────────────────
// OffscreenCanvas está disponible en Cloudflare Workers desde 2023.
// pdfjs-dist se importa dinámicamente para que Vite no intente bundlearlo
// en el paso de build (donde no hay entorno Worker).

async function tryPdfjsRaster(
  outputDoc: PDFDocument,
  fileBytes: Uint8Array,
): Promise<boolean> {
  try {
    // Importación dinámica — evita problemas de bundle en build time
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

    // Workers no tiene sistema de archivos — deshabilitar el worker thread de pdfjs
    pdfjsLib.GlobalWorkerOptions.workerSrc = '';

    const loadingTask = pdfjsLib.getDocument({ data: fileBytes, useWorkerFetch: false, isEvalSupported: false });
    const pdfDoc = await loadingTask.promise;
    const page   = await pdfDoc.getPage(1);

    // Resolución equivalente a 150dpi
    const scale    = 150 / 72;
    const viewport = page.getViewport({ scale });

    // OffscreenCanvas — disponible en Cloudflare Workers
    const canvas  = new OffscreenCanvas(
      Math.round(viewport.width),
      Math.round(viewport.height),
    );
    const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;

    await page.render({ canvasContext: context as any, viewport }).promise;

    // Exportar a PNG como ArrayBuffer
    const blob      = await canvas.convertToBlob({ type: 'image/png' });
    const arrayBuf  = await blob.arrayBuffer();
    const pngBytes  = new Uint8Array(arrayBuf);

    // Dimensiones originales en puntos
    const origViewport = page.getViewport({ scale: 1 });
    const widthPt  = origViewport.width;
    const heightPt = origViewport.height;

    // Embeber PNG en el documento de salida
    const pngImage = await outputDoc.embedPng(pngBytes);
    const newPage  = outputDoc.addPage([widthPt, heightPt]);
    newPage.drawImage(pngImage, { x: 0, y: 0, width: widthPt, height: heightPt });

    return true;
  } catch {
    return false;
  }
}

// ── Handler principal ──────────────────────────────────────────────────────────

export async function POST({ request }: { request: Request }): Promise<Response> {
  const log: LogEntry[] = [];
  const addLog = (type: LogEntry['type'], msg: string) => log.push({ type, msg });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: 'No se pudo parsear el formulario.' }, 400);
  }

  const orderRaw = formData.get('order');
  const order: string[] = orderRaw ? JSON.parse(orderRaw as string) : [];

  const uploaded = new Map<string, Uint8Array>();
  for (const [key, value] of formData.entries()) {
    if (key === 'pdfs[]' && value instanceof File) {
      uploaded.set(value.name, new Uint8Array(await value.arrayBuffer()));
    }
  }

  if (uploaded.size === 0) {
    return jsonResponse({ error: 'No se recibieron archivos.' }, 400);
  }

  const outputDoc   = await PDFDocument.create();
  let processed     = 0;
  const failed: string[] = [];
  const processOrder = order.length > 0 ? order : [...uploaded.keys()];

  for (const name of processOrder) {
    const bytes = uploaded.get(name);
    if (!bytes) { addLog('warn', `No encontrado: ${name}`); continue; }

    addLog('info', `Procesando: ${name}`);

    // Intento 1
    let ok = await tryPdfLib(outputDoc, bytes);
    if (ok) { addLog('ok', `OK (pdf-lib): ${name}`); processed++; continue; }

    // Intento 2
    addLog('info', `Fallback rasterización: ${name}`);
    ok = await tryPdfjsRaster(outputDoc, bytes);

    if (ok) {
      addLog('ok', `OK (rasterizado): ${name}`);
      processed++;
    } else {
      addLog('error', `No procesado: ${name}`);
      failed.push(name);
    }
  }

  if (processed === 0) {
    return jsonResponse({ error: 'Ningún archivo pudo procesarse.', log }, 422);
  }

  const pdfBytes = await outputDoc.save();
  const b64      = uint8ToBase64(pdfBytes);

  return jsonResponse({ pdf: b64, pages: processed, failed, log }, 200);
}

// ── Utilidades ────────────────────────────────────────────────────────────────

function jsonResponse(body: SuccessResponse | ErrorResponse, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}