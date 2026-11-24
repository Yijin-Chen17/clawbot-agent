import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createCompressionMiddleware } from './compression.js';

function dispatchExpress(
  app: express.Express,
  reqPath: string,
  headers: Record<string, string> = {},
  method = 'GET'
): Promise<{ status: number; headers: Record<string, string | string[]>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = new PassThrough() as any;
    socket.remoteAddress = '127.0.0.1';
    socket.writable = true;
    socket.cork = () => {};
    socket.uncork = () => {};
    socket.destroy = () => {};

    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = reqPath;
    for (const [k, v] of Object.entries(headers)) {
      req.headers[k.toLowerCase()] = v;
    }

    const res = new http.ServerResponse(req);
    const rawChunks: Buffer[] = [];
    socket.write = (chunk: any, _enc?: any, cb?: any) => {
      rawChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (typeof _enc === 'function') _enc();
      else if (typeof cb === 'function') cb();
      return true;
    };
    res.assignSocket(socket);

    res.on('finish', () => {
      const raw = Buffer.concat(rawChunks);
      const sep = raw.indexOf('\r\n\r\n');
      const headerStr = sep >= 0 ? raw.subarray(0, sep).toString('utf8') : '';
      const body = sep >= 0 ? raw.subarray(sep + 4) : raw;
      const parsedHeaders: Record<string, string | string[]> = {};
      for (const line of headerStr.split('\r\n').slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          const k = line.slice(0, idx).trim().toLowerCase();
          const v = line.slice(idx + 1).trim();
          if (parsedHeaders[k] !== undefined) {
            parsedHeaders[k] = Array.isArray(parsedHeaders[k])
              ? [...(parsedHeaders[k] as string[]), v]
              : [parsedHeaders[k] as string, v];
          } else {
            parsedHeaders[k] = v;
          }
        }
      }
      resolve({ status: res.statusCode, headers: parsedHeaders, body });
    });
    res.on('error', reject);

    (app as any).handle(req, res, (err: any) => {
      if (err) reject(err);
      else if (!res.writableEnded) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
}

test('compression middleware handles br, gzip, small payloads, 304, HEAD, SSE, and static cache headers', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-comp-'));
  const assetsDir = path.join(tmpDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const jsPayload = `console.log(${JSON.stringify('x'.repeat(4000))});`;
  fs.writeFileSync(path.join(assetsDir, 'app-abc123.js'), jsPayload, 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'index.html'), `<!doctype html><html><body>${'hi '.repeat(600)}</body></html>`, 'utf8');

  const app = express();
  app.use(createCompressionMiddleware());

  app.get('/api/small', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/large', (_req, res) => {
    res.json({ items: Array.from({ length: 120 }, (_, i) => ({ id: i, title: `Task ${i}` })) });
  });

  app.get('/api/sse', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.send(`data: ${'ping '.repeat(300)}\n\n`);
  });

  app.use(
    express.static(tmpDir, {
      setHeaders: (res, filePath) => {
        const normalized = filePath.replace(/\\/g, '/');
        if (normalized.endsWith('/index.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (normalized.includes('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Small JSON skips compression
  const smallRes = await dispatchExpress(app, '/api/small', { 'Accept-Encoding': 'br, gzip' });
  assert.equal(smallRes.status, 200);
  assert.equal(smallRes.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(smallRes.body.toString('utf8')), { ok: true });

  // 2. Large JSON uses Brotli when accepted
  const largeBr = await dispatchExpress(app, '/api/large', { 'Accept-Encoding': 'gzip, br' });
  assert.equal(largeBr.status, 200);
  assert.equal(largeBr.headers['content-encoding'], 'br');
  assert.match(String(largeBr.headers['vary']), /Accept-Encoding/i);
  const decompressedBr = zlib.brotliDecompressSync(largeBr.body).toString('utf8');
  assert.equal(JSON.parse(decompressedBr).items.length, 120);

  // 3. Large JSON falls back to Gzip
  const largeGz = await dispatchExpress(app, '/api/large', { 'Accept-Encoding': 'gzip' });
  assert.equal(largeGz.status, 200);
  assert.equal(largeGz.headers['content-encoding'], 'gzip');
  const decompressedGz = zlib.gunzipSync(largeGz.body).toString('utf8');
  assert.equal(JSON.parse(decompressedGz).items.length, 120);

  // 4. Static hashed asset gets immutable cache + br + weakened ETag
  const assetRes = await dispatchExpress(app, '/assets/app-abc123.js', { 'Accept-Encoding': 'br, gzip' });
  assert.equal(assetRes.status, 200);
  assert.equal(assetRes.headers['content-encoding'], 'br');
  assert.equal(assetRes.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(zlib.brotliDecompressSync(assetRes.body).toString('utf8'), jsPayload);

  // 5. Conditional 304 Not Modified returns clean 304 without Content-Encoding
  const etag = String(assetRes.headers['etag'] || '');
  assert.ok(etag.length > 0);
  const notMod = await dispatchExpress(app, '/assets/app-abc123.js', {
    'Accept-Encoding': 'br, gzip',
    'If-None-Match': etag,
  });
  assert.equal(notMod.status, 304);
  assert.equal(notMod.headers['content-encoding'], undefined);
  assert.equal(notMod.body.length, 0);

  // 6. index.html gets no-store cache header
  const htmlRes = await dispatchExpress(app, '/index.html', { 'Accept-Encoding': 'gzip' });
  assert.equal(htmlRes.status, 200);
  assert.equal(htmlRes.headers['cache-control'], 'no-cache, no-store, must-revalidate');
  assert.equal(htmlRes.headers['content-encoding'], 'gzip');

  // 7. HEAD request does not emit body or content-encoding
  const headRes = await dispatchExpress(app, '/assets/app-abc123.js', { 'Accept-Encoding': 'gzip' }, 'HEAD');
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers['content-encoding'], undefined);
  assert.equal(headRes.body.length, 0);

  // 8. SSE skips compression
  const sseRes = await dispatchExpress(app, '/api/sse', { 'Accept-Encoding': 'br, gzip' });
  assert.equal(sseRes.status, 200);
  assert.equal(sseRes.headers['content-encoding'], undefined);
});
