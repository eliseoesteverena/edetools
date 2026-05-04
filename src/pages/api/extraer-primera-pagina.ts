// src/pages/api/extraer-primera-pagina.ts
//
// Cloudflare Worker — reemplaza process.php
//
// Este endpoint maneja DOS tipos de request:
//
//   POST /api/extraer-primera-pagina
//     body: FormData con campo "mode"
//
//   mode = "extract"  (paso 1)
//     Recibe PDFs. Por cada uno intenta copiar la primera página con pdf-lib.
//     Devuelve:
//       - pdf_parcial: base64 del PDF con las páginas que sí se pudieron copiar
//       - failed: array de { name, data: base64 } con los PDFs que fallaron
//         para que el cliente los rasterice con PDF.js y los reenvíe
//
//   mode = "merge" (paso 2, opcional)
//     Recibe el pdf_parcial (base64) + imágenes PNG ya rasterizadas por el cliente.
//     Las embebe en el PDF parcial y devuelve el PDF final.
//
// Este diseño mantiene toda la lógica de rasterización en el browser (PDF.js),
// que es el único entorno donde funciona sin restricciones de runtime.

import { PDFDocument } from 'pdf-lib';

export const prerender = false;

interface LogEntry {
  type: 'ok' | 'info' | 'warn' | 'error';
  msg: string;
}

// ── Modo "extract": copia directa con pdf-lib ─────────────────────────────────

async function handleExtract(formData: FormData): Promise<Response> {
  const log: LogEntry[] = [];
  const addLog = (type: LogEntry['type'], msg: string) => log.push({ type, msg });

  const orderRaw  = formData.get('order');
  const order: string[] = orderRaw ? JSON.parse(orderRaw as string) : [];

  const uploaded = new Map<string, Uint8Array>();
  for (const [key, value] of formData.entries()) {
    if (key === 'pdfs[]' && value instanceof File) {
      uploaded.set(value.name, new Uint8Array(await value.arrayBuffer()));
    }
  }

  if (uploaded.size === 0) {
    return json({ error: 'No se recibieron archivos.' }, 400);
  }

  const outputDoc = await PDFDocument.create();
  const processOrder = order.length > 0 ? order : [...uploaded.keys()];

  // PDFs que pdf-lib no pudo copiar — se devuelven al cliente para rasterizar
  const failed: { name: string; data: string }[] = [];
  // Orden final para el merge posterior
  const pageOrder: { name: string; source: 'pdflib' | 'raster' }[] = [];

  for (const name of processOrder) {
    const bytes = uploaded.get(name);
    if (!bytes) { addLog('warn', `No encontrado: ${name}`); continue; }

    addLog('info', `Procesando: ${name}`);

    try {
      const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      if (srcDoc.getPageCount() === 0) throw new Error('sin páginas');
      const [firstPage] = await outputDoc.copyPages(srcDoc, [0]);
      outputDoc.addPage(firstPage);
      pageOrder.push({ name, source: 'pdflib' });
      addLog('ok', `OK (pdf-lib): ${name}`);
    } catch (e: any) {
      addLog('info', `Requiere rasterización: ${name} — ${e.message}`);
      // Devolver el PDF crudo al cliente en base64
      failed.push({ name, data: uint8ToBase64(bytes) });
      // Reservar posición en el orden (se completará en el merge)
      pageOrder.push({ name, source: 'raster' });
    }
  }

  const pdfParcial = uint8ToBase64(await outputDoc.save());

  return json({
    pdf_parcial: pdfParcial,
    page_order:  pageOrder,
    failed,
    log,
  }, 200);
}

// ── Modo "merge": embebe las imágenes rasterizadas por el cliente ─────────────

async function handleMerge(formData: FormData): Promise<Response> {
  const log: LogEntry[] = [];
  const addLog = (type: LogEntry['type'], msg: string) => log.push({ type, msg });

  const parcialB64 = formData.get('pdf_parcial') as string | null;
  const pageOrderRaw = formData.get('page_order') as string | null;

  if (!parcialB64 || !pageOrderRaw) {
    return json({ error: 'Faltan parámetros para el merge.' }, 400);
  }

  const pageOrder: { name: string; source: 'pdflib' | 'raster' }[] =
    JSON.parse(pageOrderRaw);

  // Cargar el PDF parcial (páginas ya copiadas por pdf-lib)
  const parcialBytes  = base64ToUint8(parcialB64);
  const parcialDoc    = await PDFDocument.load(parcialBytes);

  // Imágenes rasterizadas enviadas por el cliente
  const rasterImages = new Map<string, Uint8Array>();
  for (const [key, value] of formData.entries()) {
    if (key.startsWith('raster_') && value instanceof File) {
      const name = key.slice(7); // quitar prefijo "raster_"
      rasterImages.set(name, new Uint8Array(await value.arrayBuffer()));
    }
  }

  // Reconstruir el PDF en el orden correcto
  const finalDoc = await PDFDocument.create();
  let pdflibIdx  = 0; // cursor en las páginas del parcialDoc

  for (const item of pageOrder) {
    if (item.source === 'pdflib') {
      const [page] = await finalDoc.copyPages(parcialDoc, [pdflibIdx]);
      finalDoc.addPage(page);
      pdflibIdx++;
      addLog('ok', `Página copiada (pdf-lib): ${item.name}`);
    } else {
      const pngBytes = rasterImages.get(item.name);
      if (!pngBytes) {
        addLog('error', `Imagen no recibida para: ${item.name}`);
        continue;
      }
      try {
        const pngImage = await finalDoc.embedPng(pngBytes);
        const { width, height } = pngImage.scale(1);
        // Convertir px a pts: PNG fue renderizado a 150dpi, 1pt = 1/72in
        const scale = 72 / 150;
        const page  = finalDoc.addPage([width * scale, height * scale]);
        page.drawImage(pngImage, { x: 0, y: 0, width: width * scale, height: height * scale });
        addLog('ok', `Página rasterizada: ${item.name}`);
      } catch (e: any) {
        addLog('error', `Error embebiendo imagen ${item.name}: ${e.message}`);
      }
    }
  }

  const finalBytes = await finalDoc.save();
  return json({ pdf: uint8ToBase64(finalBytes), pages: finalDoc.getPageCount(), log }, 200);
}

// ── Handler principal ─────────────────────────────────────────────────────────

export async function POST({ request }: { request: Request }): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: 'No se pudo parsear el formulario.' }, 400);
  }

  const mode = formData.get('mode') as string | null;

  if (mode === 'merge')   return handleMerge(formData);
  return handleExtract(formData); // default: 'extract'
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

// ── Utilidades ────────────────────────────────────────────────────────────────

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type':                'application/json',
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

function base64ToUint8(b64: string): Uint8Array {
  const bin   = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}