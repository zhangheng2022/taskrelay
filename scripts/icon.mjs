// Generate every icon from the approved TR vector master. Run: npm run icons.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "../resources");
const master = await readFile(path.join(root, "brand-mark.svg"), "utf8");
const paths = master.match(/<path\b[^>]*\/>/g)?.join("\n");
if (!paths || !master.includes('viewBox="0 0 460 300"')) {
  throw new Error("Unexpected brand-mark.svg geometry; review the icon framing.");
}
// White relay mark on a neutral tile stays visible on both light and dark shells.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect x="8" y="8" width="496" height="496" rx="112" fill="#171717" stroke="#737373" stroke-width="4"/>
  <g fill="#fff" transform="translate(72 136) scale(.8)">${paths}</g>
</svg>\n`;
await writeFile(path.join(root, "icon.svg"), svg);
async function png(size) {
  return sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png().toBuffer();
}
await writeFile(path.join(root, "icon.png"), await png(256));
await writeFile(path.join(root, "apple-touch-icon.png"), await png(180));

// Each Windows icon size is rendered independently, not enlarged from a thumbnail.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(png));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [i, size] of sizes.entries()) {
  const entry = 6 + i * 16;
  header[entry] = header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
}
await writeFile(path.join(root, "icon.ico"), Buffer.concat([header, ...images]));
console.log(
  "Generated icon.svg, icon.png, apple-touch-icon.png and 7-size icon.ico from brand-mark.svg.",
);
