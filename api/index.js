const RAW_TARGET_URL = process.env.TARGET_URL || 'https://zalcrm.com';
const BUILD_MARKER = 'manual-follow-no-headers-2026-10-07';
const MAX_REDIRECTS = 5;

const TARGET = (() => {
  const raw = String(RAW_TARGET_URL).trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('TARGET_URL must use http or https');
  return url;
})();

function incomingUrl(request) {
  return new URL(String(request.url || '/'), 'http://vercel.local');
}

function upstreamUrl(request) {
  const incoming = incomingUrl(request);
  return new URL(TARGET.origin + incoming.pathname + incoming.search);
}

function rewriteCookie(cookie) {
  return cookie
    .replace(/;\s*Domain=[^;]*/i, '')
    .replace(/;\s*SameSite=None/i, '; SameSite=Lax');
}

function copyHeaders(upstream) {
  const out = new Headers();
  const blocked = new Set([
    'connection','keep-alive','proxy-authenticate','proxy-authorization',
    'te','trailer','transfer-encoding','upgrade','host','content-length',
    'content-encoding','location','set-cookie'
  ]);
  for (const [name, value] of upstream.headers) {
    if (!blocked.has(name.toLowerCase())) out.set(name, value);
  }
  return out;
}

export const runtime = 'nodejs';
export const maxDuration = 60;

export default async function handler(request) {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  const log = (event, extra = {}) => console.log(JSON.stringify({
    requestId, event, build: BUILD_MARKER, elapsedMs: Date.now() - started, ...extra
  }));

  try {
    const original = upstreamUrl(request);
    const method = String(request.method || 'GET').toUpperCase();
    let current = original;
    let upstream;
    const cookieJar = [];

    log('proxy_start', { method, path: incomingUrl(request).pathname, upstreamUrl: original.toString() });

    for (let redirectNumber = 0; redirectNumber <= MAX_REDIRECTS; redirectNumber++) {
      log('fetch_before', { url: current.toString(), redirectNumber });

      // Do not touch request.headers or add a Host header. The earlier
      // successful transport test proved bare fetch() works on this runtime.
      upstream = await fetch(current, {
        method,
        redirect: 'manual'
      });

      log('fetch_after', {
        status: upstream.status,
        location: upstream.headers.get('location'),
        contentType: upstream.headers.get('content-type'),
        redirectNumber
      });

      const cookies = typeof upstream.headers.getSetCookie === 'function'
        ? upstream.headers.getSetCookie()
        : [];

      for (const cookie of cookies) {
        const pair = cookie.split(';', 1)[0];
        const name = pair.split('=', 1)[0];
        const index = cookieJar.findIndex(existing => existing.split('=', 1)[0] === name);
        if (index >= 0) cookieJar[index] = pair;
        else cookieJar.push(pair);
      }

      if (upstream.status < 300 || upstream.status >= 400) break;

      const location = upstream.headers.get('location');
      if (!location) break;

      const next = new URL(location, current);
      if (next.origin !== TARGET.origin) {
        log('redirect_blocked_external', { location: next.toString() });
        break;
      }

      current = next;
    }

    const headers = copyHeaders(upstream);

    const finalCookies = typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : [];

    for (const cookie of finalCookies) {
      headers.append('set-cookie', rewriteCookie(cookie));
    }

    // The proxy cannot replay the upstream cookie jar back to the browser
    // as a single Cookie header; expose established pairs as normal cookies.
    for (const pair of cookieJar) {
      headers.append('set-cookie', rewriteCookie(pair + '; Path=/'));
    }

    const location = upstream.headers.get('location');
    if (location) {
      const next = new URL(location, current);
      headers.set('location',
        next.origin === TARGET.origin
          ? next.pathname + next.search + next.hash
          : next.toString()
      );
    }

    log('response_ready', {
      status: upstream.status,
      finalUrl: current.toString(),
      contentType: upstream.headers.get('content-type')
    });

    return new Response(method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    });
  } catch (error) {
    log('failure', {
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
