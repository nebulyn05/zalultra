const RAW_TARGET_URL = process.env.TARGET_URL || 'https://zalcrm.com';
const BRAND_NAME = process.env.BRAND_NAME || 'YourBrand';
const BUILD_MARKER = 'redirect-follow-2026-10-07';
const MAX_REDIRECTS = 5;

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
  const log = (event, extra = {}) => console.log(JSON.stringify({
    requestId, event, build: BUILD_MARKER, elapsedMs: Date.now() - started, ...extra
  }));

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

  try {
    const original = upstreamUrl(request);
    const method = String(request.method || 'GET').toUpperCase();
    let current = original;
    let cookieJar = [];
    let upstream;
    
    log('proxy_start', { method, path: incomingUrl(request).pathname, upstreamUrl: original.toString() });

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      log('upstream_fetch_start', { url: current.toString(), redirectNumber: redirects });

      const headers = new Headers();
      headers.set('host', TARGET.host);
      if (cookieJar.length) headers.set('cookie', cookieJar.join('; '));

      upstream = await fetch(current, {
        method,
        headers,
        redirect: 'manual'
      });

      log('upstream_fetch_complete', {
        status: upstream.status,
        location: upstream.headers.get('location'),
        contentType: upstream.headers.get('content-type'),
        redirectNumber: redirects
      });

      const cookies = typeof upstream.headers.getSetCookie === 'function'
        ? upstream.headers.getSetCookie()
        : [];
      for (const cookie of cookies) {
        const pair = cookie.split(';', 1)[0];
        const name = pair.split('=', 1)[0];
        cookieJar = cookieJar.filter(existing => existing.split('=', 1)[0] !== name);
        cookieJar.push(pair);
      }

      if (upstream.status < 300 || upstream.status >= 400) break;

      const location = upstream.headers.get('location');
      if (!location) break;

      const next = new URL(location, current);
      if (next.origin !== TARGET.origin) {
        log('redirect_external', { location: next.toString() });
        break;
      }

      current = next;
    }

    const headers = new Headers();
    const blocked = new Set([
      'connection','keep-alive','proxy-authenticate','proxy-authorization',
      'te','trailer','transfer-encoding','upgrade','host','content-length',
      'content-encoding','location','set-cookie'
    ]);

    for (const [name, value] of upstream.headers) {
      if (!blocked.has(name.toLowerCase())) headers.set(name, value);
    }

    for (const cookie of (typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie() : [])) {
      headers.append('set-cookie', rewriteCookie(cookie));
    }

    // Preserve any cookies established while internally following redirects.
    for (const pair of cookieJar) {
      headers.append('set-cookie', rewriteCookie(pair + '; Path=/'));
    }

    const location = upstream.headers.get('location');
    if (location) {
      const next = new URL(location, current);
      headers.set(
        'location',
        next.origin === TARGET.origin
          ? next.pathname + next.search + next.hash
          : next.toString()
      );
    }

    log('proxy_response_ready', {
      status: upstream.status,
      contentType: upstream.headers.get('content-type'),
      finalUrl: current.toString()
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
