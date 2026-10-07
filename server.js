import express from 'express';
import https from 'https';
import dns from 'dns';
import net from 'net';
import zlib from 'zlib';
import fs from 'fs';
import { fileURLToPath } from 'url';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
/*
 * Run with DEBUG=1 for verbose per-request logs and a /__debug page.
 *
 * Bisecting a site that "loads forever": turn the new features off one at a time.
 *   SAFE_LOOKUP=0        skip the private-IP guard on DNS results
 *   STREAM=0             buffer every response (what the old proxy did)
 *   REWRITE=0            don't rewrite URLs in text bodies
 *   REWRITE_JSON=1       (opt-in) also rewrite URLs inside application/json
 *   BRAND=0              don't swap the brand name
 *   CLEAN=0              don't inject the client-side cleaner (favicon links, logos)
 *   BLOCK_FAVICON=0      don't block favicon/icon asset requests at the proxy
 *   STRIP_CONDITIONAL=0  forward Range / If-None-Match etc. untouched
 *   COOKIE_COMPAT=1      (opt-in) strip Secure / SameSite=None from cookies for plain-HTTP use
 * Example:  DEBUG=1 BRAND=0 node proxy.js
 */
const env = (k, d) => (process.env[k] === undefined ? d : process.env[k]);

const DEBUG = env('DEBUG', '0') === '1';
const FLAGS = {
  safeLookup: env('SAFE_LOOKUP', '1') !== '0',
  stream: env('STREAM', '1') !== '0',
  rewrite: env('REWRITE', '1') !== '0',
  rewriteJson: env('REWRITE_JSON', '0') === '1', // OFF by default — JSON rewriting corrupts DataTables etc.
  brand: env('BRAND', '1') !== '0',
  clean: env('CLEAN', '1') !== '0',
  blockFavicon: env('BLOCK_FAVICON', '1') !== '0',
  stripConditional: env('STRIP_CONDITIONAL', '1') !== '0',
  cookieCompat: env('COOKIE_COMPAT', '0') === '1',
};

const PORT = Number(env('PORT', 3000));
const TARGET_HOST = env('TARGET_HOST', 'zalcrm.com'); // main upstream site
const UPSTREAM_PORT = Number(env('UPSTREAM_PORT', 443)); // only applies to TARGET_HOST
const EXT_PREFIX = '/__ext/';                          // other hosts are served under /__ext/<host>/...
const BRAND_FROM = 'Onezeroart';
const BRAND_TO = 'YourBrand';

const TIMEOUT_MS = Number(env('UPSTREAM_TIMEOUT_MS', 30000)); // upstream idle timeout -> 504
const STUCK_MS = Number(env('STUCK_MS', 15000));              // log requests with no activity this long
const MAX_REWRITE_BYTES = Number(env('MAX_REWRITE_BYTES', 5 * 1024 * 1024)); // bigger text bodies pass through

const HOSTS_FILE = fileURLToPath(new URL('./learned-hosts.json', import.meta.url));

// Only HTML/CSS/JS get rewritten. JSON is deliberately excluded by default.
const REWRITABLE_TYPES = /^(text\/html|text\/css|application\/javascript|text\/javascript)/i;
const JSON_TYPES = /^(application|text)\/json/i;

// Requests for these keep Range / conditional headers (seeking, caching)
const BINARY_PATH = /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|ogg|wav|m4a|pdf|zip|gz|wasm)(\?|$)/i;

// Paths that look like a favicon / icon asset served by the app.
const FAVICON_PATH = /(?:^|\/)(?:favicon(?:[-_]\d+x\d+)?\.(?:ico|png|jpe?g|gif|svg|webp)|favicon\/[^/?#]+\.(?:ico|png|jpe?g|gif|svg|webp)|apple-touch-icon(?:-\d+x\d+)?\.png|icon-\d+x\d+\.png)(?:[?#]|$)/i;

/* ------------------------------------------------------------------ */
/* Logging + in-flight tracking                                        */
/* ------------------------------------------------------------------ */

const inflight = new Map();
let nextId = 1;

const ts = () => new Date().toISOString().slice(11, 23);
const tag = (ctx) => `${ts()} #${ctx.id} +${Date.now() - ctx.start}ms`;
const dlog = (ctx, msg) => { if (DEBUG) console.log(`${tag(ctx)} ${msg}`); };
const wlog = (ctx, msg) => console.warn(`${tag(ctx)} WARN ${msg}`);
const elog = (ctx, msg) => console.error(`${tag(ctx)} ERROR ${msg}`);

function setStage(ctx, stage) {
  ctx.stage = stage;
  ctx.lastActivity = Date.now();
  dlog(ctx, `stage: ${stage}`);
}

setInterval(() => {
  const now = Date.now();
  for (const c of inflight.values()) {
    const idle = now - c.lastActivity;
    if (idle > STUCK_MS && now - (c.lastWarn || 0) > STUCK_MS) {
      c.lastWarn = now;
      wlog(c, `STUCK ${idle}ms idle in stage "${c.stage}": ${c.method} ${c.host}${c.path} (${c.bytes} bytes so far)`);
    }
  }
}, Math.min(5000, STUCK_MS)).unref();

/* ------------------------------------------------------------------ */
/* SSRF protection                                                     */
/* ------------------------------------------------------------------ */

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7)); // IPv4-mapped
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);              // fc00::/7, fe80::/10
  }
  return false;
}

function isPublicHostname(h) {
  if (!h || !/^[a-z0-9._-]+$/.test(h)) return false;
  if (net.isIP(h)) return !isPrivateIp(h);
  if (!h.includes('.')) return false;
  if (/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(h)) return false;
  return true;
}

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (list.some((a) => isPrivateIp(a.address))) {
      console.warn(`${ts()} WARN blocked ${hostname}: resolves to private address ${list.map((a) => a.address).join(', ')}`);
      return cb(new Error(`Blocked private address for ${hostname}`));
    }
    cb(null, address, family);
  });
}

/* ------------------------------------------------------------------ */
/* Learned hosts (persisted across restarts)                           */
/* ------------------------------------------------------------------ */

const learnedHosts = new Set();

try {
  for (const h of JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'))) {
    if (isPublicHostname(h)) learnedHosts.add(h);
  }
} catch { /* first run */ }

function learnHost(h) {
  if (learnedHosts.has(h)) return true;
  if (!isPublicHostname(h)) return false;
  learnedHosts.add(h);
  fs.writeFile(HOSTS_FILE, JSON.stringify([...learnedHosts]), (err) => {
    if (err) console.error('Could not persist learned hosts:', err);
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* URL mapping                                                         */
/* ------------------------------------------------------------------ */

function resolveTarget(url) {
  if (url.startsWith(EXT_PREFIX)) {
    const rest = url.slice(EXT_PREFIX.length);
    const slash = rest.search(/[/?#]/);
    const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
    let path = slash === -1 ? '/' : rest.slice(slash);
    if (path[0] !== '/') path = '/' + path; // "?q=1" -> "/?q=1"
    return learnedHosts.has(host) ? { host, path } : null;
  }
  return { host: TARGET_HOST, path: url };
}

function toProxyPath(location, baseHost, basePath) {
  let u;
  try {
    u = new URL(location, `https://${baseHost}${basePath}`);
  } catch {
    return location;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return location;
  const tail = u.pathname + u.search + u.hash;
  if (u.hostname === TARGET_HOST) return tail;
  if (!learnHost(u.hostname)) return null;
  return `${EXT_PREFIX}${u.hostname}${tail}`;
}

/* ------------------------------------------------------------------ */
/* Body rewriting                                                      */
/* ------------------------------------------------------------------ */

// Only matches URLs with an explicit http(s):// prefix. A bare "//host" is
// intentionally NOT matched, because that pattern appears all over the HTML
// fragments embedded in JSON API responses (e.g. "<\/div>").
const URL_RE = /https?:(?:\\?\/){2}([a-z0-9.-]+\.[a-z]{2,})(?=[/\\"'\s)?#]|$)/gi;

function rewriteBody(text, stats) {
  return text.replace(URL_RE, (match, host, offset, str) => {
    host = host.toLowerCase();
    const esc = match.includes('\\');
    const slash = esc ? '\\/' : '/';
    if (host === TARGET_HOST) {
      if (stats) stats.urls++;
      const next = str[offset + match.length];
      return next === '/' || next === '\\' ? '' : slash;
    }
    if (!learnedHosts.has(host)) return match; // only rewrite hosts we've already seen
    if (stats) stats.urls++;
    return `${esc ? '\\/__ext\\/' : EXT_PREFIX}${host}`;
  });
}

const BRAND_RE = /(<!--[\s\S]*?-->)|(<(script|style)\b[\s\S]*?<\/\3\s*>)|(<[^>]+>)|([^<]+)/gi;
const WORD_RE = new RegExp(`\\b${BRAND_FROM}\\b(?!\\.[a-z])`, 'gi');

function brandHtml(html, stats) {
  return html.replace(BRAND_RE, (m, _comment, _block, _name, _tag, text) =>
    text
      ? text.replace(WORD_RE, () => {
          if (stats) stats.brand++;
          return BRAND_TO;
        })
      : m
  );
}

function cleanScript() {
  return `<script>(function(){
  var SEL_ICON = 'link[rel~="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"],link[rel="mask-icon"],link[href*="/favicon/" i],link[href$="favicon.ico" i]';
  var SEL_LOGO = 'img[alt*="logo" i],.logo,#logo,svg.logo,[class*="logo" i],[id*="logo" i]';
  function clean(){
    try{
      document.querySelectorAll(SEL_ICON).forEach(function(el){el.remove();});
      document.querySelectorAll(SEL_LOGO).forEach(function(el){el.remove();});
    }catch(e){}
  }
  function start(){
    clean();
    try{
      var mo = new MutationObserver(clean);
      mo.observe(document.documentElement,{childList:true,subtree:true});
    }catch(e){}
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start);
  else start();
})();</script>`;
}

function injectCleanScript(html, stats) {
  const script = cleanScript();
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (m) => m + script);
  }
  if (stats) stats.cleaned = (stats.cleaned || 0) + 1;
  return script + html;
}

function decodeBody(buf, encoding) {
  switch ((encoding || '').toLowerCase()) {
    case '':
    case 'identity': return buf;
    case 'gzip':
    case 'x-gzip': return zlib.gunzipSync(buf);
    case 'deflate': return zlib.inflateSync(buf);
    case 'br': return zlib.brotliDecompressSync(buf);
    default: throw new Error(`unsupported content-encoding "${encoding}"`);
  }
}

function isUtf8Charset(contentType) {
  const m = /charset\s*=\s*"?([^;"\s]+)/i.exec(contentType);
  return !m || /^utf-?8$/i.test(m[1]);
}

// Sniff the first non-whitespace byte: JSON bodies start with { or [.
// This is used to override a lying content-type (some Laravel apps send
// text/html for JSON API responses, which would otherwise cause us to
// inject the cleaner script into a JSON payload).
function looksLikeJson(text) {
  for (let i = 0; i < text.length && i < 64; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) continue; // whitespace
    return text[i] === '{' || text[i] === '[';
  }
  return false;
}

// Sniff the start of the body: if it looks like a JSON API response, we
// must not inject <script> into it, even if the content-type says HTML.
function looksLikeHtml(text) {
  for (let i = 0; i < text.length && i < 256; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) continue;
    return text[i] === '<';
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Headers                                                             */
/* ------------------------------------------------------------------ */

function fixCookie(cookie) {
  let c = cookie.replace(/;\s*Domain=[^;]*/i, ''); // keep cookies on the proxy's domain
  if (FLAGS.cookieCompat && !/^\s*__(Secure|Host)-/i.test(c)) {
    c = c.replace(/;\s*Secure(?=;|$)/i, '').replace(/;\s*SameSite=None/i, '; SameSite=Lax');
  }
  return c;
}

function buildResponseHeaders(proxyRes, location, bodyRewritten) {
  const out = { ...proxyRes.headers };

  if (location) out.location = location;
  if (out['set-cookie']) out['set-cookie'] = out['set-cookie'].map(fixCookie);

  if (bodyRewritten) {
    delete out['content-length'];
    delete out['transfer-encoding'];
    delete out['content-encoding'];
    delete out.etag;
    delete out['last-modified'];
  }

  delete out.connection;
  delete out['keep-alive'];
  delete out['content-security-policy'];
  delete out['content-security-policy-report-only'];
  delete out['strict-transport-security'];

  out['access-control-allow-origin'] = '*';
  out['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  out['access-control-allow-headers'] = 'Content-Type, Authorization';
  return out;
}

/* ------------------------------------------------------------------ */
/* Proxy                                                               */
/* ------------------------------------------------------------------ */

const app = express();
app.set('x-powered-by', false); // don't leak Express in the response headers

app.get('/__debug', (req, res, next) => {
  if (!DEBUG) return next();
  const now = Date.now();
  res.json({
    node: process.version,
    targetHost: TARGET_HOST,
    flags: FLAGS,
    timeoutMs: TIMEOUT_MS,
    learnedHosts: [...learnedHosts],
    inflight: [...inflight.values()].map((c) => ({
      id: c.id,
      method: c.method,
      url: c.url,
      upstream: `${c.host}${c.path}`,
      stage: c.stage,
      ageMs: now - c.start,
      idleMs: now - c.lastActivity,
      bytes: c.bytes,
    })),
  });
});

app.use((req, res, next) => {
  if (req.method !== 'OPTIONS') return next();
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': req.headers['access-control-request-headers'] || 'Content-Type, Authorization',
    'access-control-max-age': '86400',
  });
  res.end();
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use((req, res) => {
  const ctx = {
    id: nextId++,
    start: Date.now(),
    method: req.method,
    url: req.originalUrl,
    host: '?',
    path: '?',
    stage: 'received',
    lastActivity: Date.now(),
    bytes: 0,
    failed: false,
    clientGone: false,
  };
  inflight.set(ctx.id, ctx);
  let proxyReq = null;

  const fail = (status, msg) => {
    if (ctx.failed || ctx.clientGone) return;
    ctx.failed = true;
    elog(ctx, msg);
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) res.status(status).type('text/plain').send(`Proxy error: ${msg}\n`);
    else res.destroy();
  };

  res.on('close', () => {
    if (!res.writableFinished && !ctx.failed) {
      ctx.clientGone = true;
      dlog(ctx, `client went away in stage "${ctx.stage}"`);
      if (proxyReq) proxyReq.destroy();
    }
    if (inflight.delete(ctx.id)) dlog(ctx, `done: status=${res.statusCode} bytes=${ctx.bytes}`);
  });

  dlog(ctx, `← client ${req.method} ${req.originalUrl}`);

  if (FLAGS.blockFavicon && FAVICON_PATH.test(req.path)) {
    dlog(ctx, `blocked favicon/icon request: ${req.originalUrl}`);
    ctx.failed = true;
    inflight.delete(ctx.id);
    return res.status(204).end();
  }

  const target = resolveTarget(req.originalUrl);
  if (!target) {
    dlog(ctx, 'unknown /__ext/ host (never learned) -> 404');
    return res.status(404).type('text/plain').send('Unknown /__ext/ host\n');
  }
  const { host, path } = target;
  ctx.host = host;
  ctx.path = path;

  const headers = { ...req.headers, host };
  delete headers.connection;
  headers['accept-encoding'] = 'identity';
  if (headers.origin) headers.origin = `https://${host}`;
  if (headers.referer) headers.referer = `https://${host}/`;

  if (FLAGS.stripConditional && !BINARY_PATH.test(path)) {
    delete headers.range;
    delete headers['if-range'];
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
  }

  const options = {
    hostname: host,
    port: host === TARGET_HOST ? UPSTREAM_PORT : 443,
    path,
    method: req.method,
    headers,
    timeout: TIMEOUT_MS,
  };
  if (FLAGS.safeLookup) options.lookup = safeLookup;

  dlog(ctx, `→ upstream ${req.method} https://${host}:${options.port}${path}`);
  setStage(ctx, 'connecting');

  proxyReq = https.request(options, (proxyRes) => {
    const status = proxyRes.statusCode || 502;
    const h = proxyRes.headers;
    const contentType = h['content-type'] || '';
    setStage(ctx, 'headers-received');
    dlog(
      ctx,
      `← upstream ${status} type=${contentType || '-'} len=${h['content-length'] ?? '-'} ` +
        `enc=${h['content-encoding'] ?? '-'} te=${h['transfer-encoding'] ?? '-'}` +
        (h.location ? ` location=${h.location}` : '')
    );

    proxyRes.on('error', (err) => fail(502, `error reading upstream response: ${err.code || ''} ${err.message}`));
    proxyRes.on('close', () => {
      if (!proxyRes.complete) {
        fail(502, `upstream closed the connection mid-response (stage "${ctx.stage}", ${ctx.bytes} bytes)`);
      }
    });

    let location = h.location;
    if (location) {
      const mapped = toProxyPath(location, host, path);
      if (mapped === null) {
        proxyRes.resume();
        return fail(502, `blocked redirect to a private / non-public host: ${location}`);
      }
      dlog(ctx, `redirect ${location} -> ${mapped}`);
      location = mapped;
    }

    // ---- Decide how to handle the body ----
    const isJsonCt = JSON_TYPES.test(contentType);
    const isHtmlCt = /^text\/html/i.test(contentType);
    const isRewritableCt = REWRITABLE_TYPES.test(contentType);
    const isJsonRewritable = isJsonCt && FLAGS.rewriteJson;

    // Provisional plan based on content-type alone. We may still downgrade
    // this after we have the body and can sniff its first bytes.
    const planUrlRewrite = (isRewritableCt || isJsonRewritable) && FLAGS.rewrite;
    const planBrand = isHtmlCt && FLAGS.brand;
    const planClean = isHtmlCt && FLAGS.clean;

    let skip = null;
    if (!(planUrlRewrite || planBrand || planClean)) {
      if (isJsonCt && !FLAGS.rewriteJson) skip = 'json (REWRITE_JSON=0, body passes through unchanged)';
      else if (!/^(text\/|application\/(javascript|json|xml|xhtml))/i.test(contentType)) skip = 'not a text type';
      else if (!isUtf8Charset(contentType)) skip = 'non-UTF-8 charset';
      else if (req.method === 'HEAD') skip = 'HEAD request';
      else if ([204, 206, 304].includes(status)) skip = `status ${status} has no rewritable body`;
      else skip = 'nothing to do';
    } else if (!isUtf8Charset(contentType)) {
      skip = 'non-UTF-8 charset';
    } else if (req.method === 'HEAD') {
      skip = 'HEAD request';
    } else if ([204, 206, 304].includes(status)) {
      skip = `status ${status} has no rewritable body`;
    }

    const wantsRewrite = skip === null;
    const streaming = FLAGS.stream && !wantsRewrite;
    dlog(ctx, `mode: ${wantsRewrite ? 'buffer + rewrite' : streaming ? `stream (${skip})` : `buffer, unchanged (${skip})`}`);

    if (streaming) {
      setStage(ctx, 'streaming-body');
      proxyRes.on('data', (c) => {
        ctx.bytes += c.length;
        ctx.lastActivity = Date.now();
      });
      res.writeHead(status, buildResponseHeaders(proxyRes, location, false));
      proxyRes.pipe(res);
      return;
    }

    setStage(ctx, 'buffering-body');
    const chunks = [];
    proxyRes.on('data', (c) => {
      chunks.push(c);
      ctx.bytes += c.length;
      ctx.lastActivity = Date.now();
    });
    proxyRes.on('end', () => {
      if (ctx.failed || ctx.clientGone) return;
      setStage(ctx, 'body-received');
      let body = Buffer.concat(chunks);
      let rewritten = false;

      if (wantsRewrite) {
        if (body.length > MAX_REWRITE_BYTES) {
          wlog(ctx, `body is ${body.length} bytes (> MAX_REWRITE_BYTES), sending unchanged`);
        } else {
          try {
            const t0 = Date.now();
            const stats = { urls: 0, brand: 0, cleaned: 0 };
            let text = decodeBody(body, h['content-encoding']).toString('utf8');

            // ---- Sniff-based overrides ----
            // Some upstream apps (this one included) send `text/html` for JSON
            // API responses. If the body starts with { or [, it is JSON, and we
            // must not inject the cleaner or run brand replacement on it.
            const bodyIsJson = looksLikeJson(text);
            const bodyIsHtml = !bodyIsJson && looksLikeHtml(text);

            let doUrlRewrite = planUrlRewrite;
            let doBrand = planBrand;
            let doClean = planClean;

            if (bodyIsJson) {
              if (doBrand || doClean) {
                dlog(ctx, `body sniffs as JSON despite content-type "${contentType}" — skipping brand/clean injection`);
              }
              doBrand = false;
              doClean = false;
              // JSON URL rewriting is opt-in only; keep it off unless the user asked.
              doUrlRewrite = FLAGS.rewriteJson && FLAGS.rewrite;
            } else if (!bodyIsHtml && (doBrand || doClean)) {
              // Text but not HTML (e.g. CSV, plain text): don't inject <script>.
              doBrand = false;
              doClean = false;
            }

            if (doUrlRewrite) text = rewriteBody(text, stats);
            if (doBrand) text = brandHtml(text, stats);
            if (doClean) text = injectCleanScript(text, stats);

            body = Buffer.from(text, 'utf8');
            rewritten = true;
            const ms = Date.now() - t0;
            dlog(
              ctx,
              `rewrite: ${stats.urls} urls, ${stats.brand} brand swaps, ` +
                `${stats.cleaned} pages cleaned, ${body.length} bytes, ${ms}ms` +
                (bodyIsJson ? ' [sniffed as JSON]' : bodyIsHtml ? ' [sniffed as HTML]' : '')
            );
            if (ms > 1000) wlog(ctx, `rewrite was slow (${ms}ms for ${body.length} bytes)`);
          } catch (err) {
            elog(ctx, `rewrite skipped, sending original bytes: ${err.message}`);
          }
        }
      }

      res.writeHead(status, buildResponseHeaders(proxyRes, location, rewritten));
      res.end(body);
      setStage(ctx, 'sent');
    });
  });

  proxyReq.on('socket', (socket) => {
    if (proxyReq.reusedSocket) {
      dlog(ctx, 'reusing keep-alive socket');
      setStage(ctx, 'waiting-for-headers');
      return;
    }
    const t0 = Date.now();
    socket.once('lookup', (err, address, family) =>
      dlog(ctx, `dns ${host} -> ${err ? `ERR ${err.code}` : `${address} (IPv${family})`} in ${Date.now() - t0}ms`)
    );
    socket.once('connect', () => dlog(ctx, `tcp connected in ${Date.now() - t0}ms`));
    socket.once('secureConnect', () => {
      dlog(ctx, `tls handshake done in ${Date.now() - t0}ms`);
      setStage(ctx, 'waiting-for-headers');
    });
  });

  proxyReq.on('finish', () => {
    ctx.lastActivity = Date.now();
    dlog(ctx, 'request sent upstream');
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy(
      Object.assign(new Error(`no data from upstream for ${TIMEOUT_MS}ms (stage "${ctx.stage}")`), { code: 'PROXY_TIMEOUT' })
    );
  });

  proxyReq.on('error', (err) => {
    fail(err.code === 'PROXY_TIMEOUT' ? 504 : 502, `${host}${path}: ${err.code || ''} ${err.message}`);
  });

  if (req.method === 'GET' || req.method === 'HEAD') proxyReq.end();
  else req.pipe(proxyReq);
});

app.listen(PORT, () => {
  console.log(`Proxy server running on http://localhost:${PORT} -> https://${TARGET_HOST}:${UPSTREAM_PORT} (node ${process.version})`);
  console.log(`flags: ${JSON.stringify(FLAGS)}  upstream timeout: ${TIMEOUT_MS}ms`);
  console.log(DEBUG ? 'DEBUG on: verbose logs, /__debug lists in-flight requests' : 'Set DEBUG=1 for verbose logs');
});
