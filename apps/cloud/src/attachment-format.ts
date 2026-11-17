import { Buffer } from "node:buffer";
import { imageLimits } from "../../../packages/contracts/src/images";
import type { AttachmentMime } from "../../../packages/contracts/src/attachments";

/** 校验原件签名和栅格尺寸。原件不在 Worker 内渲染，文档只允许下载。 */
export function validateAttachment(bytes: ArrayBuffer, mime: AttachmentMime) {
  const b = Buffer.from(bytes);
  const invalid = () => new Error("ATTACHMENT_FORMAT_INVALID");
  let width = 0,
    height = 0;
  if (mime === "image/png") {
    if (
      b.length < 57 ||
      b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      b.readUInt32BE(8) !== 13 ||
      b.toString("ascii", 12, 16) !== "IHDR"
    )
      throw invalid();
    width = b.readUInt32BE(16);
    height = b.readUInt32BE(20);
    let data = false,
      ended = false;
    for (let i = 33; i + 12 <= b.length;) {
      const size = b.readUInt32BE(i);
      const end = i + 12 + size;
      if (end > b.length) throw invalid();
      const chunk = b.toString("latin1", i + 4, i + 8);
      if (chunk === "IDAT" && size) data = true;
      if (chunk === "IEND") {
        ended = size === 0 && end === b.length;
        break;
      }
      i = end;
    }
    if (!data || !ended) throw invalid();
  } else if (mime === "image/jpeg") {
    let scan = false;
    if (b.length < 15 || b.readUInt16BE(0) !== 0xffd8 || b.readUInt16BE(b.length - 2) !== 0xffd9)
      throw invalid();
    for (let i = 2; i + 4 <= b.length;) {
      if (b[i++] !== 0xff) throw invalid();
      while (b[i] === 0xff) i++;
      const marker = b[i++];
      if (marker === 0xda && width && height) {
        scan = i + 2 <= b.length && b.readUInt16BE(i) >= 6 && i + b.readUInt16BE(i) < b.length - 2;
        break;
      }
      if (i + 2 > b.length || !marker || marker === 0xda || marker === 0xd9) throw invalid();
      const size = b.readUInt16BE(i);
      if (size < 2 || i + size > b.length) throw invalid();
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        if (size < 8) throw invalid();
        height = b.readUInt16BE(i + 3);
        width = b.readUInt16BE(i + 5);
      }
      i += size;
    }
    if (!scan) throw invalid();
  } else if (mime === "image/webp") {
    if (
      b.length < 25 ||
      b.toString("latin1", 0, 4) !== "RIFF" ||
      b.readUInt32LE(4) + 8 !== b.length ||
      b.toString("latin1", 8, 12) !== "WEBP"
    )
      throw invalid();
    let image = false;
    for (let i = 12; i + 8 <= b.length;) {
      const type = b.toString("latin1", i, i + 4);
      const size = b.readUInt32LE(i + 4);
      const p = i + 8;
      i = p + size + (size % 2);
      if (i > b.length) throw invalid();
      if (type === "VP8X" && size === 10) {
        width = 1 + b.readUIntLE(p + 4, 3);
        height = 1 + b.readUIntLE(p + 7, 3);
      }
      if (type === "VP8 " && size >= 10 && b.subarray(p + 3, p + 6).toString("hex") === "9d012a") {
        width ||= b.readUInt16LE(p + 6) & 0x3fff;
        height ||= b.readUInt16LE(p + 8) & 0x3fff;
        image = true;
      }
      if (type === "VP8L" && size >= 5 && b[p] === 0x2f) {
        const bits = b.readUInt32LE(p + 1);
        width ||= 1 + (bits & 0x3fff);
        height ||= 1 + ((bits >>> 14) & 0x3fff);
        image = true;
      }
      if (type === "ANMF" && size > 16) image = true;
    }
    if (!image) throw invalid();
  } else if (mime === "application/pdf") {
    if (
      !/^%PDF-[12]\.\d(?:\r|\n)/.test(b.toString("latin1", 0, 12)) ||
      !b.subarray(-1024).toString("latin1").trimEnd().endsWith("%%EOF")
    )
      throw invalid();
    return;
  } else {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw invalid();
    }
    if (
      !text.trim() ||
      Array.from(text).some((char) => {
        const code = char.charCodeAt(0);
        return (code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code < 160);
      })
    )
      throw invalid();
    return;
  }
  if (!width || !height) throw invalid();
  if (width * height > imageLimits.pixels) throw Error("ATTACHMENT_PIXELS_EXCEEDED");
}
