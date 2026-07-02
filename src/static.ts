import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Vite builds the SPA into dist/public (a sibling of the compiled dist/*.js).
const DEFAULT_PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function isAssetRequest(pathname: string): boolean {
  return pathname.startsWith("/assets/") || path.extname(pathname) !== "";
}

export interface StaticServer {
  /** True when a built SPA (index.html) is present. */
  hasAssets(): boolean;
  /** Serve a static file or the SPA shell. Returns true if it produced a response. */
  serve(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean;
}

export function makeStaticServer(publicDir: string = DEFAULT_PUBLIC_DIR): StaticServer {
  const indexPath = path.join(publicDir, "index.html");

  function hasAssets(): boolean {
    try { return fs.statSync(indexPath).isFile(); } catch { return false; }
  }

  function fileExists(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }

  function cacheControlFor(filePath: string, ext: string): string {
    // Hashed, content-addressed assets can be cached forever.
    if (filePath.includes(path.sep + "assets" + path.sep)) return "public, max-age=31536000, immutable";
    // The shell must always revalidate — deploys hot-swap the hashed bundles it references.
    if (ext === ".html") return "no-cache";
    return "public, max-age=3600";
  }

  function sendFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] ?? "application/octet-stream";
    const stat = fs.statSync(filePath);
    const etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;

    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag, "Cache-Control": cacheControlFor(filePath, ext) });
      res.end();
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": type,
      "Content-Length": String(stat.size),
      "Cache-Control": cacheControlFor(filePath, ext),
      ETag: etag,
    };
    res.writeHead(200, headers);
    if ((req.method ?? "GET") === "HEAD") { res.end(); return; }
    // Dashboard assets are small; a synchronous read keeps serving simple and predictable.
    res.end(fs.readFileSync(filePath));
  }

  function serve(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
    if (!hasAssets()) return false;
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return false;

    let rel: string;
    try { rel = decodeURIComponent(pathname); } catch { rel = pathname; }
    const normalized = path.normalize(path.join(publicDir, rel));

    // Path traversal guard.
    if (normalized !== publicDir && !normalized.startsWith(publicDir + path.sep)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return true;
    }

    // Concrete file wins.
    if (normalized !== publicDir && fileExists(normalized)) {
      sendFile(req, res, normalized);
      return true;
    }

    // A missing asset must 404 — never mask a broken bundle reference with the shell.
    if (isAssetRequest(pathname)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return true;
    }

    // SPA fallback: serve the shell so client-side routing handles deep links.
    sendFile(req, res, indexPath);
    return true;
  }

  return { hasAssets, serve };
}

export const staticServer: StaticServer = makeStaticServer();
