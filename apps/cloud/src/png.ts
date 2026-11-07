import { imageLimits } from "../../../packages/contracts/src/images";

/** 校验桌面生成的非隔行 8 位灰度/RGB/RGBA PNG：结构、CRC、像素预算及完整压缩流。
 * 流式检查扫描行，拒绝截断、尾随内容与解压炸弹，不在 DO 内分配整张 RGBA 图。 */
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
export async function validateSnapshotPng(bytes: Uint8Array, maxBytes: number = imageLimits.bytes) {
  if (!bytes.length || bytes.length > maxBytes) throw Error("IMAGE_TOO_LARGE");
  const invalid = () => Error("PNG_REQUIRED");
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0,
    height = 0,
    channels = 0,
    ended = false,
    dataEnded = false;
  const compressed: Uint8Array[] = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw invalid();
    const length = view.getUint32(offset),
      end = offset + 12 + length;
    if (end > bytes.length) throw invalid();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)
    )
      throw invalid();
    const data = bytes.subarray(offset + 8, end - 4);
    if (offset === 8 && type !== "IHDR") throw invalid();
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) throw invalid();
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[data[9]] ?? 0;
      if (!width || !height || width * height > imageLimits.pixels)
        throw Error("IMAGE_PIXELS_EXCEEDED");
      if (!channels || data[8] !== 8 || data[10] || data[11] || data[12]) throw invalid();
    } else if (type === "IDAT") {
      if (dataEnded) throw invalid();
      compressed.push(data);
    } else {
      if (compressed.length) dataEnded = true;
      if (type === "IEND") {
        if (length || end !== bytes.length || !compressed.length) throw invalid();
        ended = true;
      } else if (type === "PLTE") {
        if (compressed.length || !length || length % 3 || length > 768 || channels < 3)
          throw invalid();
      } else if (type[0] === type[0].toUpperCase()) throw invalid();
    }
    offset = end;
  }
  if (!ended) throw invalid();
  const stride = width * channels + 1,
    expected = stride * height;
  const reader = new Blob(compressed.map((part) => new Uint8Array(part)))
    .stream()
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > expected) throw invalid();
      for (let i = (stride - (total % stride)) % stride; i < value.length; i += stride)
        if (value[i] > 4) throw invalid();
      total += value.length;
    }
    if (total !== expected) throw invalid();
  } catch {
    await reader.cancel().catch(() => {});
    throw invalid();
  } finally {
    reader.releaseLock();
  }
  return { width, height };
}
