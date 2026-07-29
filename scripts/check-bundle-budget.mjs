import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(process.cwd(), ".next", "static", "chunks");
const maximumChunkBytes = 400 * 1024;
const maximumTotalBytes = 2 * 1024 * 1024;

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
  }));
  return nested.flat();
}

const files = await javascriptFiles(root);
const sizes = await Promise.all(files.map(async (file) => ({ file, bytes: (await stat(file)).size })));
const total = sizes.reduce((sum, item) => sum + item.bytes, 0);
const oversized = sizes.filter((item) => item.bytes > maximumChunkBytes);

if (oversized.length || total > maximumTotalBytes) {
  oversized.forEach((item) => console.error(`${relative(process.cwd(), item.file)} is ${item.bytes} bytes (limit ${maximumChunkBytes}).`));
  if (total > maximumTotalBytes) console.error(`Total JavaScript is ${total} bytes (limit ${maximumTotalBytes}).`);
  process.exitCode = 1;
} else {
  console.log(`Bundle budget passed: ${files.length} chunks, ${total} bytes total.`);
}
