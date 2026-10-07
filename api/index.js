const RAW_TARGET_URL = process.env.TARGET_URL || 'https://zalcrm.com';
const BUILD_MARKER = 'native-follow-2026-10-07';

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

  const log = (event, extra = {}) => {
    console.log(JSON.stringify({
      requestId, event, build: BUILD_MARKER,
      elapsedMs: Date.now() - started, ...extra
    }));
  };

  try {
    const target = upstreamUrl(request);
    const method = String(request.method || 'GET').toUpperCase();

    log('proxy_start', {
      method,
      path: incomingUrl(request).pathname,
      upstreamUrl: target.toString()
    });

    log('fetch_before', { url: target.toString() });

    const upstream = await fetch(target, {
      method,
      redirect: 'follow'
    });

    log('fetch_after', {
      status: upstream.status,
      statusText: upstream.statusText,
      finalUrl: upstream.url,
      contentType: upstream.headers.get('content-type')
    });

    const headers = copyHeaders(upstream);

    log('response_ready', { status: upstream.status });

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
