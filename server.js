const express = require('express');
const PDFDocument = require('pdfkit');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ── Variables de entorno (configurar en Railway) ──────────────────────────────
const PORT          = process.env.PORT || 3000;
const RESEND_APIKEY = process.env.RESEND_APIKEY;         // re_gAgkUnXr_...
const SUPABASE_URL  = process.env.SUPABASE_URL;          // https://ymbsqtjvrrpnemegqwji.supabase.co
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;  // service_role key (no la anon)
const GARANTIA_MESES = parseInt(process.env.GARANTIA_MESES || '6');

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ ok: true, service: 'garantia-pdf', version: '1.0' }));

// ── POST /generar-garantia ────────────────────────────────────────────────────
// Body esperado:
// {
//   nombre_cliente: "Laura García",
//   email_cliente:  "laura@email.com",
//   telefono:       "+5491112345678",   (opcional)
//   direccion:      "Sarmiento 890, Palermo",
//   equipo:         "Split inverter 3000 frig. Carrier",
//   trabajo:        "Instalación",      (o "Mantenimiento")
//   tecnico:        "Juan Ramírez",
//   monto_total:    115500,
//   numero_trabajo: "RAF-00234",        (opcional)
// }
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

    // 1. Generar PDF en memoria
    const pdfBuffer = await generarPDF({
      nombre_cliente, email_cliente, telefono,
      direccion, equipo, trabajo, tecnico,
      monto_total, numero_trabajo,
    });

    // 2. Subir PDF a Supabase Storage
    const fileName = `garantias/${numero_trabajo || Date.now()}_${nombre_cliente.replace(/\s+/g,'-')}.pdf`;
    const { error: upErr } = await sb.storage
      .from('garantias')
      .upload(fileName, pdfBuffer, { contentType: 'application/pdf', upsert: true });

    let pdfUrl = '';
    if (!upErr) {
      const { data: urlData } = sb.storage.from('garantias').getPublicUrl(fileName);
      pdfUrl = urlData?.publicUrl || '';
    }

    // 3. Enviar email con PDF adjunto via Resend
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

// ── Generar PDF con pdfkit ────────────────────────────────────────────────────
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

    // ── Colores ──
    const AZUL   = '#1a56db';
    const VERDE  = '#057a55';
    const GRIS   = '#6b7280';
    const NEGRO  = '#111827';
    const BGCARD = '#f3f4f6';

    // ── Encabezado ──
    doc.rect(0, 0, doc.page.width, 110).fill(AZUL);

    doc.fillColor('#ffffff')
       .font('Helvetica-Bold').fontSize(26)
       .text('❄ Instalaciones A/C', 60, 28, { align: 'left' });

    doc.font('Helvetica').fontSize(11)
       .text('Instalación · Mantenimiento · Service', 60, 58, { align: 'left' });

    doc.font('Helvetica').fontSize(10)
       .text(`N° ${nroTrab}`, 60, 80, { align: 'left' })
       .text(`Fecha: ${fechaHoy}`, 0, 80, { align: 'right', width: doc.page.width - 60 });

    doc.fillColor(NEGRO).moveDown(3);

    // ── Título certificado ──
    doc.y = 130;
    doc.font('Helvetica-Bold').fontSize(18).fillColor(VERDE)
       .text('CERTIFICADO DE GARANTÍA', { align: 'center' });

    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(11).fillColor(GRIS)
       .text(`Trabajo: ${trabajo} de equipo de aire acondicionado`, { align: 'center' });

    doc.moveDown(1.2);

    // ── Caja datos del cliente ──
    const cardY = doc.y;
    doc.roundedRect(60, cardY, doc.page.width - 120, 120, 8).fill(BGCARD);

    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(10).text('DATOS DEL CLIENTE', 80, cardY + 14);
    doc.moveTo(80, cardY + 28).lineTo(doc.page.width - 80, cardY + 28).stroke(AZUL);

    const filaCliente = [
      ['Titular',    nombre_cliente],
      ['Dirección',  direccion || '—'],
    ];
    let rowY = cardY + 36;
    filaCliente.forEach(([lbl, val]) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRIS).text(lbl, 80, rowY);
      doc.font('Helvetica').fontSize(10).fillColor(NEGRO).text(val, 180, rowY);
      rowY += 20;
    });
    doc.y = cardY + 130;

    doc.moveDown(1);

    // ── Caja trabajo y garantía ──
    const card2Y = doc.y;
    doc.roundedRect(60, card2Y, doc.page.width - 120, 160, 8).fill(BGCARD);

    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(10).text('DETALLE DEL TRABAJO Y GARANTÍA', 80, card2Y + 14);
    doc.moveTo(80, card2Y + 28).lineTo(doc.page.width - 80, card2Y + 28).stroke(VERDE);

    const filasTrabajo = [
      ['Equipo',          equipo || '—'],
      ['Tipo de trabajo', trabajo],
      ['Técnico',         tecnico || '—'],
      ['Monto abonado',   montoFmt],
      ['Inicio garantía', fechaHoy],
      ['Vence',           fechaVto],
      ['Duración',        `${GARANTIA_MESES} meses`],
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

    // ── Alcance de la garantía ──
    doc.font('Helvetica-Bold').fontSize(11).fillColor(AZUL)
       .text('Alcance de la garantía');
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(9).fillColor(NEGRO);
    const items = [
      '• Mano de obra del trabajo realizado por defectos de instalación o service.',
      '• Revisita sin costo ante fallas originadas en el trabajo ejecutado.',
      '• Garantía válida presentando este documento.',
    ];
    items.forEach(item => {
      doc.text(item, { indent: 10, lineGap: 3 });
    });

    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#dc2626')
       .text('No cubre:');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor(NEGRO);
    const noItems = [
      '• Daños por mal uso, sobrecargas eléctricas o agentes externos.',
      '• Fallas en el equipo no relacionadas con el trabajo realizado.',
      '• Trabajos realizados por terceros sobre la misma instalación.',
    ];
    noItems.forEach(item => {
      doc.text(item, { indent: 10, lineGap: 3 });
    });

    doc.moveDown(2);

    // ── Firma ──
    const firmaY = doc.y;
    doc.moveTo(60, firmaY).lineTo(220, firmaY).stroke('#d1d5db');
    doc.font('Helvetica').fontSize(9).fillColor(GRIS)
       .text('Firma y sello del técnico', 60, firmaY + 4);
    doc.moveTo(doc.page.width - 220, firmaY).lineTo(doc.page.width - 60, firmaY).stroke('#d1d5db');
    doc.text('Instalaciones A/C — Sello', doc.page.width - 220, firmaY + 4);

    // ── Footer ──
    doc.rect(0, doc.page.height - 40, doc.page.width, 40).fill(AZUL);
    doc.font('Helvetica').fontSize(8).fillColor('#ffffff')
       .text(
         'Instalaciones A/C · instalacionesaac@gmail.com · +54 9 11 3233-9552',
         0, doc.page.height - 28, { align: 'center', width: doc.page.width }
       );

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
        <h2 style="color:#fff;margin:0">❄ Instalaciones A/C</h2>
        <p style="color:#bfdbfe;margin:6px 0 0;font-size:.9rem">Certificado de Garantía</p>
      </div>
      <div style="background:#fff;padding:24px 28px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none">
        <p>Hola <strong>${nombre_cliente}</strong>,</p>
        <p>¡Gracias por confiar en nosotros! Tu trabajo quedó registrado y el pago de <strong>${montoFmt}</strong> fue confirmado.</p>
        <p>Adjuntamos tu <strong>certificado de garantía</strong>${nro ? ` N° ${nro}` : ''}.${pdfUrl ? ` También podés <a href="${pdfUrl}">descargarlo desde este link</a>.` : ''}</p>
        <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px;margin:18px 0">
          <strong style="color:#15803d">✅ Tu garantía está activa</strong><br/>
          <span style="font-size:.88rem;color:#374151">Guardá este email como comprobante. Ante cualquier consulta, contactanos por WhatsApp o email.</span>
        </div>
        <p style="font-size:.82rem;color:#6b7280">Instalaciones A/C · +54 9 11 3233-9552 · instalacionesaac@gmail.com</p>
      </div>
    </div>`;

  const payload = {
    from:    'Instalaciones A/C <onboarding@resend.dev>',
    to:      [email_cliente],
    subject: `✅ Tu garantía — Instalaciones A/C${nro ? ' · ' + nro : ''}`,
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
app.listen(PORT, () => console.log(`✅ Garantia PDF service running on port ${PORT}`));
