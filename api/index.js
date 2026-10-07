const RAW_TARGET_URL = process.env.TARGET_URL || 'https://zalcrm.com';
const BRAND_NAME = process.env.BRAND_NAME || 'YourBrand';
const BUILD_MARKER = 'transport-minimal-2026-10-07';

function getTarget() {
  const raw = String(RAW_TARGET_URL).trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('TARGET_URL must use http or https');
  }
  return url;
}

const TARGET = getTarget();

function incomingUrl(request) {
  return new URL(String(request.url || '/'), 'http://vercel.local');
}

function upstreamUrl(request) {
  const incoming = incomingUrl(request);
  return new URL(TARGET.origin + incoming.pathname + incoming.search);
}

function responseHeaders(upstream) {
  const headers = new Headers();
  const hop = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
    'content-encoding', 'location', 'set-cookie'
  ]);

  for (const [name, value] of upstream.headers) {
    if (!hop.has(name.toLowerCase())) headers.set(name, value);
  }

  return headers;
}

function rewriteCookie(cookie) {
  return cookie
    .replace(/;\s*Domain=[^;]*/i, '')
    .replace(/;\s*SameSite=None/i, '; SameSite=Lax');
}

export const runtime = 'nodejs';
export const maxDuration = 60;

export default async function handler(request) {
  const requestId = crypto.randomUUID();
  const started = Date.now();

  const log = (event, extra = {}) => {
    console.log(JSON.stringify({
      requestId,
      event,
      build: BUILD_MARKER,
      elapsedMs: Date.now() - started,
      ...extra
    }));
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization',
        'access-control-allow-origin': '*'
      }
    });
  }

  let target;
  let method;

  try {
    target = upstreamUrl(request);
    method = String(request.method || 'GET').toUpperCase();

    log('proxy_start', {
      method,
      path: incomingUrl(request).pathname,
      upstreamUrl: target.toString()
    });

    // Deliberately do not inspect request.headers or request.signal.
    // This isolates Vercel request-object handling from upstream transport.
    log('transport_fetch_start', {
      method,
      upstreamUrl: target.toString()
    });

    const fetchStarted = Date.now();
    const upstream = await fetch(target, {
      method,
      redirect: 'manual'
    });

    log('transport_fetch_complete', {
      status: upstream.status,
      statusText: upstream.statusText,
      location: upstream.headers.get('location'),
      contentType: upstream.headers.get('content-type'),
      fetchMs: Date.now() - fetchStarted
    });

    const headers = responseHeaders(upstream);

    const cookies = typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : [];

    for (const cookie of cookies) {
      headers.append('set-cookie', rewriteCookie(cookie));
    }

    const location = upstream.headers.get('location');
    if (location) {
      const locationUrl = new URL(location, target);
      if (locationUrl.origin === TARGET.origin) {
        headers.set('location', locationUrl.pathname + locationUrl.search + locationUrl.hash);
      } else {
        headers.set('location', location);
      }
    }

    log('proxy_response_ready', {
      status: upstream.status,
      contentType: upstream.headers.get('content-type')
    });

    return new Response(method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    });
  } catch (error) {
    log('proxy_failure', {
      errorName: error?.name,
      errorMessage: error?.message,
      stack: error?.stack
    });

    return Response.json({
      error: 'Proxy failure',
      message: error?.message || 'Unknown error',
      requestId
    }, { status: 502 });
  }
}
