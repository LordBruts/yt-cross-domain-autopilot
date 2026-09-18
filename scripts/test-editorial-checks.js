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
 * Groups, in order:
 *   POSITIVE      — the hallucinated script is caught on every known violation.
 *   NEGATIVE      — a clean script passes with zero blocking. A gate that
 *                   rejects everything is as useless as one that rejects nothing.
 *   SOURCING      — the archive is citable, competitor transcripts never are.
 *   FIRST-PERSON  — "I built" blocked in the body AND the SEO title.
 *   NOT OVER-BROAD— ordinary numbers and ordinary "we" survive.
 *   FORMAT        — length bounds both ways, section count, keyword variety.
 *   GENERIC       — filler openings and marketing cliche.
 *   WIRING        — asserts the connection graph, which every mocked case above
 *                   structurally cannot see. The gate was once fed by the wrong
 *                   node on every run while this suite stayed green.
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
function runChecks(scriptObj, researchPayloadJson, archiveFacts) {
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
    // The archive: the ONLY citable source. Kept a separate mock from the
    // research payload on purpose, because keeping them separate in the node is
    // the entire safety property being tested.
    if (name === 'Postgres · Content Memory') {
      return { first: () => ({ json: { facts: archiveFacts || [], insights: [] } }) };
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
// Derived exactly as LENGTH_BUDGET in build-workflow.js does it, and from the
// same live Config values -- NOT from VIDEO_LENGTH_MINUTES * 130, which is the
// stale formula whose disagreement with the real speech rate is the reason the
// budget was centralised in the first place. If these two derivations ever
// drift apart again, this suite goes green while the gate is wrong.
const MAX_WORDS = Math.round(
  ((Number(CONFIG.MAX_VIDEO_SECONDS) || 180) * (Number(CONFIG.SPEECH_WPM) || 141)) / 60
);
const TARGET = Math.round(MAX_WORDS / 1.1);

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
// The fixture is 336 words. Against the old 520-word target (VIDEO_LENGTH_MINUTES
// 4 x 130) that fell under the 70% floor and fired `too-short`. Against the
// 3-minute budget -- 385 target, 270 floor -- it sits inside the band and must
// NOT fire.
//
// Asserted in the negative rather than deleted. Deleting it was the tempting
// fix and the wrong one: the lower bound would then have had no coverage at
// all and nothing would have gone red. The real lower-bound case is synthetic
// and lives in the FORMAT group, sized from TARGET so it moves with Config.
ok(
  !found.some((v) => v.rule === 'too-short'),
  'the 336-word fixture is NOT too short against the ' + TARGET + '-word target (floor ' +
    Math.round(TARGET * 0.7) + ')'
);

// ---------------------------------------------------------------------------
// A clean script in the CURRENT format: "Did you know?", BODY_SECTIONS
// sections, FOOTAGE_KEYWORDS distinct keywords, near the word target.
// ---------------------------------------------------------------------------
const SECTIONS = Number(CONFIG.BODY_SECTIONS) || 3;
const KW_COUNT = Number(CONFIG.FOOTAGE_KEYWORDS) || 12;

const KEYWORDS = [
  'hospital corridor', 'mri scanner', 'ct scan machine', 'radiographer at work',
  'medical monitor display', 'code on screen', 'server room', 'doctor reviewing scan',
  'x-ray image', 'hospital reception', 'laptop typing closeup', 'data visualization',
  'nurse station', 'medical robot arm', 'ultrasound probe', 'waiting room',
].slice(0, KW_COUNT);

// Sized so the whole script lands near TARGET: too-short and too-long are both
// blocking now, so a filler that ignores the target would fail for the wrong reason.
const body = (n) =>
  ('Here is how you would wire this step by step in n8n, naming the actual nodes and the ' +
   'actual sequence so you can rebuild it yourself. ').repeat(n);

const cleanScript = () => ({
  script: {
    hook:
      'Imaging Technology News reported a new browser-based reading tool cleared by the FDA. ' +
      'Suppose you could see which studies have been waiting longest without opening PACS at all. ',
    body: Array.from({ length: SECTIONS }, (_, i) =>
      'Section ' + (i + 1) + ': An n8n Schedule Trigger fires hourly and an HTTP Request node ' +
      'queries your worklist endpoint. ' + body(3)
    ),
    cta:
      'Radiographers, how does your department handle the worklist backlog today? ' +
      'And AI practitioners, what would you wire differently? Tell me in the comments. ',
  },
  seo: {
    title: 'Automate Your Radiology Worklist With n8n',
    description: 'A build walkthrough for radiographers.',
    tags: ['n8n', 'radiography'],
  },
  sourced_claims: [],
  pexels_search_keywords: KEYWORDS.slice(),
});

// A realistic archive row. The URL is what a sourced_claims entry must match.
const ARCHIVE = [
  {
    title: 'GE HealthCare Expands Breast Imaging Portfolio',
    source: 'Imaging Technology News',
    url: 'http://www.itnonline.com/content/ge-healthcare-expands-breast-imaging-portfolio',
    category: 'radiography',
    key_findings:
      'AI-supported reading powered by QVCAD demonstrated a 33% reduction in reading time ' +
      'and up to 93% sensitivity for lesion detection.',
    takeaway: 'New tooling aims to speed dense-breast screening.',
  },
];

console.log('\n=== NEGATIVE: a clean script must NOT be blocked ===');
const good = runChecks(cleanScript(), JSON.stringify({ research: 'nothing numeric here' }), ARCHIVE);
const goodBlocking = good.result.deterministic_violations.filter((v) => v.severity === 'blocking');
console.log(
  '  ' + good.result.word_count + ' words (target ' + good.result.word_target + '), ' +
  goodBlocking.length + ' blocking, ' +
  (good.result.deterministic_violations.length - goodBlocking.length) + ' advisory'
);
for (const v of goodBlocking) console.log('    unexpected blocking: ' + v.rule + ' -> ' + v.quote);
ok(goodBlocking.length === 0, 'clean script has zero blocking violations');

// ---------------------------------------------------------------------------
// SOURCING. The archive is citable; competitor transcripts never are.
//
// The middle case here is the one that matters most. Two earlier designs
// exempted any figure found in the research payload, and both let "up to 50%"
// through -- because 50% genuinely appears inside a competitor's transcript.
// Laundering another creator's unverified marketing number into this channel's
// voice is worse than inventing one, because it arrives looking sourced.
// ---------------------------------------------------------------------------
console.log('\n=== SOURCING: archive yes, competitor transcripts never ===');

const attributed = cleanScript();
attributed.script.body[0] =
  'Section 1: Imaging Technology News reported a 33% reduction in reading time with that tool. ' + body(3);
attributed.sourced_claims = [
  { claim: 'a 33% reduction in reading time', source_name: 'Imaging Technology News', source_url: ARCHIVE[0].url },
];
const attRes = runChecks(attributed, '{}', ARCHIVE);
ok(
  !attRes.result.deterministic_violations.some((v) => v.rule === 'fabricated-statistic'),
  '33% IS allowed: in the archive, declared, and the outlet named out loud'
);
ok(
  (attRes.result.figures_sourced || []).some((f) => String(f.figure).includes('33')),
  'and it is recorded in figures_sourced with its outlet'
);

const unattributed = cleanScript();
unattributed.script.body[0] = 'Section 1: this cuts reading time by 33%. ' + body(3);
unattributed.sourced_claims = [
  { claim: 'a 33% reduction in reading time', source_name: 'Imaging Technology News', source_url: ARCHIVE[0].url },
];
ok(
  runChecks(unattributed, '{}', ARCHIVE).result.deterministic_violations.some(
    (v) => v.rule === 'fabricated-statistic'
  ),
  'the SAME 33% is blocked when the outlet is not named in the line (declaring is not enough)'
);

const laundered = cleanScript();
laundered.script.body[0] = 'Section 1: this cuts your reporting time by 50%. ' + body(3);
laundered.sourced_claims = [
  { claim: 'cuts reporting time by 50%', source_name: 'Some Creator', source_url: 'https://youtube.com/watch?v=abc' },
];
ok(
  runChecks(
    laundered,
    JSON.stringify({ competitor_transcripts: 'a competitor video says 50% somewhere' }),
    ARCHIVE
  ).result.deterministic_violations.some((v) => v.rule === 'fabricated-statistic'),
  '50% is BLOCKED though it appears in a competitor transcript (transcripts are not evidence)'
);

const notInArchive = cleanScript();
notInArchive.script.body[0] =
  'Section 1: Imaging Technology News reported a 71% reduction in reading time. ' + body(3);
notInArchive.sourced_claims = [
  { claim: 'a 71% reduction', source_name: 'Imaging Technology News', source_url: ARCHIVE[0].url },
];
ok(
  runChecks(notInArchive, '{}', ARCHIVE).result.deterministic_violations.some(
    (v) => v.rule === 'fabricated-statistic'
  ),
  '71% is blocked: real outlet, real URL, but that figure is not in the archive text'
);

// ---------------------------------------------------------------------------
// FIRST-PERSON BUILD. The actual generated title from execution 655 was
// "I Built an AI Radiology Report Writer in n8n (No Code)" -- and it sailed
// through, because the title was only ever checked for length and topic.
// ---------------------------------------------------------------------------
console.log('\n=== FIRST-PERSON: "I built" blocked in body AND title ===');
const built = cleanScript();
built.script.body[0] = 'Section 1: I built an AI report writer that reads the worklist. ' + body(3);
built.seo.title = 'I Built an AI Radiology Report Writer in n8n';
const builtRes = runChecks(built, '{}', ARCHIVE);
const fp = builtRes.result.deterministic_violations.filter((v) => v.rule === 'first-person-build');
ok(fp.some((v) => v.quote.startsWith('body1:')), '"I built" in the body is blocked');
ok(fp.some((v) => v.quote.startsWith('seo.title:')), '"I Built" in the SEO title is blocked');

// ---------------------------------------------------------------------------
// NOT OVER-BROAD: ordinary numbers and ordinary first-person survive.
// ---------------------------------------------------------------------------
console.log('\n=== NOT OVER-BROAD ===');
const nums = cleanScript();
nums.script.body[0] =
  'Section 1: the trigger runs every 4 hours across 5 steps and n8n ships 400 integrations. ' + body(3);
const numsBlocking = runChecks(nums, '{}', ARCHIVE)
  .result.deterministic_violations.filter((v) => v.severity === 'blocking');
for (const v of numsBlocking) console.log('    unexpected: ' + v.rule + ' -> ' + v.quote);
ok(numsBlocking.length === 0, '"4 hours", "5 steps", "400 integrations" are NOT flagged');

const legit = cleanScript();
legit.script.body[0] = 'Section 1: we can wire this together in about ten minutes. ' + body(3);
ok(
  !runChecks(legit, '{}', ARCHIVE).result.deterministic_violations.some(
    (v) => v.rule === 'first-person-build'
  ),
  '"we can wire this" is NOT flagged (the ban is on claimed authorship, not the word "we")'
);

// ---------------------------------------------------------------------------
// FORMAT: length and clip variety are enforced in both directions.
// ---------------------------------------------------------------------------
console.log('\n=== FORMAT: length bounds and keyword variety ===');
const longScript = cleanScript();
longScript.script.body = longScript.script.body.map((b) => b + body(14));
ok(
  runChecks(longScript, '{}', ARCHIVE).result.deterministic_violations.some((v) => v.rule === 'too-long'),
  'an overlong script is blocked (1606 words against a 1040 target shipped once)'
);

// The lower bound, sized from TARGET so it tracks Config instead of hardcoding
// a word count that silently stops testing anything when the format changes.
// This is the coverage the fixture used to provide before the 3-minute budget
// moved the floor underneath it.
const shortScript = cleanScript();
shortScript.script.body = shortScript.script.body.map(() => 'Far too brief.');
shortScript.script.hook = 'A short hook.';
shortScript.script.cta = 'Radiographers and AI practitioners, what would you automate?';
{
  const res = runChecks(shortScript, '{}', ARCHIVE).result;
  ok(
    res.deterministic_violations.some((v) => v.rule === 'too-short'),
    'a script under the ' + Math.round(TARGET * 0.7) + '-word floor is blocked (got ' +
      res.word_count + ' words)'
  );
}

// The ceiling is maxWords directly, not a percentage of target. A script above
// MAX_WORDS is more speech than MAX_VIDEO_SECONDS can hold at SPEECH_WPM, which
// is the whole point of the 3-minute format. Under the old `target * 1.35` rule
// this length passed.
// A BOUNDARY case, deliberately. It must land above MAX_WORDS (423) but below
// the old `target * 1.35` bound (520), because a 1200-word script proves
// nothing -- the previous rule caught that too. Only a script in the gap
// between the two rules can tell them apart, and this one fails if the ceiling
// ever silently reverts to a percentage of target.
{
  const overCeiling = cleanScript();
  const cleanWords = runChecks(cleanScript(), '{}', ARCHIVE).result.word_count;
  const needed = MAX_WORDS - cleanWords + 12;
  ok(needed > 0, 'boundary case is constructible (clean ' + cleanWords + ' < ceiling ' + MAX_WORDS + ')');
  const filler = ' padding'.repeat(needed);
  overCeiling.script.body = overCeiling.script.body.map((b, i) => (i === 0 ? b + filler : b));

  const res = runChecks(overCeiling, '{}', ARCHIVE).result;
  ok(
    res.word_count > MAX_WORDS && res.word_count < Math.round(TARGET * 1.35),
    'boundary script sits between the new ceiling and the old one (' + res.word_count +
      ' is >' + MAX_WORDS + ' and <' + Math.round(TARGET * 1.35) + ')'
  );
  ok(
    res.deterministic_violations.some((v) => v.rule === 'too-long'),
    'a script just over the ' + MAX_WORDS + '-word ceiling is blocked (got ' + res.word_count +
      ' words; the old target*1.35 rule would have passed it)'
  );
}

const fewKw = cleanScript();
fewKw.pexels_search_keywords = KEYWORDS.slice(0, 5);
ok(
  runChecks(fewKw, '{}', ARCHIVE).result.deterministic_violations.some((v) => v.rule === 'keywords'),
  'only 5 keywords is blocked (too few clips is what made the video repeat)'
);

const dupKw = cleanScript();
dupKw.pexels_search_keywords = KEYWORDS.slice(0, KW_COUNT - 1).concat([KEYWORDS[0].toUpperCase()]);
ok(
  runChecks(dupKw, '{}', ARCHIVE).result.deterministic_violations.some(
    (v) => v.rule === 'keywords-duplicate'
  ),
  'a case-differing duplicate keyword is blocked (it fetches the same clips)'
);

const wrongSections = cleanScript();
wrongSections.script.body = wrongSections.script.body.concat(['Section extra: ' + body(3)]);
ok(
  runChecks(wrongSections, '{}', ARCHIVE).result.deterministic_violations.some(
    (v) => v.rule === 'structure'
  ),
  SECTIONS + 1 + ' body sections is blocked (Config says exactly ' + SECTIONS + ')'
);

// ---------------------------------------------------------------------------
// GENERIC: correction #8. A clean-sounding script that opens like every other
// AI video has still failed.
// ---------------------------------------------------------------------------
console.log('\n=== GENERIC: filler openings are blocked ===');
const generic = cleanScript();
generic.script.hook = "In today's video, let's dive in and see how AI is a total game-changer. " + body(2);
const genRes = runChecks(generic, '{}', ARCHIVE).result.deterministic_violations;
ok(genRes.some((v) => v.rule === 'generic-filler'), '"in today\'s video" / "let\'s dive in" blocked');
ok(genRes.some((v) => v.rule === 'hype-cliche'), '"game-changer" flagged');

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

// ---------------------------------------------------------------------------
// WIRING: the render result is read from the node that runs ONCE
// ---------------------------------------------------------------------------
// Worker · Render Status runs once per 20s poll iteration. Reading it with
// .first() returns the FIRST poll -- {status: "running"}, before any of the
// completion fields exist -- so every field comes back undefined on every run
// and it reads as "the worker never reports this". Render Done sits on the
// Switch's 'done' output, runs exactly once, and is the only correct source.
console.log('\n=== WIRING: render results come from Render Done, not a poll ===');
{
  const rd = workflow.nodes.find((x) => x.name === 'Render Done');
  ok(!!rd, 'Render Done exists');

  const rdCode = (rd && rd.parameters.jsCode) || '';
  // $input is CORRECT here: the polled job dict is the item flowing through,
  // and the Switch passes it straight along. This is the documented exception
  // to the "Code nodes downstream of an HTTP fetch must read by name" rule.
  ok(/\$input\b/.test(rdCode), 'Render Done reads $input (the job dict IS the item)');

  ok(
    (workflow.connections['Switch · Render State'].main[0] || []).some(
      (c) => c.node === 'Render Done'
    ),
    "Render Done is on the Switch's 'done' output (so it runs once, at completion)"
  );
  ok(
    (workflow.connections['Render Done'].main[0] || []).some(
      (c) => c.node === 'Worker · Download Video'
    ),
    'Render Done feeds Worker · Download Video (it is in the spine, not a dead end)'
  );

  const fl = workflow.nodes.find((x) => x.name === 'Final Log');
  const flCode = (fl && fl.parameters.jsCode) || '';
  ok(flCode.includes("$('Render Done')"), "Final Log reads $('Render Done')");
  ok(
    !/\$\('Worker · Render Status'\)/.test(flCode),
    'Final Log does NOT read $(\'Worker · Render Status\') (that returns the first poll)'
  );

  // The advisory ceiling is only worth having if the overrun surfaces.
  for (const field of ['over_length', 'measured_wpm', 'voiceover_seconds']) {
    ok(rdCode.includes(field), 'Render Done carries ' + field);
    ok(flCode.includes(field), 'Final Log reports ' + field);
  }
}

// The worker must be told the ceiling, or it falls back to its own env default
// and the Config knob silently controls nothing.
{
  const rv = workflow.nodes.find((x) => x.name === 'Worker · Render Video');
  ok(
    (rv.parameters.jsonBody || '').includes('max_seconds'),
    'Worker · Render Video sends max_seconds to the worker'
  );
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
