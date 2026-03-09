import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");

await rm(distDir, { force: true, recursive: true });
await mkdir(distDir, { recursive: true });
await mkdir(path.join(distDir, "popup"), { recursive: true });
await mkdir(path.join(distDir, "content"), { recursive: true });
await mkdir(path.join(distDir, "icons"), { recursive: true });

await Promise.all([
  esbuild.build({
    bundle: true,
    entryPoints: [path.join(root, "src/popup/popup.js")],
    format: "esm",
    outfile: path.join(distDir, "popup/popup.js"),
    sourcemap: false,
    target: "chrome120"
  }),
  esbuild.build({
    bundle: true,
    entryPoints: [path.join(root, "src/content/content.js")],
    format: "iife",
    outfile: path.join(distDir, "content/content.js"),
    sourcemap: false,
    target: "chrome120"
  }),
  esbuild.build({
    bundle: true,
    entryPoints: [path.join(root, "src/content/page-bridge.js")],
    format: "iife",
    outfile: path.join(distDir, "content/page-bridge.js"),
    sourcemap: false,
    target: "chrome120"
  }),
  cp(path.join(root, "src/manifest.json"), path.join(distDir, "manifest.json")),
  cp(path.join(root, "src/assets/icons"), path.join(distDir, "icons"), { recursive: true }),
  cp(path.join(root, "src/popup/index.html"), path.join(distDir, "popup/index.html")),
  cp(path.join(root, "src/popup/styles.css"), path.join(distDir, "popup/styles.css"))
]);
