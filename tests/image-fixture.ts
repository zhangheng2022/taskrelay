import sharp from "sharp";

// 所有上传入口夹具都使用可实际解码的 PNG，不能只用八字节文件头冒充图片。
export const fixturePng = await sharp({
  create: { width: 8, height: 6, channels: 4, background: "#fafafa" },
})
  .png()
  .toBuffer();
