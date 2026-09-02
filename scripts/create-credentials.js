#!/usr/bin/env node
/**
 * Creates the three credentials this workflow needs, in the n8n credential
 * store, and writes their ids to deploy.config.json.
 *
 * Secrets are read from the environment and never written to any file in this
 * repo. deploy.config.json holds only opaque credential IDs.
 *
 *   PEXELS_API_KEY=... \
 *   YOUTUBE_API_KEY=... \
 *   YOUTUBE_CLIENT_ID=... \
 *   YOUTUBE_CLIENT_SECRET=... \
 *   YOUTUBE_REFRESH_TOKEN=... \
 *   node scripts/create-credentials.js
 *
 * Re-running creates duplicates — n8n's public API has no credential list
 * endpoint to dedupe against. Delete the old ones in the UI first if you rerun.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MCP_JSON = path.join(ROOT, '..', '..', '.mcp.json');
const OUT = path.join(ROOT, 'deploy.config.json');

// The existing OpenRouter credential on this instance. Not created here.
const OPENROUTER = { id: 'zrETA1O6eoO0xBUF', name: 'Lord Bruts OpenRouter' };

function env(name) {
  const v = process.env[name];
  if (!v) {
    console.error('Missing required environment variable: ' + name);
    process.exit(1);
  }
  return v;
}

function n8nConfig() {
  if (process.env.N8N_API_URL && process.env.N8N_API_KEY) {
    return { url: process.env.N8N_API_URL, key: process.env.N8N_API_KEY };
  }
  // Falls back to the MCP config of the builder folder this was developed in.
  // That path does not exist in a standalone clone, so say what to set rather
  // than throwing ENOENT at a reader who has never heard of .mcp.json.
  if (!fs.existsSync(MCP_JSON)) {
    throw new Error(
      'Set N8N_API_URL and N8N_API_KEY in the environment. Reading them from ' +
        MCP_JSON + ' only works inside the n8n builder folder this was developed in.'
    );
  }
  const mcp = JSON.parse(fs.readFileSync(MCP_JSON, 'utf8'));
  const e = mcp.mcpServers['n8n-local'].env;
  return { url: e.N8N_API_URL, key: e.N8N_API_KEY };
}

async function createCredential(cfg, name, type, data) {
  const res = await fetch(cfg.url + '/api/v1/credentials', {
    method: 'POST',
    headers: { 'X-N8N-API-KEY': cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type, data }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error('create ' + type + ' failed (' + res.status + '): ' + body.slice(0, 400));
  }
  const parsed = JSON.parse(body);
  console.log('  created ' + type.padEnd(18) + ' id=' + parsed.id + '  "' + name + '"');
  return { id: parsed.id, name };
}

/**
 * Exchange the refresh token for an access token before storing anything.
 * This validates the whole OAuth triple up front — a bad client secret or a
 * revoked refresh token fails here, loudly, instead of silently at 09:00 on
 * the first scheduled run.
 */
async function seedTokenData(clientId, clientSecret, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(
      'Google refused the refresh token (' +
        res.status +
        '): ' +
        JSON.stringify(body).slice(0, 400)
    );
  }
  const scopes = String(body.scope || '');
  if (!scopes.includes('youtube.upload') && !scopes.includes('auth/youtube')) {
    console.warn(
      '  WARNING: token scopes do not include youtube.upload — upload will 403.\n' +
        '           scopes: ' + (scopes || '(none returned)')
    );
  }
  return {
    access_token: body.access_token,
    refresh_token: refreshToken,
    token_type: body.token_type || 'Bearer',
    scope: body.scope,
    expires_in: body.expires_in,
    expires_on: Math.floor(Date.now() / 1000) + (body.expires_in || 3600),
  };
}

async function main() {
  const cfg = n8nConfig();
  const pexels = env('PEXELS_API_KEY');
  const ytApiKey = env('YOUTUBE_API_KEY');
  const clientId = env('YOUTUBE_CLIENT_ID');
  const clientSecret = env('YOUTUBE_CLIENT_SECRET');
  const refreshToken = env('YOUTUBE_REFRESH_TOKEN');

  console.log('n8n: ' + cfg.url);

  console.log('validating the YouTube refresh token against Google...');
  const oauthTokenData = await seedTokenData(clientId, clientSecret, refreshToken);
  console.log('  refresh token OK, access token acquired');

  console.log('creating credentials...');

  // YouTube Data API key -> ?key=... on search.list / videos.list
  const youtubeApiKey = await createCredential(
    cfg,
    'YouTube Data API Key (Autopilot)',
    'httpQueryAuth',
    { name: 'key', value: ytApiKey }
  );

  // Pexels wants the bare key in Authorization, with no "Bearer " prefix.
  const pexelsCred = await createCredential(cfg, 'Pexels API Key (Autopilot)', 'httpHeaderAuth', {
    name: 'Authorization',
    value: pexels,
  });

  const youtubeOAuth = await createCredential(
    cfg,
    'YouTube Upload (Autopilot)',
    'youTubeOAuth2Api',
    { clientId, clientSecret, oauthTokenData }
  );

  const out = {
    openRouter: OPENROUTER,
    youtubeApiKey,
    pexels: pexelsCred,
    youtubeOAuth,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log('\nwrote ' + OUT + ' (ids only, no secrets)');
}

main().catch((err) => {
  console.error('\nFAILED: ' + err.message);
  process.exit(1);
});
