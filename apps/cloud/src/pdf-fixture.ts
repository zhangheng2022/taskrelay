import { Buffer } from "node:buffer";

/** 探测 PDF 页面视觉而非文本抽取：数字只存在于单页灰度位图中。 */
export function scannedPdfFixture() {
  const glyphs = [
    ["10010", "10010", "10010", "11111", "00010", "00010", "00010"],
    ["11111", "00001", "00001", "11111", "10000", "10000", "11111"],
    ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  ];
  const scale = 8,
    width = 21 * scale,
    height = 11 * scale;
  const pixels = Buffer.alloc(width * height, 255);
  for (const [digit, rows] of glyphs.entries())
    for (const [y, row] of rows.entries())
      for (let x = 0; x < row.length; x++)
        if (row[x] === "1")
          for (let yy = 0; yy < scale; yy++) {
            const offset = ((y + 2) * scale + yy) * width + (2 + digit * 6 + x) * scale;
            pixels.fill(0, offset, offset + scale);
          }
  // PDF offsets count ASCII bytes. ASCIIHex images keep the fixture independent of native deps.
  const image = pixels.toString("hex") + ">";
  const paint = `q ${width} 0 0 ${height} 0 0 cm /Scan Do Q\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Scan 4 0 R >> >> /Contents 5 0 R >>`,
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${image.length} >>\nstream\n${image}\nendstream`,
    `<< /Length ${paint.length} >>\nstream\n${paint}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset.toString().padStart(10, "0") + " 00000 n \n";
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return "data:application/pdf;base64," + Buffer.from(pdf).toString("base64");
}
