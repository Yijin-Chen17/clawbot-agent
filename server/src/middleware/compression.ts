import type { NextFunction, Request, Response } from 'express';
import zlib from 'node:zlib';

const THRESHOLD_BYTES = 1024;

const COMPRESSIBLE_EXACT_TYPES = new Set([
  'application/javascript',
  'application/x-javascript',
  'application/json',
  'application/ld+json',
  'application/manifest+json',
  'application/xml',
  'application/xhtml+xml',
  'application/wasm',
  'image/svg+xml',
]);

export function isCompressibleContentType(rawContentType: unknown): boolean {
  if (!rawContentType) return false;
  const normalized = String(rawContentType).split(';')[0].trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'text/event-stream') return false;
  if (normalized.startsWith('text/')) return true;
  if (normalized.endsWith('+json') || normalized.endsWith('+xml')) return true;
  return COMPRESSIBLE_EXACT_TYPES.has(normalized);
}

export function selectEncoding(acceptEncodingHeader: unknown): 'br' | 'gzip' | null {
  if (!acceptEncodingHeader) return null;
  const header = String(acceptEncodingHeader).toLowerCase();
  // Respect explicit q=0 opt-outs while preferring Brotli then Gzip
  const parts = header.split(',').map((part) => {
    const [encRaw, ...params] = part.trim().split(';');
    const enc = encRaw.trim();
    let q = 1;
    for (const p of params) {
      const trimmed = p.trim();
      if (trimmed.startsWith('q=')) {
        const parsed = Number(trimmed.slice(2));
        if (!Number.isNaN(parsed)) q = parsed;
      }
    }
    return { enc, q };
  });

  const findWeight = (name: string): number => {
    const exact = parts.find((p) => p.enc === name);
    if (exact) return exact.q;
    const wildcard = parts.find((p) => p.enc === '*');
    return wildcard ? wildcard.q : 0;
  };

  if (findWeight('br') > 0) return 'br';
  if (findWeight('gzip') > 0) return 'gzip';
  return null;
}

function appendVaryAcceptEncoding(res: Response): void {
  const existing = res.getHeader('Vary');
  if (!existing) {
    res.setHeader('Vary', 'Accept-Encoding');
    return;
  }
  const existingStr = Array.isArray(existing) ? existing.join(', ') : String(existing);
  const tokens = existingStr.split(',').map((s) => s.trim().toLowerCase());
  if (!tokens.includes('accept-encoding') && !tokens.includes('*')) {
    res.setHeader('Vary', `${existingStr}, Accept-Encoding`);
  }
}

function weakenStrongEtag(res: Response): void {
  const etag = res.getHeader('ETag');
  if (typeof etag === 'string' && etag.startsWith('"')) {
    res.setHeader('ETag', `W/${etag}`);
  }
}

function toBuffer(chunk: any, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), encoding || 'utf8');
}

export function createCompressionMiddleware() {
  return function compressionMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (req.headers['x-no-compression']) {
      next();
      return;
    }

    const origWrite = res.write.bind(res) as (...args: any[]) => boolean;
    const origEnd = res.end.bind(res) as (...args: any[]) => Response;
    const origWriteHead = res.writeHead.bind(res) as (...args: any[]) => Response;

    let decided = false;
    let stream: zlib.BrotliCompress | zlib.Gzip | null = null;
    let ended = false;
    let wroteChunks = false;

    const cleanupStream = () => {
      if (stream) {
        try {
          stream.destroy();
        } catch {}
        stream = null;
      }
    };

    res.on('close', cleanupStream);

    const evaluate = (knownSingleChunkLength?: number): boolean => {
      if (decided) return stream !== null;
      decided = true;

      if (req.method === 'HEAD') return false;
      const status = res.statusCode;
      if (status === 204 || status === 304 || (status >= 100 && status < 200)) return false;
      if (res.getHeader('Content-Encoding')) return false;
      if (res.getHeader('Content-Range')) return false;

      const contentType = res.getHeader('Content-Type');
      if (!isCompressibleContentType(contentType)) return false;

      appendVaryAcceptEncoding(res);

      const encoding = selectEncoding(req.headers['accept-encoding']);
      if (!encoding) return false;

      const contentLengthHeader = res.getHeader('Content-Length');
      const headerLength =
        contentLengthHeader !== undefined && contentLengthHeader !== null
          ? Number(contentLengthHeader)
          : undefined;
      const effectiveLength =
        headerLength !== undefined && !Number.isNaN(headerLength)
          ? headerLength
          : knownSingleChunkLength;

      if (effectiveLength !== undefined && effectiveLength < THRESHOLD_BYTES) {
        return false;
      }

      res.removeHeader('Content-Length');
      weakenStrongEtag(res);
      res.setHeader('Content-Encoding', encoding);

      stream =
        encoding === 'br'
          ? zlib.createBrotliCompress({
              params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
              },
            })
          : zlib.createGzip({ level: zlib.constants.Z_DEFAULT_COMPRESSION });

      stream.on('data', (compressedChunk: Buffer) => {
        origWrite(compressedChunk);
      });

      stream.on('end', () => {
        origEnd();
      });

      stream.on('error', () => {
        cleanupStream();
      });

      return true;
    };

    res.writeHead = function wrappedWriteHead(statusCode: number, ...rest: any[]): Response {
      res.statusCode = statusCode;
      let headersArg: Record<string, any> | undefined;
      if (rest.length >= 2 && typeof rest[0] === 'string') {
        headersArg = rest[1];
      } else if (rest.length >= 1 && rest[0] && typeof rest[0] === 'object') {
        headersArg = rest[0];
      }

      if (headersArg && !Array.isArray(headersArg)) {
        for (const [k, v] of Object.entries(headersArg)) {
          if (v !== undefined) res.setHeader(k, v);
        }
      }

      evaluate();

      if (rest.length >= 2 && typeof rest[0] === 'string') {
        return origWriteHead(statusCode, rest[0]);
      }
      return origWriteHead(statusCode);
    } as typeof res.writeHead;

    res.write = function wrappedWrite(chunk: any, encodingOrCb?: any, cb?: any): boolean {
      if (ended) return false;
      wroteChunks = true;
      const enc = typeof encodingOrCb === 'string' ? (encodingOrCb as BufferEncoding) : undefined;
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;

      if (!evaluate()) {
        return origWrite(chunk, encodingOrCb, cb);
      }
      return stream!.write(toBuffer(chunk, enc), callback);
    } as typeof res.write;

    res.end = function wrappedEnd(chunk?: any, encodingOrCb?: any, cb?: any): Response {
      if (ended) return res;
      ended = true;

      const hasChunk = chunk !== undefined && chunk !== null && typeof chunk !== 'function';
      const enc = typeof encodingOrCb === 'string' ? (encodingOrCb as BufferEncoding) : undefined;
      const callback =
        typeof chunk === 'function'
          ? chunk
          : typeof encodingOrCb === 'function'
          ? encodingOrCb
          : cb;

      const buf = hasChunk ? toBuffer(chunk, enc) : undefined;
      const singleChunkLength = !wroteChunks ? (buf ? buf.length : 0) : undefined;

      if (!evaluate(singleChunkLength)) {
        if (typeof chunk === 'function') return origEnd(chunk);
        if (typeof encodingOrCb === 'function') return origEnd(chunk, encodingOrCb);
        if (enc !== undefined) return origEnd(chunk, enc, cb);
        if (chunk !== undefined) return origEnd(chunk);
        return origEnd();
      }

      if (callback) {
        stream!.once('end', callback);
      }
      if (buf && buf.length > 0) {
        stream!.end(buf);
      } else {
        stream!.end();
      }
      return res;
    } as typeof res.end;

    next();
  };
}
