import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { makeStaticServer } from "./static.js";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "yeti-static-"));
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>frostyard</title>");
  fs.writeFileSync(path.join(dir, "assets", "app.abc123.js"), "console.log('hi')");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Minimal fake ServerResponse capturing status/headers/body. */
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: "",
    writeHead(status: number, headers?: Record<string, unknown>) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
      return this;
    },
    end(chunk?: string) { if (chunk) this.body += chunk; return this; },
    // createReadStream(...).pipe(res) uses these:
    on() { return this; },
    once() { return this; },
    emit() { return true; },
    write(chunk: string | Buffer) { this.body += chunk.toString(); return true; },
  };
  return res as unknown as http.ServerResponse & { statusCode: number; headers: Record<string, unknown>; body: string };
}

function get(server: ReturnType<typeof makeStaticServer>, pathname: string, headers: Record<string, string> = {}) {
  const req = { method: "GET", headers } as unknown as http.IncomingMessage;
  const res = fakeRes();
  const handled = server.serve(req, res, pathname);
  return { handled, res };
}

describe("static server", () => {
  it("hasAssets reflects presence of index.html", () => {
    expect(makeStaticServer(dir).hasAssets()).toBe(true);
    expect(makeStaticServer(path.join(dir, "nope")).hasAssets()).toBe(false);
  });

  it("does not respond when no assets are built", () => {
    const { handled } = get(makeStaticServer(path.join(dir, "nope")), "/");
    expect(handled).toBe(false);
  });

  it("serves index.html for the root with no-cache", () => {
    const { handled, res } = get(makeStaticServer(dir), "/");
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-cache");
    expect(res.headers["Content-Type"]).toContain("text/html");
  });

  it("serves the SPA shell for unknown deep-link routes", () => {
    const { res } = get(makeStaticServer(dir), "/queue");
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/html");
  });

  it("serves hashed assets as immutable", () => {
    const { res } = get(makeStaticServer(dir), "/assets/app.abc123.js");
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["Content-Type"]).toContain("text/javascript");
  });

  it("returns 404 (not the shell) for a missing asset", () => {
    const { res } = get(makeStaticServer(dir), "/assets/missing.js");
    expect(res.statusCode).toBe(404);
  });

  it("blocks path traversal", () => {
    const { res } = get(makeStaticServer(dir), "/../secret");
    expect(res.statusCode).toBe(403);
  });

  it("supports conditional requests with ETag → 304", () => {
    const first = get(makeStaticServer(dir), "/assets/app.abc123.js");
    const etag = String(first.res.headers["ETag"]);
    const { res } = get(makeStaticServer(dir), "/assets/app.abc123.js", { "if-none-match": etag });
    expect(res.statusCode).toBe(304);
  });
});
