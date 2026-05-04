// src/pages/api/extraer-primera-pagina.ts
//
// Cloudflare Function (Pages Functions via Astro hybrid mode).
// Equivalente al process.php original.
//
// Flujo por archivo:
//   1. Intenta copiar la página con pdf-lib (equivalente a FPDI)
//   2. Si falla, rasteriza con MuPDF WASM a PNG y la embebe (equivalente a Imagick)
//
// Límites de Cloudflare Workers a tener en cuenta:
//   - CPU time: 50ms en plan gratuito, 30s en plan Paid
//   - Memory: 128MB
//   - Request body: 100MB máx
//
// Para lotes grandes o PDFs muy pesados considerar el plan Paid.

import { PDFDocument } from 'pdf-lib';

export const prerender = false; // Este endpoint es dinámico, no estático

// ── Tipos ────────────────────────────────────────────────────────────────────

interface LogEntry {
  type: 'ok' | 'info' | 'warn' | 'error';
  msg: string;
}

interface SuccessResponse {
  pdf: string;       // base64
  pages: number;
  failed: string[];
  log: LogEntry[];
}

interface ErrorResponse {
  error: string;
  log?: LogEntry[];
}

// ── Helper: intentar extracción directa con pdf-lib ──────────────────────────
// Equivalente a extract_first_page_fpdi() en PHP.
// pdf-lib copia la página como XObject — funciona en la mayoría de los PDFs.

async function tryPdfLib(
  outputDoc: PDFDocument,
  fileBytes: Uint8Array,
): Promise<boolean> {
  try {
    const srcDoc = await PDFDocument.load(fileBytes, {
      // Ignorar errores de encriptación parcial para intentar igual
      ignoreEncryption: true,
    });
    const [firstPage] = await outputDoc.copyPages(srcDoc, [0]);
    outputDoc.addPage(firstPage);
    return true;
  } catch {
    return false;
  }
}

// ── Helper: rasterizar con MuPDF WASM ────────────────────────────────────────
// Equivalente a rasterize_and_extract() con Imagick en PHP.
// Renderiza la página a PNG y la embebe como imagen en el PDF de salida.
// Se usa como fallback cuando pdf-lib no puede copiar la página directamente.

async function tryMuPDF(
  outputDoc: PDFDocument,
  fileBytes: Uint8Array,
): Promise<boolean> {
  try {
    // Importación dinámica — MuPDF es WASM y carga de forma asíncrona
    // @ts-ignore — tipado no incluido en el paquete
    const mupdf = await import('mupdf');
    await mupdf.ready;

    // Abrir el documento
    const doc = mupdf.Document.openDocument(fileBytes, 'application/pdf');
    const page = doc.loadPage(0); // página 0 = primera

    // Renderizar a 150 DPI (equivalente a la resolución del PHP)
    // Matrix de escala: 150/72 ≈ 2.0833
    const scale = 150 / 72;
    const matrix = mupdf.Matrix.scale(scale, scale);
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);

    // Exportar a PNG como ArrayBuffer
    const pngData: Uint8Array = pixmap.asPNG();

    // Dimensiones originales en puntos (1pt = 1/72 inch)
    const bounds = page.getBounds();
    const widthPt  = bounds[2] - bounds[0];
    const heightPt = bounds[3] - bounds[1];

    // Convertir a mm para las dimensiones de la página PDF de salida
    const widthMm  = (widthPt  / 72) * 25.4;
    const heightMm = (heightPt / 72) * 25.4;

    // Embeber el PNG en el PDF de salida
    const pngImage = await outputDoc.embedPng(pngData);
    const newPage  = outputDoc.addPage(
      [widthMm, heightMm],           // tamaño en puntos (pdf-lib usa pts internamente)
      // pdf-lib usa puntos: convertir mm -> pts
      // width = widthMm / 25.4 * 72, pero addPage acepta pts directamente
    );

    // Dibujar la imagen ocupando toda la página
    newPage.drawImage(pngImage, {
      x:      0,
      y:      0,
      width:  widthPt,
      height: heightPt,
    });

    // Cleanup
    pixmap.destroy();
    page.destroy();
    doc.destroy();

    return true;
  } catch {
    return false;
  }
}

// ── Handler principal ────────────────────────────────────────────────────────

export async function POST({ request }: { request: Request }): Promise<Response> {
  const log: LogEntry[] = [];

  const addLog = (type: LogEntry['type'], msg: string) => log.push({ type, msg });

  // Parsear el multipart/form-data
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (e: any) {
    return jsonResponse({ error: 'No se pudo parsear el formulario.', log }, 400);
  }

  // Orden de procesamiento
  const orderRaw = formData.get('order');
  const order: string[] = orderRaw
    ? JSON.parse(orderRaw as string)
    : [];

  // Recopilar archivos
  const uploaded = new Map<string, Uint8Array>();
  for (const [key, value] of formData.entries()) {
    if (key === 'pdfs[]' && value instanceof File) {
      const ab = await value.arrayBuffer();
      uploaded.set(value.name, new Uint8Array(ab));
    }
  }

  if (uploaded.size === 0) {
    return jsonResponse({ error: 'No se recibieron archivos.' }, 400);
  }

  // Documento de salida
  const outputDoc = await PDFDocument.create();
  let processed = 0;
  const failed: string[] = [];

  // Procesar en el orden indicado por el frontend
  const processOrder = order.length > 0 ? order : [...uploaded.keys()];

  for (const name of processOrder) {
    const bytes = uploaded.get(name);
    if (!bytes) {
      addLog('warn', `No encontrado: ${name}`);
      continue;
    }

    addLog('info', `Procesando: ${name}`);

    // Intento 1: pdf-lib (copia directa, sin rasterizar)
    let ok = await tryPdfLib(outputDoc, bytes);

    if (ok) {
      addLog('ok', `OK (pdf-lib): ${name}`);
      processed++;
      continue;
    }

    // Intento 2: MuPDF WASM (rasterización)
    addLog('info', `Fallback MuPDF: ${name}`);
    ok = await tryMuPDF(outputDoc, bytes);

    if (ok) {
      addLog('ok', `OK (mupdf): ${name}`);
      processed++;
    } else {
      addLog('error', `No procesado: ${name}`);
      failed.push(name);
    }
  }

  if (processed === 0) {
    return jsonResponse(
      { error: 'Ningún archivo pudo procesarse.', log },
      422,
    );
  }

  // Serializar el PDF de salida
  const pdfBytes = await outputDoc.save();
  const b64 = uint8ToBase64(pdfBytes);

  const response: SuccessResponse = { pdf: b64, pages: processed, failed, log };
  return jsonResponse(response, 200);
}

// ── Utilidades ───────────────────────────────────────────────────────────────

function jsonResponse(body: SuccessResponse | ErrorResponse, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// btoa no maneja Uint8Array directamente en todos los entornos
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Preflight CORS (por si el browser lo requiere)
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
