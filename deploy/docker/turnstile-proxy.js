'use strict';

/**
 * Tiny allowlisted egress proxy so gateway can stay off the shared edge network
 * while still reaching Cloudflare Turnstile siteverify.
 */
const http = require('http');
const https = require('https');

const PORT = Number(process.env.PORT || 8791);
const UPSTREAM = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/siteverify') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const upstream = https.request(
      UPSTREAM,
      {
        method: 'POST',
        headers: {
          'content-type': req.headers['content-type'] || 'application/x-www-form-urlencoded',
          'content-length': body.length,
        },
      },
      (up) => {
        res.writeHead(up.statusCode || 502, {
          'content-type': up.headers['content-type'] || 'application/json',
        });
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('upstream error');
    });
    upstream.end(body);
  });
});

server.listen(PORT, '0.0.0.0', () => {
   
  console.log(`turnstile-proxy on :${PORT}`);
});
