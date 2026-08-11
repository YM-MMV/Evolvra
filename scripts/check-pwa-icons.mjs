import { readFile } from "node:fs/promises";
import sharp from "sharp";

const root = new URL("../", import.meta.url);
const icons = [
  { file: "public/icon-192.png", width: 192, height: 192 },
  { file: "public/icon-512.png", width: 512, height: 512 },
  { file: "public/icon-maskable-512.png", width: 512, height: 512 },
];

for (const icon of icons) {
  const bytes = await readFile(new URL(icon.file, root));
  const metadata = await sharp(bytes).metadata();
  if (
    metadata.format !== "png"
    || metadata.width !== icon.width
    || metadata.height !== icon.height
  ) {
    throw new Error(
      `${icon.file} must be a ${icon.width}x${icon.height} PNG.`,
    );
  }
}

const maskableBytes = await readFile(
  new URL("public/icon-maskable-512.png", root),
);

const {
  data: pixels,
  info: { width, height, channels },
} = await sharp(maskableBytes)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const background = [pixels[0], pixels[1], pixels[2]];
const centreX = (width - 1) / 2;
const centreY = (height - 1) / 2;
const safeRadius = Math.min(width, height) * 0.4;
let foregroundPixels = 0;
let farthestForegroundRadius = 0;

for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * channels;
    if (pixels[offset + 3] !== 255) {
      throw new Error("The maskable icon must provide an opaque background.");
    }
    const colourDistance = Math.hypot(
      pixels[offset] - background[0],
      pixels[offset + 1] - background[1],
      pixels[offset + 2] - background[2],
    );
    if (colourDistance <= 12) continue;
    foregroundPixels += 1;
    farthestForegroundRadius = Math.max(
      farthestForegroundRadius,
      Math.hypot(x - centreX, y - centreY),
    );
  }
}

if (!foregroundPixels) {
  throw new Error("The maskable icon has no visible foreground artwork.");
}
if (farthestForegroundRadius > safeRadius) {
  throw new Error(
    `Maskable foreground exceeds the Android safe-zone radius (${farthestForegroundRadius.toFixed(1)} > ${safeRadius.toFixed(1)} pixels).`,
  );
}

const manifestSource = await readFile(
  new URL("app/manifest.ts", root),
  "utf8",
);
if (
  !manifestSource.includes('src: "/icon-maskable-512.png"')
  || !manifestSource.includes('purpose: "maskable"')
) {
  throw new Error("The web manifest must reference the dedicated maskable icon.");
}

console.log(
  `PWA icon checks passed; maskable foreground radius ${farthestForegroundRadius.toFixed(1)}px within ${safeRadius.toFixed(1)}px safe zone.`,
);
