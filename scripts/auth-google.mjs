#!/usr/bin/env node
// One-shot OAuth flow that mints a refresh token with BOTH calendar and
// spreadsheets scopes, written in the same format @cocal/google-calendar-mcp
// expects so calendar MCP, sheets MCP, and sheets.mjs all share one token.
//
// Usage:
//   node scripts/auth-google.mjs
//
// Prereqs:
//   - data/google-calendar/gcp-oauth.keys.json exists
//   - Consent screen declares both scopes
//   - Your Google account is a test user on the app
//
// Writes: ~/.config/google-calendar-mcp/tokens.json

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { execSync } from 'child_process';

const KEYS_PATH = path.resolve('data/google-calendar/gcp-oauth.keys.json');
const TOKENS_PATH = path.join(
  os.homedir(),
  '.config',
  'google-calendar-mcp',
  'tokens.json',
);
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
];
const PORT = 3000;
const REDIRECT = `http://localhost:${PORT}`;

const keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')).installed;
const state = crypto.randomBytes(16).toString('hex');

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: keys.client_id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();

console.log('\nOpening browser for Google OAuth consent...');
console.log('Requested scopes:', SCOPES.join(', '), '\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  if (!code || gotState !== state) {
    res.writeHead(400).end('Missing code or state mismatch');
    return;
  }
  try {
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: keys.client_id,
        client_secret: keys.client_secret,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }),
    });
    const tok = await tokenResp.json();
    if (!tok.access_token || !tok.refresh_token) {
      throw new Error(`Token exchange failed: ${JSON.stringify(tok)}`);
    }
    const expiry_date = Date.now() + tok.expires_in * 1000;
    const out = {
      normal: {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        scope: tok.scope,
        token_type: tok.token_type,
        expiry_date,
      },
    };
    fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(out, null, 2), { mode: 0o600 });
    console.log(`\n✓ Tokens written to ${TOKENS_PATH}`);
    console.log(`  Scopes granted: ${tok.scope}\n`);
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(
      '<h2>Auth complete — you can close this tab.</h2>',
    );
    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 500);
  } catch (err) {
    console.error('Auth failed:', err.message);
    res.writeHead(500).end(`Error: ${err.message}`);
    setTimeout(() => process.exit(1), 500);
  }
});

server.listen(PORT, () => {
  try {
    execSync(`open "${authUrl}"`, { stdio: 'ignore' });
  } catch {
    console.log('Open this URL manually:\n', authUrl);
  }
});
