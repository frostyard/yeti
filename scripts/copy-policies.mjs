// Copies policy templates (src/policies/*.md) into dist/ after tsc, since tsc
// only emits .js. In dev (tsx src/main.ts) policy.ts resolves src/policies
// directly; in prod (node dist/main.js) it resolves dist/policies — hence this copy.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src", "policies");
const dest = path.join(root, "dist", "policies");

if (!fs.existsSync(src)) {
  console.error(`copy-policies: source dir not found: ${src}`);
  process.exit(1);
}

fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });

const count = fs.readdirSync(src).filter((f) => f.endsWith(".md")).length;
console.log(`copy-policies: copied ${count} policy file(s) to dist/policies`);
