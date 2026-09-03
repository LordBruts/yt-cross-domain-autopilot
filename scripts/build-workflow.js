#!/usr/bin/env node
/**
 * Generates workflow.json for the yt-cross-domain-autopilot pipeline.
 *
 * Edit THIS file, not workflow.json.
 *
 * Every node typeVersion below was read off the live n8n 2.32.6 container
 * (schedule 1.3, set 3.5, code 2, httpRequest 4.4, if 2.3, switch 3.4,
 * wait 1.1, youTube 1), not from memory.
 *
 * Guard: refuses to write if any cross-node `.item.json` reference sneaks in.
 * Item counts change several times in this pipeline (1 -> 5 -> 50 -> 1 -> 5 -> 1),
 * and `$('Node').item` breaks wherever that happens without pairedItem.
 * Every referenced node here holds exactly one item, so `.first()` is correct.
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'workflow.json');

// No credentials blocks are emitted here. Credential ids are instance-specific,
// so scripts/deploy.js attaches them from deploy.config.json at deploy time and
// the committed export stays portable. A guard at the bottom enforces this.

let idc = 0;
const uid = () => 'a' + String(++idc).padStart(3, '0');

const nodes = [];
const connections = {};

function node(name, type, typeVersion, position, parameters, extra = {}) {
  nodes.push({ id: uid(), name, type, typeVersion, position, parameters, ...extra });
  return name;
}

function connect(from, to, fromIndex = 0) {
  connections[from] = connections[from] || { main: [] };
  while (connections[from].main.length <= fromIndex) connections[from].main.push([]);
  connections[from].main[fromIndex].push({ node: to, type: 'main', index: 0 });
}

// filter-type condition helpers (If v2.3 / Switch v3.4 share this shape)
const filterOpts = {
  caseSensitive: true,
  leftValue: '',
  typeValidation: 'strict',
  version: 2,
};

const isTrue = (left) => ({
  options: filterOpts,
  conditions: [
    {
      id: uid(),
      leftValue: left,
      rightValue: '',
      operator: { type: 'boolean', operation: 'true', singleValue: true },
    },
  ],
  combinator: 'and',
});

const strEquals = (left, right) => ({
  options: filterOpts,
  conditions: [
    {
      id: uid(),
      leftValue: left,
      rightValue: right,
      operator: { type: 'string', operation: 'equals' },
    },
  ],
  combinator: 'and',
});

const WORKER = "={{ $('Config').first().json.MEDIA_WORKER_URL }}";

// ---------------------------------------------------------------------------
// 1. Schedule  (spec node 1)
// ---------------------------------------------------------------------------
node('Schedule · Every 3 Days 09:00', 'n8n-nodes-base.scheduleTrigger', 1.3, [-460, 300], {
  rule: {
    interval: [{ field: 'days', daysInterval: 3, triggerAtHour: 9, triggerAtMinute: 0 }],
  },
});

// ---------------------------------------------------------------------------
// 2. Config  (spec: channel config + niche context, as static workflow values)
//    Non-secret only. Every secret lives in the n8n credential store.
// ---------------------------------------------------------------------------
const cfgFields = [
  ['CHANNEL_AI_1', 'UC2ojq-nuP8ceeHqiroeKhBA', 'string'],
  ['CHANNEL_AI_1_DOMAIN', 'AI automation', 'string'],
  ['CHANNEL_AI_2', 'UCui4jxDaMb53Gdh-AZUTPAg', 'string'],
  ['CHANNEL_AI_2_DOMAIN', 'AI automation', 'string'],
  ['CHANNEL_AI_3', 'UCMwVTLZIRRUyyVrkjDpn4pA', 'string'],
  ['CHANNEL_AI_3_DOMAIN', 'AI automation', 'string'],
  ['CHANNEL_RADIOLOGY_1', 'UCU84jkgqGncjlV5YTKIFMow', 'string'],
  ['CHANNEL_RADIOLOGY_1_DOMAIN', 'radiology/healthcare', 'string'],
  ['CHANNEL_RADIOLOGY_2', 'UC9Zp0PrjNbs4nwQNdkquRug', 'string'],
  ['CHANNEL_RADIOLOGY_2_DOMAIN', 'radiology/healthcare', 'string'],
  [
    'NICHE_CONTEXT',
    'My channel targets radiographers and healthcare professionals who want to use AI ' +
      'and automation tools to work smarter. Every video MUST connect an AI or automation ' +
      'concept to a specific radiology or healthcare use case. I am a radiographer AND an ' +
      'AI automation engineer — my credibility is the bridge between both worlds. Never ' +
      'produce a generic AI tutorial. Never produce a generic radiology lesson. Always ' +
      'produce the intersection of the two.',
    'string',
  ],
  [
    'TARGET_AUDIENCE',
    'radiographers, imaging technologists, healthcare professionals curious about AI, ' +
      'and AI practitioners interested in healthcare applications',
    'string',
  ],
  // 4 minutes at 130 wpm = ~520 words. Was 8, which produced a 10.9-minute
  // voiceover and dominated the run: render and upload together were 29 of the
  // 36 minutes an execution took.
  ['VIDEO_LENGTH_MINUTES', 4, 'number'],
  // Body sections scale with length. Was hardcoded at 5 in two places.
  ['BODY_SECTIONS', 4, 'number'],
  // One shot every SHOT_SECONDS. The worker used to divide the whole voiceover
  // by the clip count, which gave 65-second slots and looped each clip 3-6
  // times inside its own slot -- the repetition problem. FOOTAGE_KEYWORDS x
  // FOOTAGE_PER_KEYWORD is the size of the clip pool it draws from.
  ['SHOT_SECONDS', 4, 'number'],
  ['FOOTAGE_KEYWORDS', 12, 'number'],
  ['FOOTAGE_PER_KEYWORD', 4, 'number'],
  ['MEDIA_WORKER_URL', 'http://host.docker.internal:8099', 'string'],
  // WRITER_MODEL and JUDGE_MODEL must stay on DIFFERENT vendors. This is the
  // gate's central property, not a preference: a judge sharing the writer's
  // blind spots rubber-stamps its failure modes. On the first live run
  // gpt-4o-mini invented a "30% decrease at our facility" without hesitation,
  // so a model of that family is not fit to police its own output. Changing
  // either of these to match the other silently disables the third layer while
  // every test still passes.
  //
  // RESEARCH_MODEL may share a vendor with either -- it only summarises
  // competitor content and asserts nothing that reaches the video.
  ['RESEARCH_MODEL', 'openai/gpt-5.6-luna', 'string'],
  ['WRITER_MODEL', 'anthropic/claude-sonnet-4.5', 'string'],
  ['JUDGE_MODEL', 'openai/gpt-5.6-luna', 'string'],
  ['PRIVACY_STATUS', 'private', 'string'],
];

node('Config', 'n8n-nodes-base.set', 3.5, [-240, 300], {
  assignments: {
    assignments: cfgFields.map(([name, value, type]) => ({
      id: uid(),
      name,
      value,
      type,
    })),
  },
  options: {},
});

// ---------------------------------------------------------------------------
// 3. Build channel list -> 5 items  (spec node 2, the "loop")
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Grounding: the sibling ai-radiography-content-engine archive.
//
// This is the pipeline's ONLY citable source. Competitor YouTube transcripts
// are not evidence and never become evidence -- Editorial Checks keeps the two
// corpora in separate variables for exactly that reason.
//
// Query shape matters in three ways, each of them a trap this repo has already
// hit:
//   * It returns EXACTLY ONE ROW, always. A Postgres node that returns zero
//     rows stops the branch dead, so an empty archive would read as silence
//     rather than as "nothing found". The two json_agg subqueries with
//     COALESCE guarantee the row exists even when both are empty.
//   * It is BALANCED by category (8 AI + 8 radiography). Ranking the whole
//     pool by value_score returns 30 AI to 10 radiography, because the AI
//     feeds are denser -- and a cross-domain channel cannot be written from a
//     one-sided pile.
//   * It caps each source at 3 rows. Without that, OpenAI (115 rows) and
//     Radiology Business (308) crowd everything else out and the video ends up
//     sourced from two outlets.
//
// `key_findings NOT ILIKE '%no concrete findings%'` uses the archive's own
// honesty about empty articles to select only rows worth citing. Measured on
// the live database: 16 facts, 6 insights, 6 distinct sources, ~5k tokens.
const MEMORY_SQL = `WITH pool AS (
  SELECT a.title, a.source, a.url, a.category, a.value_score,
         a.published_at::date          AS published,
         left(s.key_findings, 700)     AS key_findings,
         left(s.takeaway, 300)         AS takeaway,
         row_number() OVER (PARTITION BY a.category, a.source
                            ORDER BY a.value_score DESC NULLS LAST,
                                     a.published_at DESC) AS rn_src
  FROM summaries s JOIN articles a ON a.id = s.article_id
  WHERE s.status = 'ok' AND a.reject_reason = ''
    AND s.key_findings NOT ILIKE '%no concrete findings%'
    AND length(s.key_findings) > 120
    AND a.published_at > now() - interval '60 days'
), capped AS (
  SELECT *, row_number() OVER (PARTITION BY category
                               ORDER BY value_score DESC NULLS LAST,
                                        published DESC) AS rn
  FROM pool WHERE rn_src <= 3
)
SELECT
  (SELECT COALESCE(json_agg(x ORDER BY x.category, x.rn), '[]'::json)
   FROM (SELECT title, source, url, category, published, key_findings, takeaway, rn
         FROM capped WHERE rn <= 8) x) AS facts,
  (SELECT COALESCE(json_agg(y), '[]'::json)
   FROM (SELECT r.finished_at::date AS day, left(r.insight, 900) AS insight
         FROM runs r WHERE r.insufficient = false
         ORDER BY r.finished_at DESC LIMIT 6) y) AS insights;`;

node(
  'Postgres · Content Memory',
  'n8n-nodes-base.postgres',
  2.6,
  [-240, 300],
  { operation: 'executeQuery', query: MEMORY_SQL, options: {} },
  // The archive is grounding, not a hard dependency. If Postgres is down the
  // run should still produce a video -- one that simply cannot cite anything,
  // which the gate already handles by blocking every unattributed figure.
  { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 2 }
);

node('Build Channel List', 'n8n-nodes-base.code', 2, [-20, 300], {
  jsCode: `// Emits one item per research channel, carrying its domain label.
// The domain travels with every video from here to the research prompt.
const cfg = $('Config').first().json;
const keys = [
  'CHANNEL_AI_1', 'CHANNEL_AI_2', 'CHANNEL_AI_3',
  'CHANNEL_RADIOLOGY_1', 'CHANNEL_RADIOLOGY_2',
];

const channels = [];
for (const key of keys) {
  const id = (cfg[key] || '').trim();
  if (!id) continue;
  channels.push({ key, id, domain: cfg[key + '_DOMAIN'] || 'unknown' });
}

if (channels.length === 0) {
  throw new Error('Config has no channel IDs set.');
}

return channels.map((c) => ({ json: c, pairedItem: { item: 0 } }));`,
});

// ---------------------------------------------------------------------------
// 4. YouTube search x5  (spec node 2)
// ---------------------------------------------------------------------------
node(
  'YT · Search Channel',
  'n8n-nodes-base.httpRequest',
  4.4,
  [200, 300],
  {
    url: 'https://www.googleapis.com/youtube/v3/search',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpQueryAuth',
    sendQuery: true,
    queryParameters: {
      parameters: [
        { name: 'channelId', value: '={{ $json.id }}' },
        { name: 'part', value: 'snippet' },
        { name: 'order', value: 'viewCount' },
        { name: 'type', value: 'video' },
        { name: 'maxResults', value: '10' },
      ],
    },
    options: { timeout: 30000 },
  },
  {

    // One dead channel must not kill the run; the next Code node rebuilds
    // items from scratch, which also drops the error flag this sets.
    onError: 'continueRegularOutput',
    retryOnFail: true,
    maxTries: 2,
  }
);

// ---------------------------------------------------------------------------
// 5. Flatten + tag domain  (spec node 2 output: top_videos[])
// ---------------------------------------------------------------------------
node('Flatten & Tag Domain', 'n8n-nodes-base.code', 2, [420, 300], {
  jsCode: `// Collapses 5 search responses into one item holding up to 50 videos.
// Domain is resolved by channelId rather than by input position, so a failed
// or reordered channel call cannot mislabel anyone.
const cfg = $('Config').first().json;
const keys = [
  'CHANNEL_AI_1', 'CHANNEL_AI_2', 'CHANNEL_AI_3',
  'CHANNEL_RADIOLOGY_1', 'CHANNEL_RADIOLOGY_2',
];

const domainByChannel = {};
for (const key of keys) {
  if (cfg[key]) domainByChannel[cfg[key]] = cfg[key + '_DOMAIN'] || 'unknown';
}

const videos = [];
const seen = new Set();
const errors = [];

for (const item of $input.all()) {
  const body = item.json || {};
  if (body.error) {
    errors.push(body.error.message || 'unknown search error');
    continue;
  }
  for (const r of body.items || []) {
    const videoId = r?.id?.videoId;
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    const channelId = r.snippet?.channelId || '';
    videos.push({
      video_id: videoId,
      title: r.snippet?.title || '',
      description: r.snippet?.description || '',
      published_at: r.snippet?.publishedAt || '',
      channel_id: channelId,
      channel_title: r.snippet?.channelTitle || '',
      domain: domainByChannel[channelId] || 'unknown',
    });
  }
}

if (videos.length === 0) {
  throw new Error(
    'No videos returned from any channel search. Errors: ' +
      (errors.join(' | ') || 'none reported')
  );
}

return [{
  json: {
    videos,
    video_ids: videos.map((v) => v.video_id),
    channels_ok: $input.all().length - errors.length,
    search_errors: errors,
  },
  pairedItem: { item: 0 },
}];`,
});

// ---------------------------------------------------------------------------
// 6. ONE batched videos.list  (spec node 3, corrected)
//    search.list returns no viewCount, so ranking has to happen after this.
//    50 ids in a single call costs 1 quota unit instead of 10.
// ---------------------------------------------------------------------------
node(
  'YT · Batch Statistics',
  'n8n-nodes-base.httpRequest',
  4.4,
  [640, 300],
  {
    url: 'https://www.googleapis.com/youtube/v3/videos',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpQueryAuth',
    sendQuery: true,
    queryParameters: {
      parameters: [
        { name: 'id', value: '={{ $json.video_ids.slice(0, 50).join(",") }}' },
        { name: 'part', value: 'statistics,snippet' },
        { name: 'maxResults', value: '50' },
      ],
    },
    options: { timeout: 30000 },
  },
  { retryOnFail: true, maxTries: 2 }
);

// ---------------------------------------------------------------------------
// 7. Rank + domain balance  (spec node 3 output: enriched_top_videos[])
// ---------------------------------------------------------------------------
node('Rank & Balance Domains', 'n8n-nodes-base.code', 2, [860, 300], {
  jsCode: `const AI = 'AI automation';
const RAD = 'radiology/healthcare';

const prev = $('Flatten & Tag Domain').first().json;
const stats = $input.first().json.items || [];

const byId = {};
for (const s of stats) byId[s.id] = s;

const enriched = prev.videos.map((v) => {
  const s = byId[v.video_id] || {};
  const st = s.statistics || {};
  const sn = s.snippet || {};
  return {
    ...v,
    title: sn.title || v.title,
    description: String(sn.description || v.description || '').slice(0, 1200),
    tags: sn.tags || [],
    viewCount: parseInt(st.viewCount || '0', 10),
    likeCount: parseInt(st.likeCount || '0', 10),
    commentCount: parseInt(st.commentCount || '0', 10),
  };
});

enriched.sort((a, b) => b.viewCount - a.viewCount);

// Top 10 overall, then force at least 2 per domain by displacing the
// lowest-ranked videos of the over-represented domain.
let top = enriched.slice(0, 10);
for (const domain of [AI, RAD]) {
  const have = top.filter((v) => v.domain === domain);
  if (have.length >= 2) continue;
  const need = 2 - have.length;
  const additions = enriched
    .filter((v) => v.domain === domain && !top.includes(v))
    .slice(0, need);
  if (additions.length === 0) continue;
  const other = top.filter((v) => v.domain !== domain);
  const dropped = other.slice(0, Math.max(0, other.length - additions.length));
  top = [...top.filter((v) => v.domain === domain), ...dropped, ...additions];
  top.sort((a, b) => b.viewCount - a.viewCount);
}
top = top.slice(0, 10);

// Top 6 for transcripts, guaranteeing at least 2 per domain.
const picked = [];
for (const domain of [AI, RAD]) {
  for (const v of top.filter((x) => x.domain === domain).slice(0, 2)) picked.push(v);
}
for (const v of top) {
  if (picked.length >= 6) break;
  if (!picked.includes(v)) picked.push(v);
}
const transcriptSet = picked.slice(0, 6);

const domain_map = {};
for (const v of top) domain_map[v.video_id] = v.domain;

return [{
  json: {
    enriched_top_videos: top,
    ai_channel_data: top.filter((v) => v.domain === AI),
    radiology_channel_data: top.filter((v) => v.domain === RAD),
    transcript_ids: transcriptSet.map((v) => v.video_id),
    domain_map,
    videos_analyzed: enriched.length,
  },
  pairedItem: { item: 0 },
}];`,
});

// ---------------------------------------------------------------------------
// 8. Transcripts via the media worker  (spec node 4)
// ---------------------------------------------------------------------------
node(
  'Worker · Fetch Transcripts',
  'n8n-nodes-base.httpRequest',
  4.4,
  [1080, 300],
  {
    method: 'POST',
    url: `=${WORKER.slice(1)}/transcripts`,
    sendBody: true,
    specifyBody: 'json',
    jsonBody:
      '={{ JSON.stringify({ video_ids: $json.transcript_ids, domain_map: $json.domain_map, limit: 6 }) }}',
    options: { timeout: 180000 },
  },
  {
    // Spec: if every transcript is unavailable, continue on metadata alone.
    onError: 'continueRegularOutput',
  }
);

// ---------------------------------------------------------------------------
// 9-15. Research: prompt from file -> OpenRouter -> parse -> retry once
// ---------------------------------------------------------------------------
node(
  'Worker · Research Prompt',
  'n8n-nodes-base.httpRequest',
  4.4,
  [1300, 300],
  {
    url: `=${WORKER.slice(1)}/prompts/research`,
    options: { response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
  },
  { retryOnFail: true, maxTries: 2 }
);

node('Prepare Research Payload', 'n8n-nodes-base.code', 2, [1520, 300], {
  jsCode: `// Splits transcripts back out by domain so the model sees the two worlds
// side by side rather than as one undifferentiated pile.
const AI = 'AI automation';

const cfg = $('Config').first().json;
const ranked = $('Rank & Balance Domains').first().json;
const tRes = $('Worker · Fetch Transcripts').first().json || {};
const transcripts = tRes.transcripts || {};

const ai_transcripts = {};
const radiology_transcripts = {};
for (const [videoId, rec] of Object.entries(transcripts)) {
  const bucket = rec.domain === AI ? ai_transcripts : radiology_transcripts;
  bucket[videoId] = { transcript: rec.transcript, domain: rec.domain };
}

// The archive is the ONLY citable source. It is handed over under a key that
// says so, and the competitor material under keys that say the opposite, so the
// distinction survives into the model's context rather than living only in the
// prompt. Missing entirely if Postgres was down (the node continues on error).
const mem = $('Postgres · Content Memory').first().json || {};
const citable_facts = Array.isArray(mem.facts) ? mem.facts : [];
const past_insights = Array.isArray(mem.insights) ? mem.insights : [];

const payload = {
  citable_facts,
  past_insights,
  competitor_channel_data_NOT_CITABLE: {
    ai: ranked.ai_channel_data,
    radiology: ranked.radiology_channel_data,
  },
  competitor_transcripts_NOT_CITABLE: {
    ai: ai_transcripts,
    radiology: radiology_transcripts,
  },
  niche_context: cfg.NICHE_CONTEXT,
  target_audience: cfg.TARGET_AUDIENCE,
};

return [{
  json: {
    payload_json: JSON.stringify(payload),
    system_prompt: $('Worker · Research Prompt').first().json.data,
    transcripts_used: Object.keys(transcripts).length,
    transcripts_available: tRes.available_count || 0,
    citable_facts_count: citable_facts.length,
  },
  pairedItem: { item: 0 },
}];`,
});

const orBody = (temp, systemExpr, userExpr, modelKey = 'WRITER_MODEL') =>
  `={{ JSON.stringify({ model: $('Config').first().json.${modelKey}, temperature: ${temp}, response_format: { type: 'json_object' }, messages: [ { role: 'system', content: ${systemExpr} }, { role: 'user', content: ${userExpr} } ] }) }}`;

// Covers both rejection causes -- unparseable JSON and an under-length script.
// A reminder that named only JSON would be actively misleading on a retry
// triggered by word count.
const JSON_REMINDER =
  " + '\\n\\nCRITICAL: your previous response was REJECTED. It was either not valid JSON, " +
  "or the script was far shorter than the required length. Return ONLY a single valid JSON " +
  "object -- no markdown fences, no preamble, no explanation -- and meet every stated word " +
  "count. Long, substantive sections are required; do not summarise.'";

function openRouterNode(name, pos, temp, systemExpr, userExpr, modelKey = 'WRITER_MODEL') {
  return node(
    name,
    'n8n-nodes-base.httpRequest',
    4.4,
    pos,
    {
      method: 'POST',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'openRouterApi',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: orBody(temp, systemExpr, userExpr, modelKey),
      options: { timeout: 300000 },
    },
    { retryOnFail: true, maxTries: 2 }
  );
}

const PARSE_CODE = (label, requiredPath, extraCheck = '') => `// Tolerant parse: strips accidental markdown fences before JSON.parse.
const raw = $input.first().json?.choices?.[0]?.message?.content ?? '';
let ok = true;
let parsed = null;
let parse_error = null;
let word_count = null;
let word_target = null;

try {
  const cleaned = String(raw)
    .replace(/^\\s*\`\`\`(?:json)?/i, '')
    .replace(/\`\`\`\\s*$/, '')
    .trim();
  parsed = JSON.parse(cleaned);
  if (!(${requiredPath})) {
    ok = false;
    parse_error = '${label} JSON parsed but is missing required fields';
  }
} catch (err) {
  ok = false;
  parse_error = err.message;
}
${extraCheck}

return [{
  json: { ok, parsed, parse_error, word_count, word_target, raw: ok ? undefined : String(raw).slice(0, 2000) },
  pairedItem: { item: 0 },
}];`;

// --- research ---
openRouterNode(
  'OpenRouter · Research',
  [1740, 300],
  0.4,
  '$json.system_prompt',
  '$json.payload_json'
,  'RESEARCH_MODEL'
);

node('Parse Research', 'n8n-nodes-base.code', 2, [1960, 300], {
  jsCode: PARSE_CODE('research', 'parsed && parsed.recommended_topic && parsed.intersection_gap'),
});

node('Research JSON OK?', 'n8n-nodes-base.if', 2.3, [2180, 300], {
  conditions: isTrue('={{ $json.ok }}'),
  options: {},
});

openRouterNode(
  'OpenRouter · Research Retry',
  [2180, 480],
  0.4,
  `$('Prepare Research Payload').first().json.system_prompt${JSON_REMINDER}`,
  "$('Prepare Research Payload').first().json.payload_json"
,  'RESEARCH_MODEL'
);

node('Parse Research (Retry)', 'n8n-nodes-base.code', 2, [2400, 480], {
  jsCode: PARSE_CODE('research', 'parsed && parsed.recommended_topic && parsed.intersection_gap'),
});

node('Research Ready', 'n8n-nodes-base.code', 2, [2620, 300], {
  jsCode: `// Single join point for both the first-try and retry branches, so every
// downstream reference has exactly one node to read from.
const j = $input.first().json;
if (!j.ok || !j.parsed) {
  throw new Error('Research JSON unparseable after one retry: ' + (j.parse_error || 'unknown'));
}
return [{ json: j.parsed, pairedItem: { item: 0 } }];`,
});

// ---------------------------------------------------------------------------
// 16-22. Script generation, same prompt-from-file + retry shape
// ---------------------------------------------------------------------------
node(
  'Worker · Script Prompt',
  'n8n-nodes-base.httpRequest',
  4.4,
  [2840, 300],
  {
    url: `=${WORKER.slice(1)}/prompts/script`,
    options: { response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
  },
  { retryOnFail: true, maxTries: 2 }
);

node('Prepare Script Payload', 'n8n-nodes-base.code', 2, [3060, 300], {
  jsCode: `const cfg = $('Config').first().json;
const research = $('Research Ready').first().json;

const mem = $('Postgres · Content Memory').first().json || {};
const citable_facts = Array.isArray(mem.facts) ? mem.facts : [];

const words = Math.round(cfg.VIDEO_LENGTH_MINUTES * 130);
const sections = cfg.BODY_SECTIONS || 4;
const perSection = Math.round((words - 140) / sections);

const instruction = [
  'Write a "DID YOU KNOW?" educational video on the recommended_topic.',
  '',
  'FORMAT. This is not a tutorial and not a talking-head opinion. It is a short',
  'educational piece built around ONE genuinely surprising, SOURCED fact, and what',
  'that fact means for someone who operates imaging equipment for a living.',
  '',
  '  hook       - state the surprising fact in the first sentence, plainly, and',
  '               name its source out loud. No throat-clearing, no "in this video",',
  '               no greeting. The first seven words decide whether anyone stays.',
  '  section 1  - the fact in full: what was actually reported, by whom, and when.',
  '  section 2  - why it matters to a radiographer specifically, in their shift.',
  '  section 3  - where AI or automation touches it - the concrete mechanism, the',
  '               actual tool or n8n node, the actual sequence of steps.',
  '  section 4  - what a viewer can do about it now.',
  '  cta        - invite BOTH radiographers and AI practitioners to answer a',
  '               specific question, not "let me know what you think".',
  '',
  'SOURCING. citable_facts is the ONLY source you have. Every figure, outcome,',
  'clearance, product name or study result you state MUST come from it, and you',
  'MUST name the source in the spoken line ("Radiology Business reported...").',
  'List each one in sourced_claims with the exact source_url from the payload.',
  'The competitor channel data is NOT a source. It shows you how videos are paced,',
  'nothing more. A number you saw in a competitor transcript is that creator\\'s',
  'unverified marketing claim and repeating it is worse than inventing one,',
  'because it looks sourced.',
  '',
  'LENGTH. Target ' + cfg.VIDEO_LENGTH_MINUTES + ' minutes at 130 words per minute = ' +
    words + ' words TOTAL, in EXACTLY ' + sections + ' body sections.',
  '  - hook: 40-60 words',
  '  - EACH of the ' + sections + ' body sections: about ' + perSection +
    ' words (per section, not for all of them combined)',
  '  - cta: 40-60 words',
  'Write the actual spoken words. Do not outline, summarise, or write section',
  'abstracts. Going long is as wrong as going short: this is a ' +
    cfg.VIDEO_LENGTH_MINUTES + '-minute video, not a lecture.',
  '',
  // The previous version of this line asked for "worked examples, specific tools
  // and real numbers". "Real numbers" is what produced "a 30% decrease at our
  // facility" on the first live run: the model had no numbers, so it invented
  // them. Now there ARE numbers -- but only the ones in citable_facts.
  'REACH THE LENGTH WITH SOURCED DETAIL AND BUILD DETAIL, NEVER BY INVENTING.',
  'If you need another beat, take another fact from citable_facts or describe one',
  'more real step of the build. Never pad with an unsourced statistic, a study, or',
  'a story about having deployed something.',
  '',
  'FOOTAGE. pexels_search_keywords must contain exactly ' + (cfg.FOOTAGE_KEYWORDS || 12) +
    ' DISTINCT, visually literal search terms. They become the b-roll, one shot every ' +
    (cfg.SHOT_SECONDS || 4) + ' seconds, so near-duplicates ("hospital", "hospital corridor")',
  'produce a video that looks like it repeats. Vary the subject: equipment, people,',
  'screens, environments, abstract technology.',
].join('\\n');

const payload = {
  research,
  citable_facts,
  competitor_material_NOT_CITABLE: 'see research.pacing_patterns - format only, never a source',
  niche_context: cfg.NICHE_CONTEXT,
  target_audience: cfg.TARGET_AUDIENCE,
  video_length_minutes: cfg.VIDEO_LENGTH_MINUTES,
  body_sections: sections,
  instruction,
};

return [{
  json: {
    payload_json: JSON.stringify(payload),
    system_prompt: $('Worker · Script Prompt').first().json.data,
  },
  pairedItem: { item: 0 },
}];`,
});

openRouterNode(
  'OpenRouter · Script',
  [3280, 300],
  0.7,
  '$json.system_prompt',
  '$json.payload_json'
);

const SCRIPT_REQUIRED =
  'parsed && parsed.script && parsed.script.hook && Array.isArray(parsed.script.body) && parsed.seo && parsed.seo.title';

// Length used to be enforced here as well. It now lives ONLY in Editorial
// Checks, alongside every other ruling, so a single component owns quality and
// there is one threshold to maintain rather than two that can drift apart.

node('Parse Script', 'n8n-nodes-base.code', 2, [3500, 300], {
  jsCode: PARSE_CODE('script', SCRIPT_REQUIRED),
});

node('Script JSON OK?', 'n8n-nodes-base.if', 2.3, [3720, 300], {
  conditions: isTrue('={{ $json.ok }}'),
  options: {},
});

openRouterNode(
  'OpenRouter · Script Retry',
  [3720, 480],
  0.7,
  `$('Prepare Script Payload').first().json.system_prompt${JSON_REMINDER}`,
  "$('Prepare Script Payload').first().json.payload_json"
);

node('Parse Script (Retry)', 'n8n-nodes-base.code', 2, [3940, 480], {
  jsCode: PARSE_CODE('script', SCRIPT_REQUIRED),
});

node('Script Ready', 'n8n-nodes-base.code', 2, [4160, 300], {
  jsCode: `const j = $input.first().json;

// A missing or unparseable object is fatal — there is nothing to narrate.
if (!j.parsed) {
  throw new Error('Script JSON unparseable after one retry: ' + (j.parse_error || 'unknown'));
}

// A merely SHORT script is not fatal. By this point the retry has already been
// spent, and shipping a slightly short video beats discarding a whole run's
// research over word count. The shortfall is recorded and surfaced in Final Log.
const s = j.parsed;
s._word_count = j.word_count;
s._word_target = j.word_target;
s._length_warning =
  !j.ok && /too short/.test(j.parse_error || '') ? j.parse_error : null;
// Trim the SEO title to YouTube's practical limit; the prompt asks for <60
// but a model overshooting must not fail the upload.
if (s.seo && typeof s.seo.title === 'string' && s.seo.title.length > 95) {
  s.seo.title = s.seo.title.slice(0, 95).trim();
}
return [{ json: s, pairedItem: { item: 0 } }];`,
});

// ---------------------------------------------------------------------------
// EDITORIAL GATE — the orchestrator that stops the pipeline hallucinating
//
// The first live run published "At our facility, we implemented an AI agent...
// The result? A 30% decrease in report turnaround time" to an audience of
// healthcare professionals. None of it happened. The prompts were asking for
// it: rule 3 demanded the use case be "SPECIFIC and REAL" while rule 4 demanded
// "insider knowledge", and with no grounding the only way to satisfy both is to
// invent.
//
// There is no authoritative source to fact-check medical claims against here --
// the only "sources" are competitor video metadata. So the gate does not try to
// verify claims. It forbids the CLASSES of claim that would need verifying, and
// enforces that in two layers, because this repo already learned that a single
// gate lets one class through.
//
// Layer 1 lives in prompts/script_prompt.txt (prevention).
// Layer 2 is Editorial Checks: deterministic, free, cannot itself hallucinate.
// Layer 3 is Editorial Verifier: a DIFFERENT vendor's model judging semantics.
//
// Structure is two explicit cycles rather than a loop. A loop would need
// cross-run node references ($('X').first() on a node that ran twice), which is
// exactly the ambiguity that has bitten this repo before. Two cycles means
// every node runs exactly once and .first() is unambiguous.
// ---------------------------------------------------------------------------

// The script is read from a NAMED node, never from $input. Round 1 sits
// downstream of "Worker · Verifier Prompt", an HTTP Request node, and an HTTP
// Request node REPLACES the item with its response body -- so $input there is
// { data: "<the verifier prompt text>" } and carries no script at all.
//
// This shipped, and it was silent in the worst way. Round 1 saw 0 words, 0 body
// sections and an empty title on EVERY run, raised three blocking violations,
// and forced a revision that was never needed. The judge was equally blind (its
// payload carried script: undefined) so it just echoed those findings back,
// which is why the violation list came out doubled. Then the revision step told
// the writer "your script was REJECTED" while handing it previous_script:
// undefined and violations reading "0 body sections" -- so the writer rewrote
// from nothing, against nonsense. Execution 656's revised draft came back with 6
// body sections against a hard rule of 5, and 1606 words against a 1040 target.
//
// Everything downstream still looked healthy: the run completed, uploaded, and
// reported success. The generator now refuses to build this shape at all -- see
// the $input-after-HTTP guard below.
const EDITORIAL_CHECKS_CODE = (sourceNode) => `// Deterministic editorial checks -- Layer 2.
// Catches fabrication by FORM: the claim classes this pipeline has no source to
// support. Validated against fixtures/hallucinated-script.json (the real script
// from execution 654), which must produce at least 6 blocking hits.
const cfg = $('Config').first().json;
const s = $('${sourceNode}').first().json;

const body = Array.isArray(s.script && s.script.body) ? s.script.body : [];
const parts = [
  ['hook', (s.script && s.script.hook) || ''],
  ...body.map((b, i) => ['body' + (i + 1), b]),
  ['cta', (s.script && s.script.cta) || ''],
];
const fullText = parts.map((p) => String(p[1] || '')).join(' ');
const words = fullText.trim() ? fullText.trim().split(/\\s+/).length : 0;
const target = Math.round((cfg.VIDEO_LENGTH_MINUTES || 8) * 130);

// There is NO traceability exemption for percentages, and that is deliberate.
//
// Two earlier attempts both failed, and the regression test caught both:
//   1. Exempting any figure whose digits appear in the research payload was
//      useless -- the payload is full of incidental numbers (view counts, video
//      ids, years), so "50" appeared somewhere and duly licensed "up to 50%".
//   2. Tightening it to percentages-only STILL let "up to 50%" through, because
//      "50%" really does appear in the corpus -- inside a competitor's video
//      transcript.
//
// That second failure is the important one. The corpus is competitor YouTube
// transcripts. A creator saying "50%" in their video is not evidence that
// automation halves your reporting time; it is their marketing claim, unverified.
// Treating it as a citable source would launder someone else's unsupported
// number into this channel's voice.
//
// So every percentage and every measured outcome is blocked outright. This is
// narrow: it does not touch ordinary numbers like "4 hours", "5 steps" or
// "400 integrations", only claim-shaped figures the host cannot stand behind.
// TWO corpora, and they must never be merged. This is the whole safety
// property of the sourced-claim exemption below.
//
//   citable  - the content-engine archive. Real articles, real outlets, real
//              URLs. A figure here is checkable.
//   corpus   - competitor YouTube transcripts. NOT evidence, and never becomes
//              evidence. Kept only so the judge can spot copied content.
//
// Collapsing them is not hypothetical: an earlier traceability check keyed off
// the research payload and let "up to 50%" through, because 50% genuinely
// appears in a competitor's transcript. A dedicated regression case guards this.
let corpus = '';
try { corpus = String($('Prepare Research Payload').first().json.payload_json || ''); } catch (e) { corpus = ''; }

let citableFacts = [];
try {
  const mem = $('Postgres · Content Memory').first().json || {};
  citableFacts = Array.isArray(mem.facts) ? mem.facts : [];
} catch (e) { citableFacts = []; }

const citableText = citableFacts
  .map((f) => String(f.key_findings || '') + ' ' + String(f.takeaway || ''))
  .join(' ');
const citableUrls = new Set(citableFacts.map((f) => String(f.url || '').trim()).filter(Boolean));
const citableSources = citableFacts.map((f) => String(f.source || '').trim()).filter(Boolean);

// A figure is permitted only when the script BACKS it: declared in
// sourced_claims, pointing at a URL that is actually in the archive, with the
// figure present in that archive text, and the outlet named in the spoken line.
// Declaring a source is not enough -- the attribution has to be audible, or the
// viewer has no way to tell a sourced claim from an invented one.
const declared = Array.isArray(s.sourced_claims) ? s.sourced_claims : [];
function isBacked(figure, whereText) {
  const fig = String(figure).replace(/\\s+/g, '');
  for (const d of declared) {
    const url = String((d && d.url) || (d && d.source_url) || '').trim();
    const name = String((d && d.source_name) || '').trim();
    const claim = String((d && d.claim) || '').replace(/\\s+/g, '');
    if (!citableUrls.has(url)) continue;                 // not from the archive
    if (!claim.includes(fig)) continue;                  // declares a different figure
    if (!citableText.replace(/\\s+/g, '').includes(fig)) continue; // not actually in the archive
    if (!name || !whereText.toLowerCase().includes(name.toLowerCase())) continue; // not said aloud
    return name;
  }
  return null;
}

const violations = [];
const add = (rule, severity, quote, why) => violations.push({
  rule, severity, quote: String(quote).slice(0, 200), why, source: 'deterministic',
});

const RULES = [
  { rule: 'fabricated-statistic', severity: 'blocking',
    re: /\\b\\d+(?:\\.\\d+)?\\s*(?:%|percent\\b)/gi,
    why: 'A percentage the host cannot stand behind. Competitor transcripts are not evidence.' },
  { rule: 'measured-outcome-claim', severity: 'blocking',
    re: /\\b(?:a|an)\\s+\\d+(?:\\.\\d+)?\\s*(?:%|percent)?\\s*(?:decrease|increase|reduction|improvement|drop|rise)\\b/gi,
    why: 'A measured outcome that was never measured.' },
  { rule: 'first-person-deployment', severity: 'blocking',
    re: /\\b(?:at|in)\\s+(?:our|my)\\s+(?:facility|hospital|department|trust|clinic|practice|site|unit)\\b|\\bwe\\s+(?:implemented|deployed|rolled\\s+out|installed|introduced)\\b/gi,
    why: 'A first-person deployment story. The host has not run this.' },
  { rule: 'unsourced-study-claim', severity: 'blocking',
    re: /\\b(?:a\\s+study|studies\\s+(?:show|found)|research\\s+(?:shows|found)|according\\s+to\\s+[^.]{0,40}(?:study|paper|trial|report))\\b/gi,
    why: 'Cites research that is not in the supplied payload.' },
  // "I built X in n8n" is the single most common title on the AI channels this
  // pipeline researches, and the research step used to hand those formulas to
  // the writer as the pattern to copy. The formulas are gone from the research
  // output now; this catches any that survive by imitation. Nothing here was
  // built by the host, and a faceless channel claiming authorship of a system
  // it never ran is the same fabrication as inventing a statistic.
  { rule: 'first-person-build', severity: 'blocking',
    re: /\\b(?:I|we)\\s+(?:just\\s+|recently\\s+)?(?:built|made|created|developed|designed|coded|wrote|set\\s+up|wired\\s+up|put\\s+together|automated|shipped|launched)\\b/gi,
    why: 'Claims to have built or made something. Describe how it IS built, not that you built it.' },
  // A "Did you know?" video that opens like every other AI video has already
  // failed correction 8. Blocking, not advisory: these are trivially avoidable
  // and their presence is proof the model reached for the generic shape.
  { rule: 'generic-filler', severity: 'blocking',
    re: /\\b(?:in\\s+today'?s\\s+video|let'?s\\s+dive\\s+(?:in|into)|buckle\\s+up|without\\s+further\\s+ado|in\\s+this\\s+video,?\\s+(?:I|we)|welcome\\s+back)\\b/gi,
    why: 'Generic video filler. Open on the fact itself.' },
  { rule: 'hype-cliche', severity: 'advisory',
    re: /\\b(?:game[- ]?changer|revolutioni[sz]e|the\\s+future\\s+is\\s+bright|unlock\\s+the\\s+power|take\\s+it\\s+to\\s+the\\s+next\\s+level|cutting[- ]edge|paradigm\\s+shift)\\b/gi,
    why: 'Marketing cliche. Say the specific thing instead.' },
  // Advisory on purpose: radiologists are a legitimate topic, so a blocking
  // regex here would fire on correct usage. The judge decides.
  { rule: 'profession-confusion', severity: 'advisory',
    re: /\\bradiologists?\\b/gi,
    why: 'Mentions radiologists; the audience is radiographers. Judge to adjudicate.' },
  { rule: 'absolute-claim', severity: 'advisory',
    re: /\\b(?:guaranteed|never\\s+fails|always\\s+works|100%\\s+accurate|eliminates\\s+all)\\b/gi,
    why: 'Absolute claim that cannot be supported.' },
];

// Only figure-shaped rules can be excused by sourcing. A first-person build
// claim or a piece of generic filler is wrong no matter who reported it.
const SOURCEABLE = new Set(['fabricated-statistic', 'measured-outcome-claim']);
const sourced = [];

for (const r of RULES) {
  for (const pair of parts) {
    const where = pair[0];
    const text = String(pair[1] || '');
    const hits = text.match(r.re);
    if (!hits) continue;
    for (const h of hits) {
      if (SOURCEABLE.has(r.rule)) {
        const backedBy = isBacked(h, text);
        if (backedBy) {
          sourced.push({ figure: h, where, source: backedBy });
          continue;
        }
      }
      add(r.rule, r.severity, where + ': ' + h, r.why);
    }
  }
}

// The SEO title was previously checked only for length and topic, so
// "I Built an AI Radiology Report Writer in n8n (No Code)" -- an actual
// generated title -- passed the gate untouched while the same words in the body
// would have been blocked.
const titleText = (s.seo && s.seo.title) || '';
for (const r of RULES) {
  if (r.rule !== 'first-person-build' && r.rule !== 'hype-cliche') continue;
  const hits = titleText.match(r.re);
  if (hits) for (const h of hits) add(r.rule, 'blocking', 'seo.title: ' + h, r.why);
}

// Mechanical rulings live here too, so ONE component owns quality.
const wantSections = cfg.BODY_SECTIONS || 4;
if (body.length !== wantSections) {
  add('structure', 'blocking', body.length + ' body sections', 'Exactly ' + wantSections + ' required.');
}
if (words < target * 0.7) add('too-short', 'blocking', words + ' words vs target ' + target, 'Under 70% of target length.');
// Overshoot is now a real failure, not a bonus. A 1606-word draft against a
// 1040 target produced a 10.9-minute video for an 8-minute slot, and the whole
// point of the 4-minute format is that it stays 4 minutes.
if (words > target * 1.35) {
  add('too-long', 'blocking', words + ' words vs target ' + target, 'Over 135% of target length.');
}

const title = (s.seo && s.seo.title) || '';
if (!title) add('seo-title-missing', 'blocking', '(empty)', 'No SEO title.');
if (title.length > 60) add('seo-title-length', 'advisory', title, title.length + ' chars, limit 60.');
if (title && !/(\\bai\\b|automat|radiolog|radiograph|imaging|healthcare)/i.test(title)) {
  add('seo-title-topic', 'advisory', title, 'Title references neither AI/automation nor radiology.');
}

const cta = (s.script && s.script.cta) || '';
if (!/radiograph/i.test(cta) || !/(\\bAI\\b|practitioner|engineer|developer|automation)/i.test(cta)) {
  add('weak-cta', 'advisory', cta.slice(0, 160), 'CTA must invite BOTH radiographers and AI practitioners.');
}

// Keyword count drives clip variety: fewer keywords means fewer unique clips
// means visible repetition, which is a real defect in the finished video rather
// than a style note. Near-duplicates defeat the purpose just as badly as a
// short list, so both are checked.
const wantKw = cfg.FOOTAGE_KEYWORDS || 12;
const kws = Array.isArray(s.pexels_search_keywords) ? s.pexels_search_keywords : [];
if (kws.length < wantKw) {
  add('keywords', 'blocking', kws.length + ' keywords', wantKw + ' distinct keywords required for clip variety.');
}
const kwNorm = new Set(kws.map((k) => String(k || '').toLowerCase().trim()));
if (kwNorm.size < kws.length) {
  add('keywords-duplicate', 'blocking', kws.length - kwNorm.size + ' duplicate(s)', 'Keywords must be distinct.');
}

// A "Did you know?" video with nothing sourced is just an opinion piece.
if (citableFacts.length > 0 && sourced.length === 0 && declared.length === 0) {
  add('unsourced-video', 'advisory', 'no sourced_claims',
      'The archive supplied ' + citableFacts.length + ' facts and the script cites none.');
}

const blocking = violations.filter((v) => v.severity === 'blocking');

const judge = {
  script: s.script,
  seo: s.seo,
  sourced_claims: declared,
  // The judge gets both corpora, LABELLED, because it has to tell a properly
  // attributed fact from a laundered competitor claim -- and it cannot do that
  // if the two arrive as one undifferentiated blob.
  citable_archive: citableFacts,
  competitor_transcripts_NOT_CITABLE: corpus.slice(0, 16000),
  deterministic_findings: violations,
  figures_accepted_as_sourced: sourced,
};

console.log('editorial checks: ' + words + '/' + target + ' words, ' +
  blocking.length + ' blocking, ' + (violations.length - blocking.length) + ' advisory, ' +
  sourced.length + ' figure(s) accepted as sourced of ' + citableFacts.length + ' archive facts');
for (const g of sourced) console.log('  SOURCED ' + g.figure + ' (' + g.source + ') @' + g.where);
for (const v of blocking) console.log('  BLOCKING ' + v.rule + ' -> ' + v.quote);

return [{
  json: {
    script: s.script,
    seo: s.seo,
    pexels_search_keywords: kws,
    sourced_claims: declared,
    deterministic_violations: violations,
    deterministic_blocking: blocking.length,
    figures_sourced: sourced,
    citable_facts_available: citableFacts.length,
    word_count: words,
    word_target: target,
    judge_payload_json: JSON.stringify(judge),
  },
  pairedItem: { item: 0 },
}];`;

const EDITORIAL_GATE_CODE = (checksNode, allowRevision) => `// Merges Layer 2 (deterministic) with Layer 3 (judge) and decides.
// Each node in this gate runs exactly once, so .first() is unambiguous.
const checks = $('${checksNode}').first().json;
const raw = $input.first().json?.choices?.[0]?.message?.content ?? '';

let judge = null;
let judge_error = null;
try {
  judge = JSON.parse(String(raw).replace(/^\\s*\\\`\\\`\\\`(?:json)?/i, '').replace(/\\\`\\\`\\\`\\s*$/, '').trim());
} catch (err) {
  judge_error = err.message;
}

// A judge that failed to answer must NOT be read as approval. Fail toward
// caution: an unreadable verdict counts as unverified, not as a pass.
const judgeViolations = (judge && Array.isArray(judge.violations) ? judge.violations : [])
  .map((v) => ({ ...v, source: 'judge' }));

// Advisory deterministic flags the judge explicitly dismissed are dropped;
// anything it upheld is promoted to a real violation.
const upheld = new Set(
  (judge && Array.isArray(judge.advisory_adjudication) ? judge.advisory_adjudication : [])
    .filter((a) => a.upheld)
    .map((a) => String(a.rule))
);

const detKept = checks.deterministic_violations.filter(
  (v) => v.severity === 'blocking' || upheld.has(v.rule)
);

const all = [...detKept, ...judgeViolations];
const blocking = all.filter((v) => v.severity === 'blocking');

const verdict = blocking.length === 0 ? 'pass' : 'flagged';
const needs_revision = ${allowRevision ? 'blocking.length > 0' : 'false'};

console.log('editorial gate: verdict=' + verdict + ' blocking=' + blocking.length +
  ' advisory=' + (all.length - blocking.length) + (judge_error ? ' JUDGE_UNPARSEABLE' : ''));
for (const v of blocking) console.log('  ' + v.rule + ': ' + String(v.quote).slice(0, 120));

return [{
  json: {
    script: checks.script,
    seo: checks.seo,
    pexels_search_keywords: checks.pexels_search_keywords,
    word_count: checks.word_count,
    word_target: checks.word_target,
    editorial_verdict: verdict,
    editorial_violations: all,
    editorial_blocking_count: blocking.length,
    figures_sourced: checks.figures_sourced || [],
    citable_facts_available: checks.citable_facts_available || 0,
    sourced_claims: checks.sourced_claims || [],
    judge_summary: (judge && judge.summary) || null,
    judge_error,
    needs_revision,
  },
  pairedItem: { item: 0 },
}];`;

// sourceNode is the node holding the script to check -- NOT necessarily the node
// wired into the checks. Round 1's upstream neighbour is an HTTP Request that
// overwrites the item; round 2's is a Code node that does not.
function editorialCycle(suffix, y, allowRevision, sourceNode) {
  const checksName = 'Editorial Checks' + suffix;
  const verifierName = 'Editorial Verifier' + suffix;
  const gateName = 'Editorial Gate' + suffix;

  node(checksName, 'n8n-nodes-base.code', 2, [4380, y], {
    jsCode: EDITORIAL_CHECKS_CODE(sourceNode),
  });

  openRouterNode(
    verifierName,
    [4600, y],
    0,
    "$('Worker · Verifier Prompt').first().json.data",
    '$json.judge_payload_json',
    'JUDGE_MODEL'
  );

  node(gateName, 'n8n-nodes-base.code', 2, [4820, y], {
    jsCode: EDITORIAL_GATE_CODE(checksName, allowRevision),
  });

  connect(checksName, verifierName);
  connect(verifierName, gateName);
  return { checksName, verifierName, gateName };
}

node(
  'Worker · Verifier Prompt',
  'n8n-nodes-base.httpRequest',
  4.4,
  [4160, 300],
  {
    url: `=${WORKER.slice(1)}/prompts/verifier`,
    options: { response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
  },
  { retryOnFail: true, maxTries: 2 }
);

const cycle1 = editorialCycle('', 300, true, 'Script Ready');
const cycle2 = editorialCycle(' (Round 2)', 700, false, 'Revision Parsed');

node('Needs Revision?', 'n8n-nodes-base.if', 2.3, [5040, 300], {
  conditions: isTrue('={{ $json.needs_revision }}'),
  options: {},
});

node('Prepare Revision', 'n8n-nodes-base.code', 2, [5040, 700], {
  jsCode: `// Hands the writer the EXACT offending quotes and the required fix. A
// generic "try again" produces the same fabrications with different numbers.
const gate = $input.first().json;
const blocking = gate.editorial_violations.filter((v) => v.severity === 'blocking');

const lines = blocking.map((v, i) =>
  (i + 1) + '. [' + v.rule + '] ' + JSON.stringify(String(v.quote)) +
  '\\n   WHY: ' + (v.why || 'unsupported') +
  '\\n   FIX: ' + (v.fix || 'Remove the claim, or rewrite it as an explicit hypothetical, or replace it with a concrete build step that is true by construction.')
);

const instruction = [
  'Your previous script was REJECTED by the editorial gate. Fix every violation below and return the COMPLETE corrected script.',
  '',
  'VIOLATIONS:',
  ...lines,
  '',
  'HOW TO FIX, in order of preference:',
  '  1. Delete the claim entirely. The script does not need it.',
  '  2. Replace it with a concrete BUILD step that is true by construction --',
  '     the actual tool, the actual node, the actual sequence. This is what the',
  '     audience wants anyway.',
  '  3. Reframe it as an EXPLICIT hypothetical ("suppose your department...").',
  '',
  'Do NOT swap one invented figure for another. Do NOT keep the claim and soften it',
  'with "roughly" or "around" -- an invented number is invented at any precision.',
  'Keep everything that was NOT flagged, and hold the same total length.',
].join('\\n');

return [{
  json: {
    payload_json: JSON.stringify({
      previous_script: gate.script,
      previous_seo: gate.seo,
      violations: blocking,
      instruction,
      original_request: JSON.parse($('Prepare Script Payload').first().json.payload_json),
    }),
    system_prompt: $('Worker · Script Prompt').first().json.data,
  },
  pairedItem: { item: 0 },
}];`,
});

openRouterNode(
  'OpenRouter · Script Revise',
  [5260, 700],
  0.4,
  '$json.system_prompt',
  '$json.payload_json',
  'WRITER_MODEL'
);

node('Parse Script (Revised)', 'n8n-nodes-base.code', 2, [5480, 700], {
  jsCode: PARSE_CODE('revised script', SCRIPT_REQUIRED),
});

node('Revision Parsed', 'n8n-nodes-base.code', 2, [5700, 700], {
  jsCode: `// If the revision came back unparseable, fall back to the ORIGINAL script
// rather than losing the run. It is flagged either way, and the gate's second
// cycle will re-evaluate whichever version proceeds.
const j = $input.first().json;
if (j.ok && j.parsed) return [{ json: j.parsed, pairedItem: { item: 0 } }];

console.log('revision unparseable (' + (j.parse_error || 'unknown') + ') - falling back to the original script');
const prev = $('Editorial Gate').first().json;
return [{
  json: { script: prev.script, seo: prev.seo, pexels_search_keywords: prev.pexels_search_keywords },
  pairedItem: { item: 0 },
}];`,
});

node('Script Approved', 'n8n-nodes-base.code', 2, [5920, 300], {
  jsCode: `// Single join point for the clean path and the revised path. Everything
// downstream reads from HERE, never from Script Ready, so no consumer can
// accidentally pick up the unreviewed draft.
const g = $input.first().json;

const blocking = (g.editorial_violations || []).filter((v) => v.severity === 'blocking');
const s = g.script;

if (!s || !s.hook) throw new Error('Script Approved: no script survived the editorial gate.');

console.log('APPROVED verdict=' + g.editorial_verdict + ' blocking=' + blocking.length +
  ' words=' + g.word_count + '/' + g.word_target);

return [{
  json: {
    script: s,
    seo: g.seo,
    pexels_search_keywords: g.pexels_search_keywords,
    word_count: g.word_count,
    word_target: g.word_target,
    editorial_verdict: g.editorial_verdict,
    editorial_violations: g.editorial_violations || [],
    figures_sourced: g.figures_sourced || [],
    citable_facts_available: g.citable_facts_available || 0,
    sourced_claims: g.sourced_claims || [],
    editorial_blocking_count: blocking.length,
    judge_summary: g.judge_summary || null,
    judge_error: g.judge_error || null,
    revision_rounds: $('Editorial Gate').first().json.needs_revision ? 1 : 0,
  },
  pairedItem: { item: 0 },
}];`,
});

// ---------------------------------------------------------------------------
// 23-25. Pexels footage  (spec node 7)
// ---------------------------------------------------------------------------
node('Split Keywords', 'n8n-nodes-base.code', 2, [6140, 300], {
  jsCode: `const cfg = $('Config').first().json;
const s = $('Script Approved').first().json;

// De-duplicated case-insensitively: two keywords that differ only by case fetch
// the same clips from Pexels and reintroduce the repetition this is meant to fix.
const seen = new Set();
const kws = [];
for (const raw of s.pexels_search_keywords || []) {
  const k = String(raw || '').trim();
  if (!k) continue;
  const key = k.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  kws.push(k);
}

// A model that returned too few keywords should not sink a finished script, but
// it must not silently produce a repetitive video either. Top up from a spread
// of visually distinct fallbacks -- deliberately different subjects, not
// variations on one.
const FALLBACK = [
  'hospital corridor', 'mri scanner', 'ct scan machine', 'radiographer at work',
  'medical monitor display', 'code on screen', 'server room', 'doctor reviewing scan',
  'x-ray image', 'hospital reception', 'laptop typing closeup', 'data visualization',
];
for (const f of FALLBACK) {
  if (kws.length >= (cfg.FOOTAGE_KEYWORDS || 12)) break;
  if (!seen.has(f.toLowerCase())) { seen.add(f.toLowerCase()); kws.push(f); }
}

const final = kws.slice(0, cfg.FOOTAGE_KEYWORDS || 12);
console.log('footage keywords: ' + final.length + ' -> ' + final.join(', '));
return final.map((keyword) => ({ json: { keyword }, pairedItem: { item: 0 } }));`,
});

node(
  'Pexels · Search Footage',
  'n8n-nodes-base.httpRequest',
  4.4,
  [4600, 300],
  {
    url: 'https://api.pexels.com/videos/search',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendQuery: true,
    queryParameters: {
      parameters: [
        { name: 'query', value: '={{ $json.keyword }}' },
        { name: 'per_page', value: "={{ $('Config').first().json.FOOTAGE_PER_KEYWORD }}" },
        { name: 'orientation', value: 'landscape' },
        { name: 'min_duration', value: '8' },
      ],
    },
    options: { timeout: 30000 },
  },
  {

    onError: 'continueRegularOutput',
    retryOnFail: true,
    maxTries: 2,
  }
);

node('Collect Footage URLs', 'n8n-nodes-base.code', 2, [4820, 300], {
  jsCode: `// Picks the SMALLEST mp4 rendition that still meets the 1080p output, not
// the largest available. Everything is downscaled to 1920x1080 anyway, so
// pulling a 4K rendition costs download time and a much slower decode for
// no visible gain. Falls back to the largest available if nothing reaches 1080p.
const urls = [];
for (const item of $input.all()) {
  for (const video of item.json?.videos || []) {
    const files = (video.video_files || [])
      .filter((f) => f.file_type === 'video/mp4' && f.link)
      .sort((a, b) => (a.width || 0) - (b.width || 0));
    const best =
      files.find((f) => (f.width || 0) >= 1920) ||
      files.find((f) => (f.width || 0) >= 1280) ||
      files[files.length - 1];
    if (best) urls.push(best.link);
  }
}

const footage_urls = [...new Set(urls)].slice(0, 10);

const s = $('Script Approved').first().json;
const body = Array.isArray(s.script.body) ? s.script.body : [];
const full_script = [s.script.hook, ...body, s.script.cta]
  .map((p) => String(p || '').trim())
  .filter(Boolean)
  .join(' ');

if (!full_script) throw new Error('Script assembled to an empty string.');

return [{
  json: {
    footage_urls,
    footage_count: footage_urls.length,
    full_script,
    word_count: full_script.split(/\\s+/).length,
    title: s.seo.title,
  },
  pairedItem: { item: 0 },
}];`,
});

// ---------------------------------------------------------------------------
// 26-29. Render on the worker, then poll  (spec nodes 8, 9, 10)
// ---------------------------------------------------------------------------
node(
  'Worker · Render Video',
  'n8n-nodes-base.httpRequest',
  4.4,
  [5040, 300],
  {
    method: 'POST',
    url: `=${WORKER.slice(1)}/render`,
    sendBody: true,
    specifyBody: 'json',
    jsonBody:
      "={{ JSON.stringify({ script_text: $json.full_script, footage_urls: $json.footage_urls, title: $json.title, shot_seconds: $('Config').first().json.SHOT_SECONDS, subtitles: true }) }}",
    options: { timeout: 60000 },
  },
  { retryOnFail: true, maxTries: 2 }
);

node('Wait · Render Poll', 'n8n-nodes-base.wait', 1.1, [5260, 300], {
  amount: 20,
  unit: 'seconds',
});

node(
  'Worker · Render Status',
  'n8n-nodes-base.httpRequest',
  4.4,
  [5480, 300],
  {
    url: `=${WORKER.slice(1)}/jobs/{{ $('Worker · Render Video').first().json.job_id }}`,
    options: { timeout: 30000 },
  },
  { retryOnFail: true, maxTries: 3 }
);

node('Switch · Render State', 'n8n-nodes-base.switch', 3.4, [5700, 300], {
  rules: {
    values: [
      { conditions: strEquals('={{ $json.status }}', 'done'), outputKey: 'done' },
      { conditions: strEquals('={{ $json.status }}', 'failed'), outputKey: 'failed' },
    ],
  },
  // 'extra' gives a real catch-all port at index 2 for status 'running'.
  // The default 'none' would silently drop the item and stall the poll loop.
  options: { fallbackOutput: 'extra' },
});

node('Render Failed', 'n8n-nodes-base.stopAndError', 1, [5700, 620], {
  errorMessage:
    '={{ "Media worker render failed for job " + $json.job_id + ": " + ($json.error || "unknown error") }}',
});

// ---------------------------------------------------------------------------
// 30-34. Upload  (spec node 11, via the native YouTube node)
// ---------------------------------------------------------------------------
node(
  'Worker · Download Video',
  'n8n-nodes-base.httpRequest',
  4.4,
  [5920, 180],
  {
    url: `=${WORKER.slice(1)}/jobs/{{ $('Worker · Render Video').first().json.job_id }}/video`,
    options: {
      timeout: 600000,
      response: { response: { responseFormat: 'file', outputPropertyName: 'data' } },
    },
  },
  { retryOnFail: true, maxTries: 2 }
);

node(
  'YouTube · Upload Video',
  'n8n-nodes-base.youTube',
  1,
  [6140, 180],
  {
    resource: 'video',
    operation: 'upload',
    title: "={{ $('Script Approved').first().json.seo.title }}",
    categoryId: '27',
    regionCode: 'US',
    binaryProperty: 'data',
    options: {
      // A flagged script uploads anyway (your call), but the violations are
      // prepended to the description so they are impossible to miss at review
      // time rather than buried in an execution log you may never open.
      description:
        "={{ $('Script Approved').first().json.editorial_blocking_count > 0" +
        " ? ('[UNVERIFIED CLAIMS - REVIEW BEFORE PUBLISHING]\\n' +" +
        "    $('Script Approved').first().json.editorial_violations" +
        "      .filter(v => v.severity === 'blocking')" +
        "      .map(v => '- ' + v.rule + ': ' + v.quote).join('\\n') +" +
        "    '\\n\\n' + $('Script Approved').first().json.seo.description)" +
        " : $('Script Approved').first().json.seo.description }}",
      tags: "={{ ($('Script Approved').first().json.seo.tags || []).join(',') }}",
      // Guard: a script carrying unresolved blocking violations is forced
      // private no matter what Config says. Uploads are private today, so this
      // changes nothing now -- it stops flagged content auto-publishing if
      // PRIVACY_STATUS is ever set to 'public'.
      privacyStatus:
        "={{ $('Script Approved').first().json.editorial_blocking_count > 0" +
        " ? 'private' : $('Config').first().json.PRIVACY_STATUS }}",
    },
  },
  {

    onError: 'continueErrorOutput',
  }
);

node(
  'Worker · Download Thumbnail',
  'n8n-nodes-base.httpRequest',
  4.4,
  [6360, 180],
  {
    url: `=${WORKER.slice(1)}/jobs/{{ $('Worker · Render Video').first().json.job_id }}/thumbnail`,
    options: {
      timeout: 120000,
      response: { response: { responseFormat: 'file', outputPropertyName: 'data' } },
    },
  },
  { onError: 'continueRegularOutput' }
);

node(
  'YouTube · Set Thumbnail',
  'n8n-nodes-base.httpRequest',
  4.4,
  [6580, 180],
  {
    method: 'POST',
    // The YouTube node returns the new video id as `uploadId`, NOT `id`.
    // Reading `.id` yields undefined, the URL becomes videoId=undefined, and
    // the call fails with a generic "Internal error encountered" that looks
    // like a Google outage rather than a bad parameter. Observed on the first
    // live run. `.id` is kept as a fallback in case a future node version
    // changes the shape back.
    url:
      '=https://www.googleapis.com/youtube/v3/thumbnails/set?videoId=' +
      "{{ $('YouTube · Upload Video').first().json.uploadId || $('YouTube · Upload Video').first().json.id }}",
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'youTubeOAuth2Api',
    sendBody: true,
    contentType: 'binaryData',
    inputDataFieldName: 'data',
    options: { timeout: 120000 },
  },
  {

    // A rejected thumbnail must not lose an uploaded video.
    onError: 'continueRegularOutput',
  }
);

// ---------------------------------------------------------------------------
// 35-37. Cleanup + logs  (spec nodes 12, 13)
// ---------------------------------------------------------------------------
node(
  'Worker · Cleanup Job',
  'n8n-nodes-base.httpRequest',
  4.4,
  [6800, 180],
  {
    method: 'DELETE',
    url: `=${WORKER.slice(1)}/jobs/{{ $('Worker · Render Video').first().json.job_id }}`,
    options: { timeout: 60000 },
  },
  { onError: 'continueRegularOutput' }
);

node('Final Log', 'n8n-nodes-base.code', 2, [7020, 180], {
  jsCode: `// Rebuilt from scratch in a Code node rather than a Set node: several
// upstream nodes run with onError 'continueRegularOutput', and that flag rides
// along on the item, diverting later nodes that have an error output.
const research = $('Research Ready').first().json;
const script = $('Script Approved').first().json;
const ranked = $('Rank & Balance Domains').first().json;
const prep = $('Prepare Research Payload').first().json;
const footage = $('Collect Footage URLs').first().json;
const upload = $('YouTube · Upload Video').first().json;

// The YouTube node publishes the new video id as 'uploadId', not 'id'.
const videoId = upload.uploadId || upload.id;

return [{
  json: {
    video_url: videoId ? 'https://youtube.com/watch?v=' + videoId : null,
    video_id: videoId ?? null,
    privacy_status: $('Config').first().json.PRIVACY_STATUS,
    title: script.seo.title,
    topic: research.recommended_topic,
    // The sourced fact the whole video is built on, with its outlet and URL.
    // This is the first thing to check when reviewing a run: if it is null, the
    // research step found nothing citable and the script is unanchored.
    anchor_fact: research.anchor_fact ?? null,
    unique_angle: research.unique_angle,
    intersection_gap: research.intersection_gap,
    why_this_topic_wins: research.why_this_topic_wins,
    ai_channels_researched: 3,
    radiology_channels_researched: 2,
    videos_analyzed: ranked.videos_analyzed,
    transcripts_used: prep.transcripts_used,
    transcripts_available: prep.transcripts_available,
    footage_clips_used: footage.footage_count,
    script_word_count: script.word_count ?? footage.word_count,
    script_word_target: script.word_target ?? null,

    // Editorial gate outcome. 'flagged' means blocking violations survived the
    // revision round and the video was uploaded private with a warning
    // prepended to its description -- read editorial_violations before
    // publishing anything.
    editorial_verdict: script.editorial_verdict ?? null,
    editorial_blocking_count: script.editorial_blocking_count ?? null,
    editorial_violations: script.editorial_violations ?? [],
    judge_summary: script.judge_summary ?? null,
    judge_error: script.judge_error ?? null,
    revision_rounds: script.revision_rounds ?? 0,

    // Sourcing, recorded so a run is auditable after the fact. A "Did you know?"
    // video with citable_facts_available > 0 and figures_sourced empty asserted
    // nothing checkable -- not a failure, but worth noticing.
    citable_facts_available: script.citable_facts_available ?? 0,
    figures_sourced: script.figures_sourced ?? [],
    sourced_claims: script.sourced_claims ?? [],

    timestamp: new Date().toISOString(),
  },
  pairedItem: { item: 0 },
}];`,
});

node('Upload Failed · Keep Artifacts', 'n8n-nodes-base.code', 2, [6140, 460], {
  jsCode: `// Deliberately does NOT call the worker's cleanup endpoint, so
// final_video.mp4 and thumbnail.jpg survive on the worker volume for
// post-mortem. Recover them with:
//   curl -o video.mp4 http://localhost:8099/jobs/<job_id>/video
const jobId = $('Worker · Render Video').first().json.job_id;
const err = $input.first().json.error || $input.first().error || {};

return [{
  json: {
    upload_failed: true,
    job_id: jobId,
    artifacts_kept: true,
    recover_video: 'http://localhost:8099/jobs/' + jobId + '/video',
    recover_thumbnail: 'http://localhost:8099/jobs/' + jobId + '/thumbnail',
    title: $('Script Approved').first().json.seo.title,
    topic: $('Research Ready').first().json.recommended_topic,
    error: typeof err === 'string' ? err : err.message || JSON.stringify(err).slice(0, 800),
    timestamp: new Date().toISOString(),
  },
  pairedItem: { item: 0 },
}];`,
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
connect('Schedule · Every 3 Days 09:00', 'Config');
// Config -> memory -> channels. Safe in the data path because Build Channel
// List reads $('Config').first(), not $input -- which matters, since a Postgres
// node also replaces the item with its result.
connect('Config', 'Postgres · Content Memory');
connect('Postgres · Content Memory', 'Build Channel List');
connect('Build Channel List', 'YT · Search Channel');
connect('YT · Search Channel', 'Flatten & Tag Domain');
connect('Flatten & Tag Domain', 'YT · Batch Statistics');
connect('YT · Batch Statistics', 'Rank & Balance Domains');
connect('Rank & Balance Domains', 'Worker · Fetch Transcripts');
connect('Worker · Fetch Transcripts', 'Worker · Research Prompt');
connect('Worker · Research Prompt', 'Prepare Research Payload');
connect('Prepare Research Payload', 'OpenRouter · Research');
connect('OpenRouter · Research', 'Parse Research');
connect('Parse Research', 'Research JSON OK?');
connect('Research JSON OK?', 'Research Ready', 0);
connect('Research JSON OK?', 'OpenRouter · Research Retry', 1);
connect('OpenRouter · Research Retry', 'Parse Research (Retry)');
connect('Parse Research (Retry)', 'Research Ready');

connect('Research Ready', 'Worker · Script Prompt');
connect('Worker · Script Prompt', 'Prepare Script Payload');
connect('Prepare Script Payload', 'OpenRouter · Script');
connect('OpenRouter · Script', 'Parse Script');
connect('Parse Script', 'Script JSON OK?');
connect('Script JSON OK?', 'Script Ready', 0);
connect('Script JSON OK?', 'OpenRouter · Script Retry', 1);
connect('OpenRouter · Script Retry', 'Parse Script (Retry)');
connect('Parse Script (Retry)', 'Script Ready');

// --- editorial gate -------------------------------------------------------
connect('Script Ready', 'Worker · Verifier Prompt');
connect('Worker · Verifier Prompt', cycle1.checksName);
connect(cycle1.gateName, 'Needs Revision?');
// IF output 0 = true (revise), output 1 = false (clean)
connect('Needs Revision?', 'Prepare Revision', 0);
connect('Needs Revision?', 'Script Approved', 1);
connect('Prepare Revision', 'OpenRouter · Script Revise');
connect('OpenRouter · Script Revise', 'Parse Script (Revised)');
connect('Parse Script (Revised)', 'Revision Parsed');
connect('Revision Parsed', cycle2.checksName);
connect(cycle2.gateName, 'Script Approved');

connect('Script Approved', 'Split Keywords');
connect('Split Keywords', 'Pexels · Search Footage');
connect('Pexels · Search Footage', 'Collect Footage URLs');
connect('Collect Footage URLs', 'Worker · Render Video');
connect('Worker · Render Video', 'Wait · Render Poll');
connect('Wait · Render Poll', 'Worker · Render Status');
connect('Worker · Render Status', 'Switch · Render State');
connect('Switch · Render State', 'Worker · Download Video', 0); // done
connect('Switch · Render State', 'Render Failed', 1); // failed
connect('Switch · Render State', 'Wait · Render Poll', 2); // running -> poll again

connect('Worker · Download Video', 'YouTube · Upload Video');
connect('YouTube · Upload Video', 'Worker · Download Thumbnail', 0);
connect('YouTube · Upload Video', 'Upload Failed · Keep Artifacts', 1);
connect('Worker · Download Thumbnail', 'YouTube · Set Thumbnail');
connect('YouTube · Set Thumbnail', 'Worker · Cleanup Job');
connect('Worker · Cleanup Job', 'Final Log');

// ---------------------------------------------------------------------------
// Guards + emit
// ---------------------------------------------------------------------------
const workflow = {
  name: 'YT Cross-Domain Autopilot — AI × Radiology',
  nodes,
  connections,
  // binaryMode 'separate' keeps the rendered video on the filesystem instead of
  // in the execution record -- a ~115 MB item through the database otherwise.
  // The public REST API REJECTS this property (`settings must NOT have
  // additional properties`) even though the instance stores it happily, so
  // deploy.js strips it from the PUT payload. It is recorded here because the
  // export should describe the workflow that is actually deployed.
  settings: { executionOrder: 'v1', executionTimeout: 5400, binaryMode: 'separate' },
};

const serialized = JSON.stringify(workflow, null, 2);

// Item counts change repeatedly here (1 -> 5 -> 50 -> 1 -> 5 -> 1). Cross-node
// `.item` needs pairedItem to survive that and breaks with a misleading error
// naming the wrong node. Every referenced node holds one item, so `.first()`
// is the correct form, not a workaround.
const badRefs = serialized.match(/\)\.item\.json/g);
if (badRefs) {
  console.error(
    'REFUSING TO WRITE: found ' + badRefs.length + ' cross-node .item.json reference(s). Use .first().json'
  );
  process.exit(1);
}

// Credential ids are instance-specific; deploy.js attaches them at deploy time.
const withCreds = nodes.filter((n) => n.credentials).map((n) => n.name);
if (withCreds.length) {
  console.error('REFUSING TO WRITE: credentials blocks present on: ' + withCreds.join(', '));
  process.exit(1);
}

// An HTTP Request node REPLACES the item with its response body. A Code node
// immediately downstream that reads $input therefore gets the response, not the
// data it was written against -- and reads undefined fields with no error, so
// the run completes and reports success while the node has done nothing useful.
// This shipped once: "Script Ready -> Worker · Verifier Prompt -> Editorial
// Checks" left round 1 of the gate blind on every execution.
//
// The fix in that position is always the same: read from a NAMED node
// ($('Script Ready').first().json), not from $input.
// The check is narrow on purpose. Most Code nodes downstream of an HTTP Request
// SHOULD read $input -- that is how an API response gets parsed, and flagging
// those would be noise. The broken shape is specifically a *fetch-and-park*
// node: one whose response is collected elsewhere via $('name').first(), which
// means it sits in the chain only to fetch something and the item flowing
// through it still belongs to an earlier node. A Code node reading $input right
// after one of those is reading the wrong thing by construction.
// A Postgres node replaces the item with its query result, exactly as an HTTP
// Request node replaces it with the response body, so it belongs in the same
// check. Postgres · Content Memory sits in the data path between Config and
// Build Channel List and would break it the same way.
const REPLACES_ITEM = ['n8n-nodes-base.httpRequest', 'n8n-nodes-base.postgres'];
const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
const blindReads = [];
for (const [from, conn] of Object.entries(connections)) {
  if (!byName[from] || !REPLACES_ITEM.includes(byName[from].type)) continue;
  // Is this fetch consumed by name somewhere? Then it is a pass-through.
  if (!serialized.includes("$('" + from + "')")) continue;
  for (const port of conn.main || []) {
    for (const target of port) {
      const t = byName[target.node];
      if (!t || t.type !== 'n8n-nodes-base.code') continue;
      if (/\$input\b/.test(t.parameters.jsCode || '')) blindReads.push(from + ' -> ' + t.name);
    }
  }
}
if (blindReads.length) {
  console.error(
    'REFUSING TO WRITE: Code node reads $input directly downstream of a fetch node ' +
      'that REPLACES the item with its own result, so $input is that result and not ' +
      'the pipeline data:\n  ' +
      blindReads.join('\n  ') +
      "\nRead from a named node instead, e.g. $('Script Ready').first().json"
  );
  process.exit(1);
}

const names = nodes.map((n) => n.name);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length) {
  console.error('REFUSING TO WRITE: duplicate node names: ' + dupes.join(', '));
  process.exit(1);
}

for (const [from, conn] of Object.entries(connections)) {
  for (const port of conn.main) {
    for (const target of port) {
      if (!names.includes(target.node)) {
        console.error('REFUSING TO WRITE: connection to unknown node "' + target.node + '"');
        process.exit(1);
      }
    }
  }
}

fs.writeFileSync(OUT, serialized + '\n');
console.log('wrote ' + OUT);
console.log('  nodes:       ' + nodes.length);
console.log('  connections: ' + Object.keys(connections).length + ' source nodes');
