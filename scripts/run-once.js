#!/usr/bin/env node
/**
 * Triggers one full run of a schedule-only workflow, headlessly.
 *
 * n8n's public REST API has no "execute workflow" endpoint, and
 * `n8n_test_workflow` (MCP) only drives webhook/form/chat triggers. So this
 * temporarily grafts a Webhook trigger onto the live workflow, activates it,
 * POSTs to it, watches the execution, and then puts everything back exactly as
 * it was — webhook removed, workflow deactivated.
 *
 *   node scripts/run-once.js            # run and watch
 *   node scripts/run-once.js --restore  # undo a graft left behind by a crash
 *
 * The live workflow is read first and written back whole, so every node keeps
 * the `credentials` block it already had. A full update drops any credential
 * not present in the payload, which is why this never builds nodes from
 * workflow.json (that export deliberately carries none).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MCP_JSON = path.join(ROOT, '..', '..', '.mcp.json');
const WFID = path.join(ROOT, '.wfid');

const TRIGGER_NAME = 'TEMP · Manual Run Trigger';
const WEBHOOK_PATH = 'yt-autopilot-run-once';
const ENTRY_NODE = 'Config';

function cfg() {
  if (process.env.N8N_API_URL && process.env.N8N_API_KEY) {
    return { url: process.env.N8N_API_URL, key: process.env.N8N_API_KEY };
  }
  const mcp = JSON.parse(fs.readFileSync(MCP_JSON, 'utf8'));
  const e = mcp.mcpServers['n8n-local'].env;
  return { url: e.N8N_API_URL, key: e.N8N_API_KEY };
}

const C = cfg();
const ID = fs.readFileSync(WFID, 'utf8').trim();

async function api(method, route, body) {
  const res = await fetch(C.url + route, {
    method,
    headers: { 'X-N8N-API-KEY': C.key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(method + ' ' + route + ' -> ' + res.status + ': ' + text.slice(0, 500));
  }
  return text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function payload(wf) {
  return {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: wf.settings || { executionOrder: 'v1' },
  };
}

function stripGraft(wf) {
  wf.nodes = wf.nodes.filter((n) => n.name !== TRIGGER_NAME);
  delete wf.connections[TRIGGER_NAME];
  return wf;
}

async function restore() {
  try {
    await api('POST', '/api/v1/workflows/' + ID + '/deactivate');
    console.log('deactivated');
  } catch (e) {
    console.log('deactivate skipped: ' + e.message.slice(0, 120));
  }
  const wf = await api('GET', '/api/v1/workflows/' + ID);
  if (wf.nodes.some((n) => n.name === TRIGGER_NAME)) {
    await api('PUT', '/api/v1/workflows/' + ID, payload(stripGraft(wf)));
    console.log('removed temporary trigger');
  } else {
    console.log('no temporary trigger present');
  }
  const after = await api('GET', '/api/v1/workflows/' + ID);
  console.log('final state: ' + after.nodes.length + ' nodes, active=' + after.active);
}

async function main() {
  if (process.argv.includes('--restore')) return restore();

  const original = await api('GET', '/api/v1/workflows/' + ID);
  console.log('workflow: ' + original.name);
  console.log('  nodes=' + original.nodes.length + ' active=' + original.active);

  const grafted = stripGraft(JSON.parse(JSON.stringify(original)));
  grafted.nodes.push({
    id: 'temp-run-trigger',
    name: TRIGGER_NAME,
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2.1,
    position: [-680, 560],
    parameters: {
      httpMethod: 'POST',
      path: WEBHOOK_PATH,
      responseMode: 'onReceived',
      options: {},
    },
    webhookId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });
  grafted.connections[TRIGGER_NAME] = {
    main: [[{ node: ENTRY_NODE, type: 'main', index: 0 }]],
  };

  await api('PUT', '/api/v1/workflows/' + ID, payload(grafted));
  console.log('grafted temporary webhook trigger -> ' + ENTRY_NODE);

  await api('POST', '/api/v1/workflows/' + ID + '/activate');
  console.log('activated (temporarily)');
  await sleep(3000);

  const before = await api('GET', '/api/v1/executions?workflowId=' + ID + '&limit=1');
  const priorMax = before.data.length ? Math.max(...before.data.map((e) => +e.id)) : 0;

  const hookUrl = C.url + '/webhook/' + WEBHOOK_PATH;
  console.log('POST ' + hookUrl);
  const res = await fetch(hookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  console.log('  webhook responded ' + res.status);

  console.log('\nwatching execution (this takes ~20 minutes)...');
  let execId = null;
  let last = '';
  const deadline = Date.now() + 50 * 60 * 1000;

  while (Date.now() < deadline) {
    await sleep(15000);
    // Two traps in this endpoint:
    //  * The default listing EXCLUDES running executions, so a run in progress
    //    is invisible unless you ask for status=running explicitly. Without
    //    this the watcher sees nothing at all until the run finishes.
    //  * Results are not ordered by recency, so take the highest id rather
    //    than trusting data[0].
    const [def, running] = await Promise.all([
      api('GET', '/api/v1/executions?workflowId=' + ID + '&limit=20'),
      api('GET', '/api/v1/executions?workflowId=' + ID + '&status=running&limit=20').catch(
        () => ({ data: [] })
      ),
    ]);
    const list = { data: [...def.data, ...running.data] };
    const mine = list.data.filter((e) => +e.id > priorMax);
    if (!mine.length) {
      process.stdout.write('.');
      continue;
    }
    const latest = mine.reduce((a, b) => (+a.id > +b.id ? a : b));
    execId = latest.id;
    const status = latest.status;
    if (status !== last) {
      console.log('\n  execution ' + execId + ': ' + status);
      last = status;
    } else {
      process.stdout.write('.');
    }
    if (['success', 'error', 'crashed', 'canceled'].includes(status)) break;
  }

  console.log('\n--- restoring ---');
  await restore();

  if (execId) {
    console.log('\nexecution ' + execId + ' -> ' + C.url + '/workflow/' + ID + '/executions/' + execId);
  }
}

main().catch(async (err) => {
  console.error('\nFAILED: ' + err.message);
  console.error('attempting restore...');
  await restore().catch((e) => console.error('restore failed: ' + e.message));
  process.exit(1);
});
