#!/usr/bin/env node
/**
 * Deploys workflow.json to the local n8n instance.
 *
 * First run creates the workflow and records its id in .wfid; later runs update
 * that workflow in place.
 *
 * The committed workflow.json carries no credentials blocks (credential ids are
 * instance-specific). They are attached here from deploy.config.json at deploy
 * time, keyed by node name.
 *
 *   node scripts/deploy.js          # create or update
 *   node scripts/deploy.js --verify # fetch it back and print the wiring
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MCP_JSON = path.join(ROOT, '..', '..', '.mcp.json');
const WF_JSON = path.join(ROOT, 'workflow.json');
const WFID = path.join(ROOT, '.wfid');
const DEPLOY_CFG = path.join(ROOT, 'deploy.config.json');

// Which credential each node needs. Kept here rather than in workflow.json so
// the committed export stays instance-independent.
const CREDENTIAL_MAP = {
  'YT · Search Channel': { httpQueryAuth: 'youtubeApiKey' },
  'YT · Batch Statistics': { httpQueryAuth: 'youtubeApiKey' },
  'Pexels · Search Footage': { httpHeaderAuth: 'pexels' },
  // The sibling content-engine archive: this pipeline's only citable source.
  'Postgres · Content Memory': { postgres: 'contentEnginePostgres' },
  'OpenRouter · Research': { openRouterApi: 'openRouter' },
  'OpenRouter · Research Retry': { openRouterApi: 'openRouter' },
  'OpenRouter · Script': { openRouterApi: 'openRouter' },
  'OpenRouter · Script Retry': { openRouterApi: 'openRouter' },
  'OpenRouter · Script Revise': { openRouterApi: 'openRouter' },
  'Editorial Verifier': { openRouterApi: 'openRouter' },
  'Editorial Verifier (Round 2)': { openRouterApi: 'openRouter' },
  'YouTube · Upload Video': { youTubeOAuth2Api: 'youtubeOAuth' },
  'YouTube · Set Thumbnail': { youTubeOAuth2Api: 'youtubeOAuth' },
};

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

async function api(cfg, method, route, body) {
  const res = await fetch(cfg.url + route, {
    method,
    headers: { 'X-N8N-API-KEY': cfg.key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(method + ' ' + route + ' -> ' + res.status + ': ' + text.slice(0, 700));
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Any node that declares authentication but carries no credentials will 401 at
 * runtime. Derived from the node's own parameters rather than from
 * CREDENTIAL_MAP, because the failure this catches IS an incomplete map: three
 * new OpenRouter nodes were once deployed uncredentialed and the old check,
 * which only inspected mapped nodes, reported "none missing".
 */
function auditCredentials(workflow) {
  return workflow.nodes
    .filter((n) => {
      const auth = n.parameters && n.parameters.authentication;
      const needs = auth === 'predefinedCredentialType' || auth === 'genericCredentialType';
      // Node types that always require a credential without declaring an
      // `authentication` parameter at all. Anything added here must also be
      // added to CREDENTIAL_MAP, which is the point of the check.
      const ALWAYS = ['n8n-nodes-base.youTube', 'n8n-nodes-base.postgres'];
      return needs || ALWAYS.includes(n.type);
    })
    .filter((n) => !n.credentials || Object.keys(n.credentials).length === 0)
    .map((n) => n.name);
}

function attachCredentials(workflow) {
  const creds = JSON.parse(fs.readFileSync(DEPLOY_CFG, 'utf8'));
  let attached = 0;
  for (const node of workflow.nodes) {
    const wanted = CREDENTIAL_MAP[node.name];
    if (!wanted) continue;
    node.credentials = {};
    for (const [credType, cfgKey] of Object.entries(wanted)) {
      const c = creds[cfgKey];
      if (!c || !c.id) {
        throw new Error(
          'deploy.config.json has no id for "' + cfgKey + '" (needed by node "' + node.name + '"). ' +
            'Run scripts/create-credentials.js first.'
        );
      }
      node.credentials[credType] = { id: c.id, name: c.name };
      attached++;
    }
  }
  return attached;
}

function summarise(wf) {
  const targets = {};
  for (const [from, conn] of Object.entries(wf.connections || {})) {
    (conn.main || []).forEach((port, i) => {
      for (const t of port) {
        targets[from] = targets[from] || [];
        targets[from].push('[' + i + ']->' + t.node);
      }
    });
  }
  const wired = new Set();
  for (const [from, list] of Object.entries(targets)) {
    wired.add(from);
    for (const l of list) wired.add(l.split('->')[1]);
  }
  const orphans = wf.nodes
    .map((n) => n.name)
    .filter((n) => !wired.has(n) && !n.startsWith('Schedule'));
  return { targets, orphans };
}

async function main() {
  const cfg = n8nConfig();
  const verifyOnly = process.argv.includes('--verify');
  const workflow = JSON.parse(fs.readFileSync(WF_JSON, 'utf8'));

  if (verifyOnly) {
    const id = fs.readFileSync(WFID, 'utf8').trim();
    const live = await api(cfg, 'GET', '/api/v1/workflows/' + id);
    console.log('live workflow: ' + live.name + '  (id ' + live.id + ', active=' + live.active + ')');
    console.log('nodes: ' + live.nodes.length);
    const { targets, orphans } = summarise(live);
    console.log('\nconnections:');
    for (const [from, list] of Object.entries(targets)) {
      console.log('  ' + from.padEnd(32) + ' ' + list.join('  '));
    }
    const missingCreds = auditCredentials(live);
    console.log('\nnodes declaring auth but carrying NO credentials: ' + (missingCreds.join(', ') || 'none'));
    console.log('orphan nodes: ' + (orphans.join(', ') || 'none'));
    return;
  }

  const attached = attachCredentials(workflow);
  console.log('attached ' + attached + ' credential reference(s)');

  // The public API rejects unknown top-level properties on create/update, and
  // binaryMode is one of them: `request/body/settings must NOT have additional
  // properties`. The property is real and the instance stores it, but it is
  // settable only through MCP or the UI. Strip it here rather than dropping it
  // from workflow.json, so the export still describes what is deployed.
  const { binaryMode, ...apiSettings } = workflow.settings || { executionOrder: 'v1' };
  const payload = {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: apiSettings,
  };

  let id = null;
  if (fs.existsSync(WFID)) id = fs.readFileSync(WFID, 'utf8').trim();

  if (id) {
    // A full update replaces the nodes array wholesale and silently drops any
    // credentials block that is not present in the payload -- which is exactly
    // why attachCredentials() runs above rather than trusting the live copy.
    const updated = await api(cfg, 'PUT', '/api/v1/workflows/' + id, payload);
    console.log('updated workflow ' + updated.id + ': ' + updated.name);
  } else {
    const created = await api(cfg, 'POST', '/api/v1/workflows', payload);
    fs.writeFileSync(WFID, created.id + '\n');
    console.log('created workflow ' + created.id + ': ' + created.name);
    console.log('wrote .wfid');
    id = created.id;
  }

  const live = await api(cfg, 'GET', '/api/v1/workflows/' + id);
  const { orphans } = summarise(live);
  console.log('verified: ' + live.nodes.length + ' nodes, active=' + live.active);
  console.log('orphan nodes: ' + (orphans.join(', ') || 'none'));

  // Fail loudly rather than leaving a workflow that 401s on its first run.
  const missing = auditCredentials(live);
  if (missing.length) {
    throw new Error(
      'DEPLOYED BUT BROKEN: these nodes declare authentication and carry no ' +
        'credentials, so they will 401 at runtime -- add them to CREDENTIAL_MAP: ' +
        missing.join(', ')
    );
  }
  console.log('credentials: every authenticating node has one');
  console.log('\nopen: ' + cfg.url + '/workflow/' + id);
}

main().catch((err) => {
  console.error('\nFAILED: ' + err.message);
  process.exit(1);
});
