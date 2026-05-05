// src/pages/api/recortar-etiquetas.ts
//
// Cloudflare Worker — reemplaza process.php
//
// El recorte es puramente geométrico: se crea una nueva página con las
// dimensiones recortadas y se embebe la página original desplazada (-left, -top).
// Equivalente exacto al useTemplate() con offset negativo de FPDI.

import { PDFDocument } from 'pdf-lib';

export const prerender = false;

// ── Perfiles de corte (en mm) — idénticos al PHP ─────────────────────────────

const PROFILES: Record<string, { top: number; right: number; bottom: number; left: number }> = {
  mercado_libre:    { top: 9,  right: 193, bottom: 11,  left: 9  },
  andreani:         { top: 4,  right: 106, bottom: 150, left: 4  },
  correo_argentino: { top: 18, right: 188, bottom: 23,  left: 17 },
};

// ── Conversión ────────────────────────────────────────────────────────────────

const MM_TO_PT = 72 / 25.4;

function mmToPt(mm: number): number {
  return mm * MM_TO_PT;
}

// ── Worker ────────────────────────────────────────────────────────────────────

export async function POST({ request }: { request: Request }): Promise<Response> {

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorJson('No se pudo parsear el formulario.', 400);
  }

  const profile = formData.get('profile') as string | null;
  if (!profile || !PROFILES[profile]) {
    return errorJson('Perfil de corte no válido.', 400);
  }

  const crop = PROFILES[profile];

  // Recopilar archivos en orden
  const files: { name: string; bytes: Uint8Array }[] = [];
  for (const [key, value] of formData.entries()) {
    if (key === 'pdfs[]' && value instanceof File) {
      files.push({
        name:  value.name,
        bytes: new Uint8Array(await value.arrayBuffer()),
      });
    }
  }

  if (files.length === 0) {
    return errorJson('No se recibieron archivos.', 400);
  }

  // Documento de salida
  const outputDoc = await PDFDocument.create();
  const errors: string[] = [];

  for (const { name, bytes } of files) {
    try {
      const srcDoc   = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const count    = srcDoc.getPageCount();

      for (let i = 0; i < count; i++) {
        const srcPage = srcDoc.getPage(i);
        const { width: origWPt, height: origHPt } = srcPage.getSize();

        // Convertir márgenes de mm a puntos
        const topPt    = mmToPt(crop.top);
        const rightPt  = mmToPt(crop.right);
        const bottomPt = mmToPt(crop.bottom);
        const leftPt   = mmToPt(crop.left);

        const cropWPt = origWPt - leftPt - rightPt;
        const cropHPt = origHPt - topPt  - bottomPt;

        if (cropWPt <= 0 || cropHPt <= 0) {
          errors.push(`${name} p.${i + 1}: márgenes exceden el tamaño de página`);
          continue;
        }

        // Embeber la página fuente como XObject
        const [embeddedPage] = await outputDoc.embedPages([srcPage]);

        // Nueva página con las dimensiones recortadas
        const newPage = outputDoc.addPage([cropWPt, cropHPt]);

        // Dibujar la página original desplazada hacia coordenadas negativas.
        // pdf-lib usa el sistema de coordenadas PDF (origen abajo-izquierda),
        // por lo que el desplazamiento vertical es: -(origH - cropH - top) = bottom - origH + cropH
        // Simplificado: y = -(origHPt - cropHPt - topPt) = bottomPt - origHPt + cropHPt
        // Que es equivalente a: y offset = -(topPt)  desde el borde superior
        // En coordenadas PDF (Y crece hacia arriba): y = cropHPt - origHPt + topPt
        const xOffset = -leftPt;
        const yOffset = cropHPt - origHPt + topPt;

        newPage.drawPage(embeddedPage, {
          x:      xOffset,
          y:      yOffset,
          width:  origWPt,
          height: origHPt,
        });
      }
    } catch (e: any) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  if (outputDoc.getPageCount() === 0) {
    return errorJson(
      `No se pudo procesar ninguna página. ${errors.join(' | ')}`,
      422,
    );
  }

  const pdfBytes = await outputDoc.save();
  const b64      = uint8ToBase64(pdfBytes);

  return new Response(
    JSON.stringify({ pdf: b64, pages: outputDoc.getPageCount(), errors }),
    {
      status: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
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

function errorJson(msg: string, status: number): Response {
  return new Response(JSON.stringify({ error: msg }), {
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
