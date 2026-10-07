import { JSDOM } from 'jsdom';

const RAW_TARGET_URL = process.env.TARGET_URL || 'https://zalcrm.com';
const BRAND_NAME = process.env.BRAND_NAME || 'YourBrand';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 20000);

function normalizeTargetUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'https://zalcrm.com';

  try {
    const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw)
      ? raw
      : `https://${raw}`;
    const url = new URL(withScheme);

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('TARGET_URL must use http or https');
    }

    return url;
  } catch {
    throw new Error(`Invalid TARGET_URL configuration: ${raw}`);
  }
}

const TARGET = normalizeTargetUrl(RAW_TARGET_URL);

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'content-encoding'
]);

const REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'authorization',
  'cache-control',
  'cookie',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'origin',
  'pragma',
  'range',
  'referer',
  'user-agent',
  'x-csrf-token',
  'x-requested-with'
]);

function getIncomingUrl(request) {
  const requestUrl = String(request.url || '/');
  return new URL(requestUrl, 'http://vercel.local');
}

function getUpstreamUrl(request) {
  const incoming = getIncomingUrl(request);
  const path = incoming.pathname.startsWith('/') ? incoming.pathname : `/${incoming.pathname}`;
  const upstreamUrl = `${TARGET.origin}${path}${incoming.search}`;
  return new URL(upstreamUrl);
}

function getForwardHeaders(request) {
  const headers = new Headers();

  const incomingHeaders = request.headers instanceof Headers
    ? Array.from(request.headers.entries())
    : Object.entries(request.headers || {});

  for (const [name, rawValue] of incomingHeaders) {
    const lower = name.toLowerCase();
    if (!REQUEST_HEADERS.has(lower)) continue;

    const value = Array.isArray(rawValue)
      ? rawValue.join(', ')
      : String(rawValue ?? '');

    headers.set(name, value);
  }

  headers.set('host', TARGET.host);
  headers.delete('accept-encoding');

  return headers;
}

function rewriteUrl(value) {
  if (!value) return value;

  try {
    const url = new URL(value, TARGET.href);
    if (url.origin !== TARGET.origin) return value;

    return url.pathname + url.search + url.hash;
  } catch {
    return value;
  }
}

function rewriteCookie(cookie) {
  return cookie
    .replace(/;\s*Domain=[^;]*/i, '')
    .replace(/;\s*SameSite=None/i, '; SameSite=Lax');
}

function copyResponseHeaders(upstream) {
  const headers = new Headers();

  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();

    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'set-cookie' || lower === 'location') {
      continue;
    }

    headers.set(name, value);
  }

  return headers;
}

async function rewriteHtml(body) {
  const dom = new JSDOM(body);
  const doc = dom.window.document;

  // Rebrand visible/source text.
  doc.documentElement.innerHTML = doc.documentElement.innerHTML
    .replaceAll('Onezeroart', BRAND_NAME);

  // Remove favicon references and common logo elements.
  doc.querySelectorAll(
    'link[rel~="icon"], link[rel="shortcut icon"], ' +
    'img[alt*="logo" i], .logo, #logo, svg.logo'
  ).forEach((el) => el.remove());

  // Keep navigation and form submissions inside the proxy.
  for (const selector of [
    'a[href]',
    'link[href]',
    'script[src]',
    'img[src]',
    'source[src]',
    'video[src]',
    'audio[src]',
    'form[action]'
  ]) {
    doc.querySelectorAll(selector).forEach((el) => {
      const attribute = selector.includes('[action]')
        ? 'action'
        : selector.includes('[href]')
          ? 'href'
          : 'src';

      const value = el.getAttribute(attribute);
      const rewritten = rewriteUrl(value);

      if (rewritten !== value) {
        el.setAttribute(attribute, rewritten);
      }
    });
  }

  doc.querySelectorAll('[srcset]').forEach((el) => {
    const value = el.getAttribute('srcset');
    if (!value) return;

    const rewritten = value
      .split(',')
      .map((candidate) => {
        const parts = candidate.trim().split(/\s+/);
        parts[0] = rewriteUrl(parts[0]);
        return parts.join(' ');
      })
      .join(', ');

    el.setAttribute('srcset', rewritten);
  });

  return dom.serialize();
}


async function readUpstreamHtml(body, {
  maxBytes = 8 * 1024 * 1024,
  totalTimeoutMs = 15000,
  idleTimeoutMs = 4000
} = {}) {
  if (!body) return '';

  const reader = body.getReader();
  const decoder = new TextDecoder();
    let totalBytes = 0;
  let text = '';
  const startedAt = Date.now();

  let idleTimer;
  let totalTimer;
  let settled = false;

  const cleanup = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
  };

  const fail = async (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    try {
      await reader.cancel();
    } catch {
      // Best-effort cancellation.
    }
    throw error;
  };

  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reader.cancel().catch(() => {});
      }
    }, idleTimeoutMs);
  };

  totalTimer = setTimeout(() => {
    if (!settled) {
      settled = true;
      cleanup();
      reader.cancel().catch(() => {});
    }
  }, totalTimeoutMs);

  try {
    armIdleTimer();

    while (!settled) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value) {
        totalBytes += value.byteLength;

        if (totalBytes > maxBytes) {
          await fail(new Error('Upstream HTML exceeded ' + maxBytes + ' bytes'));
        }

        const chunk = decoder.decode(value, { stream: true });
        text += chunk;

        // ZalCRM can keep the HTTP connection open after the complete
        // document has arrived. Once the closing HTML tag is present,
        // there is nothing useful left for the white-label proxy to wait for.
        if (/<\/html\s*>/i.test(text)) {
          settled = true;
          break;
        }
      }

      armIdleTimer();
    }

    cleanup();

    if (!settled && Date.now() - startedAt >= totalTimeoutMs) {
      throw new Error('Upstream HTML body timed out after ' + totalTimeoutMs + 'ms');
    }

    if (!text) {
      text = decoder.decode();
    } else {
      text += decoder.decode();
    }

    try {
      await reader.cancel();
    } catch {
      // Best-effort cancellation.
    }

    return text;
  } catch (error) {
    cleanup();
    try {
      await reader.cancel();
    } catch {
      // Best-effort cancellation.
    }
    throw error;
  }
}

export const runtime = 'nodejs';
export const maxDuration = 60;

export default async function handler(request) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const log = (event, details = {}) => {
    console.log(JSON.stringify({
      requestId,
      event,
      ...details,
      elapsedMs: Date.now() - startedAt
    }));
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers':
          request.headers.get('access-control-request-headers') || 'Content-Type, Authorization',
        'access-control-allow-origin': request.headers.get('origin') || '*'
      }
    });
  }

  try {
    let upstreamUrl = getUpstreamUrl(request);
    const method = request.method.toUpperCase();
    const upstreamController = new AbortController();
    let timeout;

    const abortUpstream = (reason) => {
      if (!upstreamController.signal.aborted) {
        upstreamController.abort(reason);
      }
    };

    if (request.signal) {
      request.signal.addEventListener(
        'abort',
        () => abortUpstream(new Error('Client request aborted')),
        { once: true }
      );
    }

    log('proxy_start', {
      method,
      path: getIncomingUrl(request).pathname,
      upstreamUrl: upstreamUrl.toString(),
      upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS
    });

    const init = {
      method,
      headers: getForwardHeaders(request),
      redirect: 'follow',
      signal: upstreamController.signal
    };

    if (!['GET', 'HEAD'].includes(method)) {
      init.body = await request.arrayBuffer();
    }

    log('upstream_fetch_start', {
      method,
      url: upstreamUrl.toString(),
      redirectMode: 'follow'
    });

    const fetchStartedAt = Date.now();
    const fetchPromise = fetch(upstreamUrl, init);
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        log('upstream_timeout_fired', {
          timeoutMs: UPSTREAM_TIMEOUT_MS,
          fetchMs: Date.now() - fetchStartedAt
        });
        abortUpstream(new Error('Upstream timeout after ' + UPSTREAM_TIMEOUT_MS + 'ms'));
        reject(new Error('Upstream timeout after ' + UPSTREAM_TIMEOUT_MS + 'ms'));
      }, UPSTREAM_TIMEOUT_MS);
    });

    try {
      upstream = await Promise.race([fetchPromise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    const location = upstream.headers.get('location');

    log('upstream_headers', {
      status: upstream.status,
      statusText: upstream.statusText,
      contentType: upstream.headers.get('content-type'),
      contentLength: upstream.headers.get('content-length'),
      location,
      server: upstream.headers.get('server'),
      via: upstream.headers.get('via'),
      cacheStatus: upstream.headers.get('x-cache') || upstream.headers.get('cf-cache-status'),
      fetchMs: Date.now() - fetchStartedAt
    });

    if (upstream.status >= 300 && upstream.status < 400 && location) {
      log('upstream_redirect_unexpected', {
        status: upstream.status,
        location
      });
    }

    const responseHeaders = copyResponseHeaders(upstream);

    const setCookies = typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : [];

    for (const cookie of setCookies) {
      responseHeaders.append('set-cookie', rewriteCookie(cookie));
    }

    const contentType = upstream.headers.get('content-type') || '';

    if (contentType.includes('text/html') && method !== 'HEAD') {
      const body = await readUpstreamHtml(upstream.body);
      const bodyBytes = Buffer.byteLength(body);
      const bodyPreview = body
        .replace(/(set-cookie|authorization|password|token|csrf)[^\n]{0,120}/gi, '[redacted]')
        .slice(0, 500);

      log('upstream_body_read', {
        bytes: bodyBytes,
        contentType,
        bodyPreview
      });
      const rewriteStartedAt = Date.now();
      const rewritten = await rewriteHtml(body);
      log('html_rewritten', { inputBytes: Buffer.byteLength(body), outputBytes: Buffer.byteLength(rewritten), rewriteMs: Date.now() - rewriteStartedAt });

      responseHeaders.delete('content-length');


      return new Response(rewritten, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      });
    }


    log('proxy_complete', {
      status: upstream.status,
      contentType,
      contentLength: upstream.headers.get('content-length'),
      streamed: method !== 'HEAD',
      totalMs: Date.now() - startedAt
    });

    return new Response(method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    const isAbort = error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || /timeout|aborted/i.test(error?.message || '');
    console.error(JSON.stringify({
      requestId,
      event: isAbort ? 'upstream_abort_or_timeout' : 'proxy_error',
      errorName: error?.name,
      errorCode: error?.code,
      errorMessage: error?.message,
      cause: error?.cause ? String(error.cause) : undefined,
      stack: error?.stack,
      elapsedMs: Date.now() - startedAt
    }));

    return Response.json(
      {
        error: isAbort ? 'Upstream request timed out or was aborted' : 'Upstream proxy request failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        requestId
      },
      { status: isAbort ? 504 : 502 }
    );
  }
}
