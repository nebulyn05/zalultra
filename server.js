import express from 'express';
import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';

const app = express();
const TARGET = 'https://zalcrm.com';

app.use(async (req, res) => {
  if (req.path === '/favicon.ico') return res.status(204).end();

  const targetUrl = TARGET + req.originalUrl;
  const upstream = await fetch(targetUrl, { headers: { /* forward cookies etc. */ } });
  let body = await upstream.text();

  // 1. Swap the name
  body = body.replaceAll('Onezeroart', 'YourBrand');

  // 2. Only rewrite HTML
  const ct = upstream.headers.get('content-type') || '';
  if (ct.includes('text/html')) {
    const dom = new JSDOM(body);
    const doc = dom.window.document;

    // remove favicon links
    doc.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]')
       .forEach(el => el.remove());

    // remove logos (adapt selectors to the real site)
    doc.querySelectorAll('img[alt*="logo" i], .logo, #logo, svg.logo')
       .forEach(el => el.remove());

    // rewrite absolute URLs back through the proxy
    doc.querySelectorAll('[href]').forEach(el => {
      const h = el.getAttribute('href');
      if (h && h.startsWith(TARGET)) el.setAttribute('href', h.replace(TARGET, ''));
    });
    doc.querySelectorAll('[src]').forEach(el => {
      const s = el.getAttribute('src');
      if (s && s.startsWith(TARGET)) el.setAttribute('src', s.replace(TARGET, ''));
    });

    body = dom.serialize();
  }

  res.set('content-type', ct);
  res.send(body);
});

app.listen(3000);
