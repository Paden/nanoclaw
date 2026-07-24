#!/usr/bin/env node
// Tiny HTTP proxy: injects `think` into Anthropic-format requests for Gemini
// models before forwarding to local Ollama. Runs on 127.0.0.1:11435 → 11434.
import http from 'node:http';

const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 11434;
const LISTEN_PORT = Number(process.env.THINK_PROXY_PORT || 11435);
// ponytail: 127.0.0.1 default; Linux Docker needs 0.0.0.0 (containers arrive via bridge IP)
const LISTEN_HOST = process.env.THINK_PROXY_HOST || '127.0.0.1';
const THINK_LEVEL = process.env.THINK_LEVEL || 'low';
const MODEL_MATCH = /gemini/i;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    const isPost = req.method === 'POST';
    const ct = req.headers['content-type'] || '';
    let injected = false;
    let modelSeen = null;
    if (isPost && ct.includes('application/json') && body.length > 0) {
      try {
        const obj = JSON.parse(body.toString('utf8'));
        modelSeen = obj.model ?? null;
        if (
          typeof obj.model === 'string' &&
          MODEL_MATCH.test(obj.model) &&
          obj.think === undefined
        ) {
          obj.think = THINK_LEVEL;
          body = Buffer.from(JSON.stringify(obj));
          injected = true;
        }
      } catch {
        // not JSON — pass through untouched
      }
    }
    if (isPost) {
      console.log(
        `[think-proxy] ${new Date().toISOString()} ${req.url} model=${modelSeen} injected=${injected}`,
      );
    }
    const headers = { ...req.headers };
    headers['content-length'] = String(body.length);
    delete headers['host'];
    const upstream = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: req.url,
        method: req.method,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`proxy error: ${err.message}`);
    });
    upstream.end(body);
  });
  req.on('error', (err) => {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(`bad request: ${err.message}`);
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(
    `[think-proxy] listening ${LISTEN_HOST}:${LISTEN_PORT} → ${UPSTREAM_HOST}:${UPSTREAM_PORT} (think=${THINK_LEVEL} for ${MODEL_MATCH})`,
  );
});
