#!/usr/bin/env node
/**
 * Regression test for the editorial gate's deterministic layer.
 *
 *   node scripts/test-editorial-checks.js
 *
 * Extracts the jsCode from the GENERATED workflow.json and runs it against
 * fixtures — so it tests the code that actually deploys, not a copy of it that
 * can drift. The fixture is the real script from execution 654, copied out of
 * the execution payload rather than hand-written: a fixture written to the
 * shape you expect agrees with buggy code and hides the bug.
 *
 * Two cases, and both matter:
 *   POSITIVE — the hallucinated script must be caught on every known violation.
 *   NEGATIVE — a clean script must pass with zero blocking violations. A gate
 *              that rejects everything is as useless as one that rejects nothing.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const workflow = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'));

const checksNode = workflow.nodes.find((n) => n.name === 'Editorial Checks');
if (!checksNode) {
  console.error('FAIL: no "Editorial Checks" node in workflow.json — run build-workflow.js first');
  process.exit(1);
}

const CONFIG = Object.fromEntries(
  workflow.nodes
    .find((n) => n.name === 'Config')
    .parameters.assignments.assignments.map((a) => [a.name, a.value])
);

/**
 * Runs the real node code with n8n's globals mocked.
 *
 * $input deliberately THROWS. The checks node sits downstream of an HTTP Request
 * node, which replaces the item with its response body, so $input there holds
 * the verifier prompt text and no script at all. Reading it shipped once and was
 * invisible: round 1 of the gate saw 0 words on every run and forced a needless
 * revision, while the execution still reported success. A permissive mock would
 * have agreed with that code and passed.
 */
function runChecks(scriptObj, researchPayloadJson) {
  const logs = [];
  const $input = {
    first: () => {
      throw new Error(
        'Editorial Checks read $input. It is downstream of an HTTP Request node, so $input ' +
          "is the fetch response, not the script. Read $('Script Ready').first().json."
      );
    },
  };
  const $ = (name) => {
    if (name === 'Config') return { first: () => ({ json: CONFIG }) };
    if (name === 'Script Ready' || name === 'Revision Parsed') {
      return { first: () => ({ json: scriptObj }) };
    }
    if (name === 'Prepare Research Payload') {
      return { first: () => ({ json: { payload_json: researchPayloadJson || '' } }) };
    }
    throw new Error('unexpected node reference in checks: ' + name);
  };
  const console_ = { log: (m) => logs.push(String(m)) };
  const fn = new Function('$input', '$', 'console', checksNode.parameters.jsCode);
  const out = fn($input, $, console_);
  return { result: out[0].json, logs };
}

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg);
  if (!cond) failures++;
};

// ---------------------------------------------------------------------------
// POSITIVE: the real hallucinated script
// ---------------------------------------------------------------------------
console.log('\n=== POSITIVE: fixtures/hallucinated-script.json (real execution 654) ===');
const fixture = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'fixtures', 'hallucinated-script.json'), 'utf8')
);

const bad = runChecks(
  {
    script: fixture.script,
    seo: fixture.seo,
    pexels_search_keywords: fixture.pexels_search_keywords,
  },
  fixture.research_payload_json
);

const found = bad.result.deterministic_violations;
console.log('  ' + found.length + ' violations, ' + bad.result.deterministic_blocking + ' blocking\n');

// Assert on (rule, section, captured token). The detectors capture the claim
// itself rather than its whole sentence, so matching the full human-readable
// phrase would fail for the right reason and look like the wrong one.
for (const known of fixture._known_violations) {
  const hit = found.find(
    (v) =>
      v.rule === known.rule &&
      v.quote.startsWith(known.where + ':') &&
      v.quote.toLowerCase().includes(known.must_contain.toLowerCase())
  );
  ok(!!hit, known.rule + ' @' + known.where + ' caught "' + known.must_contain + '"  (' + known.phrase.slice(0, 52) + '…)');
}
ok(bad.result.deterministic_blocking >= 5, 'at least 5 blocking violations (got ' + bad.result.deterministic_blocking + ')');
ok(
  found.some((v) => v.rule === 'too-short'),
  'the 336-word script is flagged as too short'
);

// ---------------------------------------------------------------------------
// NEGATIVE: a clean script must pass cleanly
// ---------------------------------------------------------------------------
console.log('\n=== NEGATIVE: a clean script must NOT be blocked ===');
const filler = (n) =>
  ('Here is how you would wire this step by step in n8n, naming the actual nodes and the actual ' +
    'sequence so you can rebuild it yourself without guessing anything. ').repeat(n);

const clean = {
  script: {
    hook:
      'You finish a shift and the worklist still is not clear. ' +
      'Suppose you could see which studies have been waiting longest without opening PACS at all. ' +
      filler(3),
    body: [
      'Section one: An n8n Schedule Trigger fires every hour and an HTTP Request node queries your worklist endpoint. ' + filler(12),
      'Section two: A Code node groups the studies by modality and flags anything older than your threshold. ' + filler(12),
      'Section three: A Switch node routes urgent items down one branch and routine items down another. ' + filler(12),
      'Section four: A Telegram node posts the flagged list to the department channel each morning. ' + filler(12),
      'Section five: Suppose your department wanted this weekly instead. You would change one field on the trigger. ' + filler(12),
    ],
    cta:
      'Radiographers, how does your department handle the worklist backlog today? ' +
      'And AI practitioners, what would you wire differently? Tell me in the comments. ' + filler(2),
  },
  seo: {
    title: 'Automate Your Radiology Worklist With n8n',
    description: 'A build walkthrough for radiographers.',
    tags: ['n8n', 'radiography'],
  },
  pexels_search_keywords: ['hospital corridor', 'mri scanner', 'computer screen', 'ct scan', 'nurse station'],
};

const good = runChecks(clean, JSON.stringify({ research: 'nothing numeric here' }));
const goodBlocking = good.result.deterministic_violations.filter((v) => v.severity === 'blocking');
console.log(
  '  ' + good.result.word_count + ' words, ' +
  goodBlocking.length + ' blocking, ' +
  (good.result.deterministic_violations.length - goodBlocking.length) + ' advisory'
);
for (const v of goodBlocking) console.log('    unexpected blocking: ' + v.rule + ' -> ' + v.quote);
ok(goodBlocking.length === 0, 'clean script has zero blocking violations');

// ---------------------------------------------------------------------------
// NO EXEMPTION: a competitor transcript is not a citable source
//
// This case exists because two earlier designs failed here. Exempting figures
// that appear in the research payload let "up to 50%" through, since 50% really
// does appear -- in a competitor's transcript. Their unverified marketing claim
// must not become this channel's assertion.
// ---------------------------------------------------------------------------
console.log('\n=== NO EXEMPTION: a percentage is blocked even if the corpus contains it ===');
const pct = JSON.parse(JSON.stringify(clean));
pct.script.body[0] = 'Section one: this cuts your reporting time by 42%. ' + filler(12);

const evenIfSourced = runChecks(pct, JSON.stringify({ research: 'a competitor video says 42% somewhere' }));
ok(
  evenIfSourced.result.deterministic_violations.some((v) => v.rule === 'fabricated-statistic'),
  '42% is blocked even though "42%" appears in the corpus (transcripts are not evidence)'
);

// Ordinary, non-claim-shaped numbers must survive, or the rule is too broad to live with.
console.log('\n=== NOT OVER-BROAD: ordinary numbers are untouched ===');
const nums = JSON.parse(JSON.stringify(clean));
nums.script.body[0] =
  'Section one: the trigger runs every 4 hours across 5 steps and n8n ships 400 integrations. ' + filler(12);

const numsRes = runChecks(nums, '{}');
const numsBlocking = numsRes.result.deterministic_violations.filter((v) => v.severity === 'blocking');
for (const v of numsBlocking) console.log('    unexpected: ' + v.rule + ' -> ' + v.quote);
ok(numsBlocking.length === 0, '"4 hours", "5 steps", "400 integrations" are NOT flagged');

// ---------------------------------------------------------------------------
// WIRING: the class of defect the cases above structurally cannot catch.
//
// Everything before this mocks the node's inputs, so it tests the code in
// isolation and would pass just as happily if the node were wired to the wrong
// upstream neighbour entirely. That is exactly what happened: round 1 of the
// gate was fed by an HTTP Request node, saw no script on any run, and this
// suite stayed green throughout.
// ---------------------------------------------------------------------------
console.log('\n=== WIRING: each gate round reads the right script ===');

const feedersOf = (target) =>
  Object.entries(workflow.connections)
    .filter(([, c]) => (c.main || []).some((p) => p.some((x) => x.node === target)))
    .map(([from]) => from);

for (const [checks, source] of [
  ['Editorial Checks', 'Script Ready'],
  ['Editorial Checks (Round 2)', 'Revision Parsed'],
]) {
  const n = workflow.nodes.find((x) => x.name === checks);
  const code = (n && n.parameters.jsCode) || '';
  ok(!!n, checks + ' exists');
  ok(!/\$input\b/.test(code), checks + ' does not read $input');
  ok(code.includes("$('" + source + "')"), checks + " reads $('" + source + "')");
  ok(
    workflow.nodes.some((x) => x.name === source),
    source + ' exists to be read'
  );
}

// The judge must see the same script the checks did, or it adjudicates nothing.
for (const [checks, verifier] of [
  ['Editorial Checks', 'Editorial Verifier'],
  ['Editorial Checks (Round 2)', 'Editorial Verifier (Round 2)'],
]) {
  ok(
    feedersOf(verifier).includes(checks),
    verifier + ' is fed by ' + checks + ' (so judge_payload_json carries the script)'
  );
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
