import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, ShadingType,
  PositionalTab, PositionalTabAlignment, PositionalTabLeader, PositionalTabRelativeTo,
} from 'docx';

// Letterhead details for the signing side of the PO. Overridable via env for other deployments.
export const MCCIA_GSTIN = process.env.MCCIA_GSTIN || '27AAATM5559Q1ZS';
export const PO_SIGNATORY = process.env.PO_SIGNATORY || 'Chintamani Shrotri';
export const PO_SIGNATORY_TITLE = process.env.PO_SIGNATORY_TITLE || 'Director';

export const TERMS = [
  '100% payment within 15 working days from the date of receipt of Invoice and compliance reports. GST amount will be released after confirmation of GST payment on government website.',
  'GST Extra @18% on purchase only.',
  'Any dispute arising out of the deal will be settled within jurisdiction of Pune Civil Court.',
  'Goods / items supplied to MCCIA should be with same specification and quality as approved by MCCIA Authorities. Any variation in quality and specification will lead to rejection and will be subject to replacement of the unit.',
];

const inr = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtDate(value) {
  const d = new Date(String(value || '').replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(value || '').slice(0, 10);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function cell(text, { width, header = false, align = AlignmentType.LEFT, columnSpan } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    columnSpan,
    shading: header ? { type: ShadingType.CLEAR, fill: 'F0F3F6' } : undefined,
    children: [new Paragraph({ alignment: align, children: [new TextRun({ text: String(text), bold: header })] })],
  });
}

function buildTable(lines) {
  const widths = [700, 4300, 1600, 1600, 1800];
  const total = lines.reduce((sum, l) => sum + l.quantity * l.rate, 0);

  const header = new TableRow({ children: [
    cell('Sr.No.', { width: widths[0], header: true }),
    cell('Particulars', { width: widths[1], header: true }),
    cell('Quantity (Units)', { width: widths[2], header: true, align: AlignmentType.CENTER }),
    cell('Rate (Rs.)', { width: widths[3], header: true, align: AlignmentType.RIGHT }),
    cell('Amount (Rs.)', { width: widths[4], header: true, align: AlignmentType.RIGHT }),
  ] });

  const body = lines.map((l, i) => new TableRow({ children: [
    cell(i + 1, { width: widths[0] }),
    cell(`${l.item_name}${l.unit ? ` (${l.unit})` : ''}`, { width: widths[1] }),
    cell(l.quantity, { width: widths[2], align: AlignmentType.CENTER }),
    cell(inr(l.rate), { width: widths[3], align: AlignmentType.RIGHT }),
    cell(inr(l.quantity * l.rate), { width: widths[4], align: AlignmentType.RIGHT }),
  ] }));

  const totalRow = new TableRow({ children: [
    cell('Total', { width: widths[0] + widths[1] + widths[2] + widths[3], header: true, align: AlignmentType.RIGHT, columnSpan: 4 }),
    cell(inr(total), { width: widths[4], header: true, align: AlignmentType.RIGHT }),
  ] });

  return new Table({ width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: widths, rows: [header, ...body, totalRow] });
}

// Builds a .docx buffer for a purchase order, in the same letter layout MCCIA already
// uses for vendor POs: vendor block + date, items table, standard terms, signed by the director.
export async function buildPoDocx(po, lines) {
  const children = [
    new Paragraph({ children: [
      new TextRun({ text: po.vendor, bold: true }),
      new PositionalTab({ alignment: PositionalTabAlignment.RIGHT, relativeTo: PositionalTabRelativeTo.MARGIN, leader: PositionalTabLeader.NONE }),
      new TextRun({ text: `Date: ${fmtDate(po.created_at)}` }),
    ] }),
  ];
  if (po.vendor_address) children.push(new Paragraph({ children: [new TextRun(po.vendor_address)] }));
  const tax = [po.vendor_gstin && `GSTIN/UIN: ${po.vendor_gstin}`, po.vendor_pan && `PAN: ${po.vendor_pan}`].filter(Boolean);
  if (tax.length) children.push(new Paragraph({ children: [new TextRun(tax.join('    '))] }));

  children.push(
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun('Dear Sir,')] }),
    new Paragraph({ children: [new TextRun('Please refer to mentioned details for providing the items below. (1) Details of work & rates:')] }),
    new Paragraph({ text: '' }),
    buildTable(lines),
    new Paragraph({ text: '' }),
  );
  if (po.notes) children.push(new Paragraph({ children: [new TextRun(po.notes)] }), new Paragraph({ text: '' }));

  children.push(
    new Paragraph({ children: [new TextRun({ text: 'Terms & Conditions:', bold: true })] }),
    ...TERMS.map((t, i) => new Paragraph({ children: [new TextRun(`(${i + 1}) ${t}`)] })),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun('Regards,')] }),
    new Paragraph({ children: [new TextRun({ text: PO_SIGNATORY, bold: true })] }),
    new Paragraph({ children: [new TextRun(`${PO_SIGNATORY_TITLE} (MCCIA GSTIN: ${MCCIA_GSTIN})`)] }),
  );

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
