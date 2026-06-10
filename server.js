const express = require('express');
const PDFDocument = require('pdfkit');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ── Variables de entorno (configurar en Railway) ──────────────────────────────
const PORT          = process.env.PORT || 3000;
const RESEND_APIKEY = process.env.RESEND_APIKEY;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const GARANTIA_MESES = parseInt(process.env.GARANTIA_MESES || '6');
const GOOGLE_SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON; // opcional

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ ok: true, service: 'garantia-pdf', version: '2.0' }));

// ── POST /generar-garantia ────────────────────────────────────────────────────
app.post('/generar-garantia', async (req, res) => {
  try {
    const {
      nombre_cliente = 'Cliente',
      email_cliente,
      telefono        = '',
      direccion       = '',
      equipo          = '',
      trabajo         = 'Instalación',
      tecnico         = '',
      monto_total     = 0,
      numero_trabajo  = '',
    } = req.body;

    if (!email_cliente) {
      return res.status(400).json({ error: 'email_cliente es requerido' });
    }

    const pdfBuffer = await generarPDF({
      nombre_cliente, email_cliente, telefono,
      direccion, equipo, trabajo, tecnico,
      monto_total, numero_trabajo,
    });

    const fileName = `garantias/${numero_trabajo || Date.now()}_${nombre_cliente.replace(/\s+/g,'-')}.pdf`;
    const { error: upErr } = await sb.storage
      .from('garantias')
      .upload(fileName, pdfBuffer, { contentType: 'application/pdf', upsert: true });

    let pdfUrl = '';
    if (!upErr) {
      const { data: urlData } = sb.storage.from('garantias').getPublicUrl(fileName);
      pdfUrl = urlData?.publicUrl || '';
    }

    const emailOk = await enviarEmailGarantia({ nombre_cliente, email_cliente, pdfBuffer, pdfUrl, numero_trabajo, monto_total });

    res.json({
      ok: true,
      pdf_url: pdfUrl,
      email_enviado: emailOk,
      mensaje: `Garantía generada y enviada a ${email_cliente}`,
    });

  } catch (err) {
    console.error('Error /generar-garantia:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /archivar-trabajo ────────────────────────────────────────────────────
// Body esperado:
// {
//   trabajo_id:     "uuid del trabajo",
//   nombre_cliente: "González, Pedro",
//   email_cliente:  "pedro@mail.com",
//   telefono:       "11-1234-5678",
//   direccion:      "Sarmiento 890, Palermo",
//   equipo:         "Split inverter 3000 frig. Carrier",
//   tipo_trabajo:   "Instalación",
//   tecnico:        "Juan Ramírez",
//   monto_total:    115500,
//   numero_trabajo: "RAF-00234",
// }
app.post('/archivar-trabajo', async (req, res) => {
  try {
    const {
      trabajo_id,
      nombre_cliente = 'Cliente',
      email_cliente  = '',
      telefono       = '',
      direccion      = '',
      equipo         = '',
      tipo_trabajo   = 'Instalación',
      tecnico        = '',
      monto_total    = 0,
      numero_trabajo = '',
    } = req.body;

    // 1. Generar PDF resumen del trabajo archivado
    const pdfBuffer = await generarPDFResumen({
      nombre_cliente, email_cliente, telefono,
      direccion, equipo, tipo_trabajo, tecnico,
      monto_total, numero_trabajo,
    });

    // 2. Subir PDF a Supabase Storage (bucket comprobantes)
    const fechaHoy = new Date().toISOString().split('T')[0];
    const fileName = `archivados/${fechaHoy}_${numero_trabajo || Date.now()}_${nombre_cliente.replace(/\s+/g,'-')}.pdf`;
    let pdfUrl = '';

    const { error: upErr } = await sb.storage
      .from('comprobantes')
      .upload(fileName, pdfBuffer, { contentType: 'application/pdf', upsert: true });

    if (!upErr) {
      const { data: urlData } = sb.storage.from('comprobantes').getPublicUrl(fileName);
      pdfUrl = urlData?.publicUrl || '';
    } else {
      console.warn('Error subiendo a Supabase Storage:', upErr.message);
    }

    // 3. Subir a Google Drive (si hay credenciales configuradas)
    let driveUrl = '';
    if (GOOGLE_SA_JSON) {
      try {
        driveUrl = await subirADrive(pdfBuffer, nombre_cliente, numero_trabajo, fechaHoy);
      } catch (driveErr) {
        console.warn('Google Drive no disponible:', driveErr.message);
        // No bloqueamos: Drive es opcional
      }
    }

    // 4. Guardar en tabla trabajos_archivados
    const { error: dbErr } = await sb.from('trabajos_archivados').insert({
      trabajo_id:     trabajo_id || null,
      nombre_cliente,
      email_cliente,
      telefono,
      direccion,
      equipo,
      tipo_trabajo,
      tecnico,
      monto_total,
      numero_trabajo,
      pdf_url:        pdfUrl,
      drive_url:      driveUrl,
    });

    if (dbErr) console.error('Error guardando trabajos_archivados:', dbErr.message);

    // 5. Marcar trabajo original como archivado (si tiene ID)
    if (trabajo_id) {
      await sb.from('trabajos').update({ estado: 'archivado' }).eq('id', trabajo_id);
    }

    res.json({
      ok: true,
      pdf_url: pdfUrl,
      drive_url: driveUrl,
      mensaje: `Trabajo archivado: ${nombre_cliente}`,
    });

  } catch (err) {
    console.error('Error /archivar-trabajo:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Subir PDF a Google Drive ──────────────────────────────────────────────────
async function subirADrive(pdfBuffer, nombre_cliente, numero_trabajo, fechaHoy) {
  const { google } = require('googleapis');

  const saKey = JSON.parse(GOOGLE_SA_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: saKey,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  const drive = google.drive({ version: 'v3', auth });

  // Buscar o crear la carpeta destino
  const folderName = 'trabajos realizados de instalacion matriculado';
  const folderSearch = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
  });

  let folderId;
  if (folderSearch.data.files.length > 0) {
    folderId = folderSearch.data.files[0].id;
  } else {
    // Crear la carpeta si no existe
    const folder = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    });
    folderId = folder.data.id;
  }

  // Subir el PDF
  const { Readable } = require('stream');
  const stream = Readable.from(pdfBuffer);
  const pdfName = `${fechaHoy}_${numero_trabajo || 'trabajo'}_${nombre_cliente.replace(/\s+/g,'-')}.pdf`;

  const uploaded = await drive.files.create({
    requestBody: {
      name: pdfName,
      mimeType: 'application/pdf',
      parents: [folderId],
    },
    media: {
      mimeType: 'application/pdf',
      body: stream,
    },
    fields: 'id, webViewLink',
  });

  return uploaded.data.webViewLink || '';
}

// ── Generar PDF de garantía ───────────────────────────────────────────────────
function generarPDF(datos) {
  return new Promise((resolve, reject) => {
    const {
      nombre_cliente, direccion, equipo, trabajo,
      tecnico, monto_total, numero_trabajo,
    } = datos;

    const doc = new PDFDocument({ size: 'A4', margin: 60 });
    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const hoy       = new Date();
    const fechaHoy  = formatFecha(hoy);
    const fechaVto  = formatFecha(new Date(hoy.setMonth(hoy.getMonth() + GARANTIA_MESES)));
    const montoFmt  = '$' + Number(monto_total).toLocaleString('es-AR');
    const nroTrab   = numero_trabajo || ('GAR-' + Date.now());

    const AZUL   = '#1a56db';
    const VERDE  = '#057a55';
    const GRIS   = '#6b7280';
    const NEGRO  = '#111827';
    const BGCARD = '#f3f4f6';

    doc.rect(0, 0, doc.page.width, 110).fill(AZUL);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(26)
       .text('Instalaciones A/C', 60, 28, { align: 'left' });
    doc.font('Helvetica').fontSize(11)
       .text('Instalacion · Mantenimiento · Service', 60, 58, { align: 'left' });
    doc.font('Helvetica').fontSize(10)
       .text(`N  ${nroTrab}`, 60, 80, { align: 'left' })
       .text(`Fecha: ${fechaHoy}`, 0, 80, { align: 'right', width: doc.page.width - 60 });

    doc.fillColor(NEGRO).moveDown(3);

    doc.y = 130;
    doc.font('Helvetica-Bold').fontSize(18).fillColor(VERDE)
       .text('CERTIFICADO DE GARANTIA', { align: 'center' });
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(11).fillColor(GRIS)
       .text(`Trabajo: ${trabajo} de equipo de aire acondicionado`, { align: 'center' });
    doc.moveDown(1.2);

    const cardY = doc.y;
    doc.roundedRect(60, cardY, doc.page.width - 120, 120, 8).fill(BGCARD);
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(10).text('DATOS DEL CLIENTE', 80, cardY + 14);
    doc.moveTo(80, cardY + 28).lineTo(doc.page.width - 80, cardY + 28).stroke(AZUL);
    const filaCliente = [['Titular', nombre_cliente], ['Direccion', direccion || '-']];
    let rowY = cardY + 36;
    filaCliente.forEach(([lbl, val]) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRIS).text(lbl, 80, rowY);
      doc.font('Helvetica').fontSize(10).fillColor(NEGRO).text(val, 180, rowY);
      rowY += 20;
    });
    doc.y = cardY + 130;
    doc.moveDown(1);

    const card2Y = doc.y;
    doc.roundedRect(60, card2Y, doc.page.width - 120, 160, 8).fill(BGCARD);
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(10).text('DETALLE DEL TRABAJO Y GARANTIA', 80, card2Y + 14);
    doc.moveTo(80, card2Y + 28).lineTo(doc.page.width - 80, card2Y + 28).stroke(VERDE);
    const filasTrabajo = [
      ['Equipo', equipo || '-'],
      ['Tipo de trabajo', trabajo],
      ['Tecnico', tecnico || '-'],
      ['Monto abonado', montoFmt],
      ['Inicio garantia', fechaHoy],
      ['Vence', fechaVto],
      ['Duracion', `${GARANTIA_MESES} meses`],
    ];
    let rowY2 = card2Y + 36;
    filasTrabajo.forEach(([lbl, val]) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRIS).text(lbl, 80, rowY2);
      doc.font('Helvetica').fontSize(10)
         .fillColor(lbl === 'Vence' ? '#dc2626' : NEGRO)
         .text(val, 220, rowY2);
      rowY2 += 18;
    });
    doc.y = card2Y + 170;
    doc.moveDown(1.4);

    doc.font('Helvetica-Bold').fontSize(11).fillColor(AZUL).text('Alcance de la garantia');
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(9).fillColor(NEGRO);
    ['Mano de obra del trabajo realizado por defectos de instalacion o service.',
     'Revisita sin costo ante fallas originadas en el trabajo ejecutado.',
     'Garantia valida presentando este documento.'].forEach(item => {
      doc.text('- ' + item, { indent: 10, lineGap: 3 });
    });

    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#dc2626').text('No cubre:');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor(NEGRO);
    ['Danos por mal uso, sobrecargas electricas o agentes externos.',
     'Fallas en el equipo no relacionadas con el trabajo realizado.',
     'Trabajos realizados por terceros sobre la misma instalacion.'].forEach(item => {
      doc.text('- ' + item, { indent: 10, lineGap: 3 });
    });

    doc.moveDown(2);
    const firmaY = doc.y;
    doc.moveTo(60, firmaY).lineTo(220, firmaY).stroke('#d1d5db');
    doc.font('Helvetica').fontSize(9).fillColor(GRIS).text('Firma y sello del tecnico', 60, firmaY + 4);
    doc.moveTo(doc.page.width - 220, firmaY).lineTo(doc.page.width - 60, firmaY).stroke('#d1d5db');
    doc.text('Instalaciones A/C - Sello', doc.page.width - 220, firmaY + 4);

    doc.rect(0, doc.page.height - 40, doc.page.width, 40).fill(AZUL);
    doc.font('Helvetica').fontSize(8).fillColor('#ffffff')
       .text('Instalaciones A/C · instalacionesaac@gmail.com · +54 9 11 3233-9552',
             0, doc.page.height - 28, { align: 'center', width: doc.page.width });

    doc.end();
  });
}

// ── Generar PDF resumen de trabajo archivado ──────────────────────────────────
function generarPDFResumen(datos) {
  return new Promise((resolve, reject) => {
    const {
      nombre_cliente, email_cliente, telefono,
      direccion, equipo, tipo_trabajo, tecnico,
      monto_total, numero_trabajo,
    } = datos;

    const doc = new PDFDocument({ size: 'A4', margin: 60 });
    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fechaHoy = formatFecha(new Date());
    const montoFmt = '$' + Number(monto_total).toLocaleString('es-AR');
    const nroTrab  = numero_trabajo || ('TRB-' + Date.now());

    const AZUL  = '#1a56db';
    const VERDE = '#057a55';
    const GRIS  = '#6b7280';
    const NEGRO = '#111827';
    const BG    = '#f3f4f6';

    // Header
    doc.rect(0, 0, doc.page.width, 110).fill(AZUL);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(24)
       .text('Instalaciones A/C', 60, 25, { align: 'left' });
    doc.font('Helvetica').fontSize(11)
       .text('Registro de Trabajo Realizado', 60, 55, { align: 'left' });
    doc.fontSize(10)
       .text(`N  ${nroTrab}`, 60, 78)
       .text(`Fecha: ${fechaHoy}`, 0, 78, { align: 'right', width: doc.page.width - 60 });

    doc.fillColor(NEGRO);
    doc.y = 130;

    doc.font('Helvetica-Bold').fontSize(16).fillColor(VERDE)
       .text('RESUMEN DE TRABAJO ARCHIVADO', { align: 'center' });
    doc.moveDown(1.5);

    // Datos del cliente
    const c1Y = doc.y;
    doc.roundedRect(60, c1Y, doc.page.width - 120, 130, 8).fill(BG);
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(10).text('DATOS DEL CLIENTE', 80, c1Y + 14);
    doc.moveTo(80, c1Y + 28).lineTo(doc.page.width - 80, c1Y + 28).stroke(AZUL);
    const clienteRows = [
      ['Cliente',    nombre_cliente],
      ['Telefono',   telefono || '-'],
      ['Email',      email_cliente || '-'],
      ['Direccion',  direccion || '-'],
    ];
    let ry = c1Y + 36;
    clienteRows.forEach(([l, v]) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRIS).text(l, 80, ry);
      doc.font('Helvetica').fontSize(10).fillColor(NEGRO).text(v, 200, ry);
      ry += 20;
    });
    doc.y = c1Y + 140;
    doc.moveDown(1);

    // Datos del trabajo
    const c2Y = doc.y;
    doc.roundedRect(60, c2Y, doc.page.width - 120, 130, 8).fill(BG);
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(10).text('DATOS DEL TRABAJO', 80, c2Y + 14);
    doc.moveTo(80, c2Y + 28).lineTo(doc.page.width - 80, c2Y + 28).stroke(VERDE);
    const trabajoRows = [
      ['Equipo',        equipo || '-'],
      ['Tipo',          tipo_trabajo || '-'],
      ['Tecnico',       tecnico || '-'],
      ['Monto cobrado', montoFmt],
      ['Fecha',         fechaHoy],
    ];
    let ry2 = c2Y + 36;
    trabajoRows.forEach(([l, v]) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRIS).text(l, 80, ry2);
      doc.font('Helvetica').fontSize(10)
         .fillColor(l === 'Monto cobrado' ? VERDE : NEGRO)
         .text(v, 200, ry2);
      ry2 += 20;
    });
    doc.y = c2Y + 140;
    doc.moveDown(2);

    // Footer
    doc.rect(0, doc.page.height - 40, doc.page.width, 40).fill(AZUL);
    doc.font('Helvetica').fontSize(8).fillColor('#ffffff')
       .text('Instalaciones A/C · instalacionesaac@gmail.com · +54 9 11 3233-9552',
             0, doc.page.height - 28, { align: 'center', width: doc.page.width });

    doc.end();
  });
}

// ── Enviar email con Resend ──────────────────────────────────────────────────
async function enviarEmailGarantia({ nombre_cliente, email_cliente, pdfBuffer, pdfUrl, numero_trabajo, monto_total }) {
  if (!RESEND_APIKEY) { console.warn('RESEND_APIKEY no configurado'); return false; }

  const montoFmt = '$' + Number(monto_total).toLocaleString('es-AR');
  const nro      = numero_trabajo || '';

  const bodyHtml = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:28px;background:#f9fafb;border-radius:12px">
      <div style="background:#1a56db;padding:20px 28px;border-radius:8px 8px 0 0">
        <h2 style="color:#fff;margin:0">Instalaciones A/C</h2>
        <p style="color:#bfdbfe;margin:6px 0 0;font-size:.9rem">Certificado de Garantia</p>
      </div>
      <div style="background:#fff;padding:24px 28px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none">
        <p>Hola <strong>${nombre_cliente}</strong>,</p>
        <p>Gracias por confiar en nosotros! Tu trabajo quedo registrado y el pago de <strong>${montoFmt}</strong> fue confirmado.</p>
        <p>Adjuntamos tu <strong>certificado de garantia</strong>${nro ? ` N ${nro}` : ''}.${pdfUrl ? ` Tambien podes <a href="${pdfUrl}">descargarlo desde este link</a>.` : ''}</p>
        <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px;margin:18px 0">
          <strong style="color:#15803d">Tu garantia esta activa</strong><br/>
          <span style="font-size:.88rem;color:#374151">Guarda este email como comprobante. Ante cualquier consulta, contactanos por WhatsApp o email.</span>
        </div>
        <p style="font-size:.82rem;color:#6b7280">Instalaciones A/C · +54 9 11 3233-9552 · instalacionesaac@gmail.com</p>
      </div>
    </div>`;

  const payload = {
    from:    'Instalaciones A/C <onboarding@resend.dev>',
    to:      [email_cliente],
    subject: `Tu garantia - Instalaciones A/C${nro ? ' - ' + nro : ''}`,
    html:    bodyHtml,
    attachments: [{
      filename:    `garantia${nro ? '_' + nro : ''}.pdf`,
      content:     pdfBuffer.toString('base64'),
      content_type: 'application/pdf',
    }],
  };

  const resp = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${RESEND_APIKEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  const result = await resp.json();
  if (!resp.ok) { console.error('Resend error:', result); return false; }
  console.log('Email enviado:', result.id);
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatFecha(d) {
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Garantia PDF service v2 running on port ${PORT}`));
