'use strict';
const zlib = require('zlib');

/**
 * Everything is JSON, except the connector installer, which has to arrive as a
 * file the customer can double-click. A handler signals that by returning
 * { _raw: { body, contentType, headers } } rather than a plain object.
 */
function send(res, status, obj) {
  if (obj && obj._raw) {
    const { body, contentType, headers } = obj._raw;
    res.writeHead(status, {
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Length': Buffer.byteLength(body),
      ...(headers || {}),
    });
    res.end(body);
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/** Errors always carry a stable machine code. Never branch on message text. */
const fail = (res, status, code, message) =>
  send(res, status, { error: { code, message } });

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = (code, msg) => new HttpError(400, code, msg);
const notFound = (msg = 'Not found.') => new HttpError(404, 'NOT_FOUND', msg);

const MAX_BODY = 32 * 1024 * 1024;

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'TOO_LARGE', 'That request is too big.');
    chunks.push(c);
  }
  let buf = Buffer.concat(chunks);
  if (req.headers['content-encoding'] === 'gzip') {
    try { buf = zlib.gunzipSync(buf); }
    catch { throw bad('BAD_GZIP', 'The request body could not be decompressed.'); }
  }
  return buf;
}

function json(buf) {
  if (!buf || buf.length === 0) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw bad('BAD_JSON', 'The request body is not valid JSON.'); }
}

const bearer = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};

/** Accepts what people actually type and returns E.164, or null. */
function normalizePhone(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 10) return '+91' + d;
  if (d.length === 12 && d.startsWith('91')) return '+' + d;
  if (d.length === 11 && d.startsWith('0')) return '+91' + d.slice(1);
  return null;
}

module.exports = { send, fail, HttpError, bad, notFound, readBody, json, bearer, normalizePhone };
