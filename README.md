# YT Cross-Domain Autopilot — AI × Radiology

A scheduled n8n pipeline that researches five YouTube channels across two domains, finds a topic at
the **intersection** of both, writes a faceless script, renders an 8-minute video, and uploads it to
YouTube. No manual trigger, no human input per run.

The **intersection is the deliverable**. If the output is a generic AI tutorial, or a generic
radiology lesson, the run has failed even when every node is green.

**Status: built, deployed, run end to end, and now scheduled and active.** An editorial gate has
since been added; its LLM layer has not yet run live.

Execution 654 completed in 9.2 minutes and uploaded a real private video. It researched 50 videos
across the 5 channels, fetched 6 transcripts, produced a cross-domain topic, wrote the script and
SEO, pulled 10 stock clips, generated the voiceover, assembled the video (0.23 s drift) and
uploaded it.

**And it hallucinated.** The script asserted *"At our facility, we implemented an AI agent... The
result? A 30% decrease in report turnaround time"* — no facility, no deployment, no measurement —
plus *"up to 50%"* time savings, and addressed the audience as **radiologists** when they are
**radiographers**, a different profession. That video has been **deleted**.

That is what the [Editorial Gate](#the-editorial-gate) now exists to prevent. Also from that run:

- **The script was 336 words against a ~1040-word target** (a 2 m 23 s video). Now enforced by the
  gate, with a stronger writer model.
- **The custom thumbnail was not applied** — a `uploadId` vs `id` bug (fixed) and a `403` because
  the channel is not verified for custom thumbnails (needs
  [youtube.com/verify](https://www.youtube.com/verify); no workflow change will fix it).

The gate is **deployed but not yet exercised on a live run** — its deterministic layer is covered by
tests, its LLM layer is not. The schedule is now **active** (every 3 days at 09:00) and uploads are
`private`, so the first unattended run is also the gate's first real test. Read the description of
whatever it uploads: a script with surviving blocking violations is uploaded anyway, flagged, and
forced to `private` regardless of `PRIVACY_STATUS`.

---

## Why there is a sidecar container

The spec assumed n8n runs on a Linux host with `python3`, `ffmpeg` and `edge-tts` on PATH. This
instance is `n8nio/n8n:latest`, a **Docker Hardened Alpine image**, verified to have:

| | |
|---|---|
| `python3`, `ffmpeg`, `ffprobe`, `bash`, `curl` | all missing |
| `apk`, root | absent — runs as `node`, uid 1000 |
| Host filesystem | not mounted; only the `n8n_data` volume |

So the five Execute Command nodes could not run, `/scripts/` could not exist, and `{{$env.*}}` would
have read nothing. Instead of rebuilding the n8n image on every upgrade, the toolchain lives in a
**sidecar** that n8n calls over HTTP.

```
n8n container (untouched)                     yt-media-worker
──────────────────────────                    ───────────────────────────
Schedule (every 3 days, 09:00)                python3 · ffmpeg · edge-tts
  → Config (Set node)                         youtube-transcript-api
  → 5× YouTube search.list                    FastAPI on host port 8099
  → 1× videos.list (batched, 50 ids)
  → Rank + domain balance          ──HTTP──▶  POST /transcripts
  → OpenRouter research            ──HTTP──▶  GET  /prompts/research
  → OpenRouter script              ──HTTP──▶  GET  /prompts/script
  → Pexels footage search
  → Render + poll                  ──HTTP──▶  POST /render, GET /jobs/{id}
  → Download video                 ──HTTP──▶  GET  /jobs/{id}/video
  → YouTube upload (native node)
  → Thumbnail                      ──HTTP──▶  GET  /jobs/{id}/thumbnail
  → Cleanup                        ──HTTP──▶  DELETE /jobs/{id}
  → Final log
```

n8n reaches the worker at **`http://host.docker.internal:8099`** — *not* by container name. These
containers sit on Docker's default bridge, which has no embedded DNS resolver, so `http://yt-media-worker:8099`
fails with `bad address`.

---

## Folder map

| Path | What it is |
|---|---|
| `workflow.json` | The export, importable via n8n's *Import from File*. Carries **no** credentials blocks — those are instance-specific and attached at deploy time. |
| `prompts/*.txt` | The three system prompts (research, script, verifier), served to the workflow over HTTP at run time rather than baked into node parameters. Editing one needs a worker restart, not a redeploy. |
| `scripts/build-workflow.js` | Generates `workflow.json`. **Edit this, not the JSON.** |
| `scripts/deploy.js` | Create/update on the instance. `--verify` prints the live wiring. |
| `scripts/create-credentials.js` | Creates the four credentials from env vars; validates the YouTube token against Google first. |
| `scripts/run-once.js` | Triggers one full run of this schedule-only workflow. `--restore` undoes a crashed graft. |
| `scripts/test-editorial-checks.js` | Regression suite for the gate, run against the generated `workflow.json`. |
| `fixtures/` | The real hallucinated script from execution 654, used by that suite. |
| `worker/` | The sidecar: `app.py`, `Dockerfile`, `docker-compose.yml`, pinned `requirements.txt`. |
| `deploy.config.json` | Credential **IDs** only, no secrets. Gitignored (instance-specific). |
| `.wfid` | The deployed workflow ID. Gitignored. |
| `deploy.config.example.json` | Template for the above. |

---

## The Editorial Gate

The first live run published invented clinical-workflow claims to an audience of healthcare
professionals. This is the machinery that stops that recurring.

**The prompts were asking for it.** Rule 3 demanded the use case be *"SPECIFIC and REAL — not vague,
not hypothetical"* while rule 4 demanded *"insider knowledge — things you only know if you have
actually worked in both fields."* With no grounding, the only way to satisfy both is to invent. A
later length fix then asked for *"worked examples, specific tools and real numbers"* — and "real
numbers" is precisely what produced the 30% and 50% figures.

**There is no source to fact-check against.** The only "sources" are competitor video transcripts.
So the gate does not try to verify claims. It **forbids the classes of claim that would need
verifying** — a how-to channel does not need statistics to be valuable — and enforces that in three
layers, because a single gate lets one class through.

### Layer 1 — prevention

`prompts/script_prompt.txt` now opens with truthfulness rules that override everything else: an
explicit list of forbidden claims (statistics, deployment anecdotes, study results, named
institutions with outcomes, invented cases) and permitted ones (how something works, explicit
hypotheticals, anything traceable to the research payload). "Specific" is redefined as *concrete and
actionable* — a named tool, a real node type, an exact step — not a claimed outcome at a named
place. A scope-of-practice rule states that radiographers acquire images and radiologists interpret
them.

### Layer 2 — deterministic checks (`Editorial Checks`)

Free, deterministic, cannot itself hallucinate. Catches fabrication by **form**.

| Rule | Severity |
|---|---|
| `fabricated-statistic` — any percentage | blocking |
| `measured-outcome-claim` — "a 30% decrease" | blocking |
| `first-person-deployment` — "at our facility", "we implemented" | blocking |
| `unsourced-study-claim` — "a study shows", "research found" | blocking |
| `profession-confusion` — mentions of radiologists | advisory → judge adjudicates |
| `absolute-claim` — "guaranteed", "never fails" | advisory |

**There is no traceability exemption for percentages, deliberately.** Two earlier designs failed
here, and the regression test caught both. Exempting figures whose digits appear in the research
payload was useless — the payload is full of view counts and video ids, so "50" appeared somewhere
and licensed "up to 50%". Tightening it to percentages-only *still* let it through, because "50%"
genuinely appears in a competitor's transcript. That second failure is the instructive one: a
creator's unverified marketing number must not become this channel's assertion by passing through
it. So every percentage is blocked. The rule is narrow — "4 hours", "5 steps" and "400 integrations"
are untouched.

The same node owns every mechanical ruling, so one component owns quality: exactly 5 body sections ·
title ≤ 60 chars referencing AI or radiology · ≥ 70% of target length · CTA naming both audiences ·
5 Pexels keywords.

### Layer 3 — the judge (`Editorial Verifier`)

A **different vendor's** model — currently `openai/gpt-5.6-luna` judging
`anthropic/claude-sonnet-4.5`'s writing. This is the gate's central property, not a preference: a
judge sharing the writer's blind spots rubber-stamps them, so `WRITER_MODEL` and `JUDGE_MODEL` must
never be set to the same vendor. Doing so disables this layer while every test still passes.
(`RESEARCH_MODEL` may share a vendor with either — it only summarises competitor content and
asserts nothing that reaches the video.) It receives the script, the research
payload as the only permitted ground truth, and the deterministic findings to adjudicate. It rules
on what regex cannot reach: unsupported assertions, whether the script is genuinely cross-domain,
vague use cases, scope-of-practice errors, derivative content. An unparseable verdict counts as
unverified, never as approval.

### Orchestration

```
Script Ready → Editorial Checks → Editorial Verifier → Editorial Gate
                                                          ├─ clean ──────────────→ Script Approved
                                                          └─ blocking → Prepare Revision
                                                                          → Script Revise
                                                                          → Editorial Checks (Round 2)
                                                                          → Editorial Verifier (Round 2)
                                                                          → Editorial Gate (Round 2)
                                                                          → Script Approved
```

Two explicit cycles rather than a loop. A loop needs cross-run node references — `$('X').first()` on
a node that ran twice — which is exactly the ambiguity that has bitten this repo before. Two cycles
means every node runs once and `.first()` is unambiguous. The revision prompt carries the **exact
offending quotes** and a required fix; a generic "try again" produces the same fabrications with
different numbers.

`Script Approved` is the single join point. Everything downstream reads from it, never from
`Script Ready`, so no consumer can pick up the unreviewed draft.

### If violations survive

The video **still uploads** (a deliberate choice — you review everything anyway), but:

- violations are recorded in `Final Log` as `editorial_verdict`, `editorial_violations`,
  `revision_rounds`;
- a `[UNVERIFIED CLAIMS - REVIEW BEFORE PUBLISHING]` block listing each one is **prepended to the
  video description**, so it cannot be missed at review time;
- `privacyStatus` is **forced to `private`** regardless of Config. Uploads are private today, so
  this changes nothing now — it stops flagged content auto-publishing if you ever set `public`.

### Testing it

```sh
node scripts/test-editorial-checks.js
```

Extracts the check code from the **generated** `workflow.json` — so it tests what actually deploys,
not a copy that can drift — and runs it against `fixtures/hallucinated-script.json`, the real script
from execution 654 copied out of the execution payload rather than hand-written. Four cases:
the hallucinated script must be caught on every known violation (6 blocking); a clean script must
pass with **zero** blocking, because a gate that rejects everything is as useless as one that
rejects nothing; a percentage must be blocked even when the corpus contains it; and ordinary numbers
must survive.

---

## Spec node → implementation

Every node in the original spec is accounted for. Five moved into the worker.

| Spec node | Implemented as | Note |
|---|---|---|
| 1 Schedule | `Schedule · Every 3 Days 09:00` | `daysInterval: 3`, 09:00 Africa/Lagos |
| 2 Search ×5 | `Build Channel List` → `YT · Search Channel` | domain tagged by `channelId`, not position |
| 3 Statistics | `YT · Batch Statistics` → `Rank & Balance Domains` | **one** batched call, see corrections |
| 4 Transcripts | worker `POST /transcripts` | `fetch_transcripts.py` logic, incl. `domain_map` |
| 5 Research LLM | `OpenRouter · Research` (+ retry branch) | prompt fetched from file |
| 6 Script LLM | `OpenRouter · Script` (+ retry branch) | prompt fetched from file |
| 7 Pexels | `Split Keywords` → `Pexels · Search Footage` → `Collect Footage URLs` | |
| 8 edge-tts | worker `/render`, voiceover stage | `en-GB-RyanNeural` |
| 9 FFmpeg assembly | worker `/render`, assemble stage | `assemble_video.sh` logic, three bugs fixed |
| 10 Thumbnail | worker `/render`, thumbnail stage | `make_thumbnail.sh` logic, escaping fixed |
| 11 Upload | `YouTube · Upload Video` + `YouTube · Set Thumbnail` | native node does resumable upload |
| 12 Cleanup | worker `DELETE /jobs/{id}` | skipped on upload failure |
| 13 Final log | `Final Log` | Code node, not Set — see below |

### Corrections made, and why

The four `.sh` scripts from the spec are **not** shipped. As written they contain defects 2–4 below,
so shipping them would have meant shipping known-broken code. `worker/app.py` implements the same
pipeline with the bugs fixed.

1. **`search.list` returns no `viewCount`.** The spec sorts the merged array by view count
   immediately after Node 2, but that field does not exist in a search response — the sort would
   have silently ordered by nothing. Fixed by collecting all 50 ids and making **one**
   `videos.list?id=<50 ids>` call. Also 10× cheaper: 1 quota unit instead of 10.

2. **The assembled video came out far shorter than the voiceover.** `SEGMENT = duration / clips` is
   about 48s for an 8-minute script over 10 clips, but Pexels clips are typically 8–20s. `ffmpeg -t 48`
   on a 12s clip yields 12s, the concatenated video lands at ~2 minutes, and the final `-shortest`
   mux then truncates *the whole video* to match — so most of the narration is thrown away.

   Fixed by looping each clip to fill its slot, with two details that matter:

   - The loop count is **finite** — `ceil(segment / clip) - 1` — not `-1`. With an infinite
     `-stream_loop` the input never ends, and `-t` is not a reliable stop because each iteration
     restarts the input PTS; the encode ran for minutes past its target duration in testing.
   - `setpts=N/FRAME_RATE/TB` is appended to the filter chain to rebuild monotonic timestamps
     across the loop boundary, without which the repeated segments carry duplicate PTS.

   **Verified:** an 8.27s clip filling a 15.67s slot produced exactly 15.667s of video (470 frames
   at 30fps) against 15.672s of audio. Under the original script that video would have been 8.27s,
   losing 47% of the narration.

3. **`concat -c copy` glitches on mixed audio streams.** Stock clips arrive with differing or absent
   audio. Fixed by adding `-an` to the trim pass, so every segment is video-only with identical
   codec, size, fps and pixel format before the demuxer stream-copies them.

4. **`drawtext` breaks on any title containing `:` or `'`** — which SEO titles routinely do; the
   filter string would fail to parse and take the thumbnail with it. Fixed by writing the title to a
   file and using `textfile=` with `expansion=none`. FFmpeg is invoked with argv lists, never through
   a shell, so no title can break or inject anything.

5. **`{{$credentials.openRouterApi.apiKey}}` is not a real n8n expression.** It resolves to nothing
   and the call would have gone out unauthenticated. Fixed with
   `authentication: predefinedCredentialType` + `nodeCredentialType: openRouterApi`, which makes n8n
   inject the Bearer header from your existing credential.

6. **Node 11's hand-rolled OAuth + resumable upload was unnecessary.** The native YouTube node
   already streams a resumable chunked upload (256KB chunks via `getBinaryStream`) and refreshes
   tokens itself. Only `thumbnails/set` remains an HTTP Request.

7. **Secrets moved from env vars into the n8n credential store.** Env vars would have required
   destroying and recreating the n8n container that 20 other workflows depend on, and this repo's
   rules put secrets in the credential system regardless.

8. **`Final Log` is a Code node, not a Set node.** Several upstream nodes run with
   `onError: continueRegularOutput`, and in n8n that flag rides along on the item and diverts later
   nodes that have an error output. Rebuilding the item in a Code node drops it.

---

## Setup

### 1. Start the media worker

Requires Docker. Nothing is installed on the host itself.

```sh
cd workflows/yt-cross-domain-autopilot/worker
docker compose up -d --build
curl http://localhost:8099/health
```

Expect `"ok": true` with paths for `ffmpeg`, `ffprobe` and `edge-tts`, non-zero sizes for both
prompts, and the DejaVu font present.

### 2. Create the credentials

Secrets are passed as environment variables on the command line and never written to a file in this
repo. `deploy.config.json` holds only opaque credential IDs.

```sh
cd workflows/yt-cross-domain-autopilot
PEXELS_API_KEY=... \
YOUTUBE_API_KEY=... \
YOUTUBE_CLIENT_ID=... \
YOUTUBE_CLIENT_SECRET=... \
YOUTUBE_REFRESH_TOKEN=... \
node scripts/create-credentials.js
```

This validates the refresh token against Google **before** creating anything, so a revoked token or
a wrong client secret fails loudly here rather than silently at 09:00 on the first run. It warns if
the granted scopes are missing `youtube.upload`.

Re-running creates duplicates — n8n's public API has no credential list endpoint to dedupe against.
Delete the old ones in the UI first if you rerun.

### 3. Build and deploy the workflow

```sh
node scripts/build-workflow.js     # regenerates workflow.json
node scripts/deploy.js             # creates or updates it on the instance
```

Edit `scripts/build-workflow.js`, never `workflow.json`. The generator refuses to write if any
cross-node `.item.json` reference appears, if two nodes share a name, or if a connection points at a
node that does not exist.

To import by hand instead: n8n → **Workflows** → **Import from File** → `workflow.json`, then
reattach the four credentials (they are deliberately absent from the committed export).

**Pointing the scripts at your instance.** `deploy.js`, `run-once.js` and `create-credentials.js`
read `N8N_API_URL` and `N8N_API_KEY` from the environment:

```sh
N8N_API_URL=http://localhost:5678 N8N_API_KEY=... node scripts/deploy.js
```

Without them they fall back to a `.mcp.json` two directories up, which exists only in the builder
folder this was developed in. In a standalone clone, set the two variables.

**One setting the API cannot carry.** `workflow.json` declares
`settings.binaryMode: "separate"`, which keeps the ~115 MB rendered video on the filesystem instead
of inside the execution record. The public REST API rejects that property outright
(`settings must NOT have additional properties`), so `deploy.js` strips it from the payload and n8n
preserves whatever the instance already had. On a **first** deploy to a fresh instance it will not
be set — turn it on in the workflow's Settings panel, or the first render will push a very large
binary through the database.

### 4. Configure

Open the **Config** node. Everything non-secret lives there, editable in the UI with no restart:

| Field | Default |
|---|---|
| `CHANNEL_AI_1..3` | Nate Herk, Liam Ottley, Cole Medin |
| `CHANNEL_RADIOLOGY_1..2` | Radiology Channel, Radiology Tutorials |
| `CHANNEL_*_DOMAIN` | `AI automation` / `radiology/healthcare` |
| `NICHE_CONTEXT`, `TARGET_AUDIENCE` | as specified |
| `VIDEO_LENGTH_MINUTES` | `8` |
| `RESEARCH_MODEL` | `openai/gpt-5.6-luna` |
| `WRITER_MODEL` | `anthropic/claude-sonnet-4.5` |
| `JUDGE_MODEL` | `openai/gpt-5.6-luna` |
| `MEDIA_WORKER_URL` | `http://host.docker.internal:8099` |
| `PRIVACY_STATUS` | `private` |

The three model fields replaced a single `LLM_MODEL`. Keep `WRITER_MODEL` and `JUDGE_MODEL` on
different vendors — see [the judge](#layer-3--the-judge-editorial-verifier).

### 5. Run it once by hand

Open the workflow in n8n and hit **Execute Workflow**. This performs a **real upload** to your
channel.

To trigger a run headlessly instead:

```sh
node scripts/run-once.js              # run and watch to completion
node scripts/run-once.js --restore    # undo a graft left behind by a crash
```

There is no "execute workflow" endpoint in n8n's public REST API, and a *schedule-only* workflow
cannot be driven by `n8n_test_workflow` either. So this script temporarily grafts a Webhook trigger
onto the live workflow, activates it, POSTs to it, watches the execution, then removes the trigger
and deactivates — leaving the workflow exactly as it found it. It reads the live workflow and writes
it back whole, so every node keeps its credentials.

Two n8n API traps it works around, worth knowing if you write your own tooling: the executions
listing is **not ordered by recency**, and it **excludes running executions** unless you pass
`?status=running`. Together those make a run in progress look like nothing happened.

Check the result in YouTube Studio, then activate the schedule if you're happy:

```sh
curl -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" \
  http://localhost:5678/api/v1/workflows/<id>/activate
```

---

## Getting the API keys

| What | Where | Notes |
|---|---|---|
| YouTube Data API key | [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials) | Enable **YouTube Data API v3** first. Restrict it to that API. |
| YouTube OAuth client | same page → **Create credentials → OAuth client ID → Desktop app** | Gives client id + secret |
| YouTube refresh token | [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground) | Use your own client id/secret via the gear icon. Scope: `https://www.googleapis.com/auth/youtube.upload` |
| Pexels | [pexels.com/api/new](https://www.pexels.com/api/new/) | Free, 200 req/hour |
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | Already configured on this instance |

### Finding a channel ID from an @handle

The workflow needs `UC...` IDs, not handles.

```sh
curl "https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=@nateherk&key=$YOUTUBE_API_KEY"
```

Or open the channel, **View page source**, and search for `"channelId"`. The five configured
channels resolve as:

| Handle | Channel ID | Domain |
|---|---|---|
| `@nateherk` | `UC2ojq-nuP8ceeHqiroeKhBA` | AI automation |
| `@LiamOttley` | `UCui4jxDaMb53Gdh-AZUTPAg` | AI automation |
| `@ColeMedin` | `UCMwVTLZIRRUyyVrkjDpn4pA` | AI automation |
| Radiology Channel | `UCU84jkgqGncjlV5YTKIFMow` | radiology/healthcare |
| `@radiologytutorials` | `UC9Zp0PrjNbs4nwQNdkquRug` | radiology/healthcare |

---

## How the cross-domain research works

The 3 + 2 split is the whole point. A 5-channel pipeline that treated all five the same would
surface whatever is most popular overall — which, given AI channels are far larger than radiology
ones, means an all-AI top 10 and a generic AI tutorial.

So the domain label is attached at search time and **carried end to end**, and two guarantees are
enforced in `Rank & Balance Domains`:

1. **Top 10 has at least 2 from each domain.** If ranking by view count produces a skew, the
   lowest-ranked videos of the over-represented domain are displaced by the top of the
   under-represented one.
2. **The 6 transcripts fetched include at least 2 per domain.**

The research prompt then receives `ai_channel_data` and `radiology_channel_data` — and
`ai_transcripts` and `radiology_transcripts` — as **separate fields**, so the model sees two worlds
side by side rather than one undifferentiated pile, and is asked for the gap between them rather
than the best of either.

Prompts are fetched from `prompts/*.txt` over HTTP at run time, not baked into node parameters, so
editing a prompt does not mean redeploying the workflow.

### Example topics this shape produces

- Auto-triaging radiology report turnaround-time outliers with an n8n workflow and a local LLM
- Why RAG over your department's protocol PDFs beats asking ChatGPT about contrast dosing
- Building a CPD-logging agent that reads your PACS worklist so you stop backdating your portfolio
- What an AI engineer notices about a radiographer's reporting workflow that no radiographer does

---

## Cost and quota per run

| Item | Cost |
|---|---|
| Research call (`gpt-5.6-luna`, ~12k in / ~600 out) | ~$0.003 |
| Script call (`claude-sonnet-4.5`, ~2k in / ~2.5k out) | ~$0.04 |
| Judge call (`gpt-5.6-luna`, ~10k in / ~800 out) | ~$0.003 |
| edge-tts voiceover | free, no account |
| Pexels footage | free |
| YouTube Data API | free within quota |
| **Total, clean first pass** | **~$0.05** |
| **Total, one revision round** | **~$0.09** |

The script call dominates, and it is the one call worth paying for — see the length problem under
[Troubleshooting](#troubleshooting). The judge is cheap because
`gpt-5.6-luna` is an order of magnitude cheaper per token than the writer; a weak judge would be
false economy, but a cheap one from a different vendor is not.

YouTube quota, against a 10,000/day default:

| Call | Units |
|---|---|
| 5× `search.list` | 500 |
| 1× `videos.list` (batched) | 1 |
| 1× `videos.insert` | 1,600 |
| 1× `thumbnails/set` | 50 |
| **Per run** | **~2,151** |

Comfortable at every 3 days. Daily would also fit, but the same channels' top-viewed videos barely
change day to day, so topics would start repeating.

### Measured on the first live run

| | |
|---|---|
| Videos collected / analysed | 50 across 5 channels |
| Transcripts retrieved | **6 of 6** (an earlier batch was rate-limited; see Troubleshooting) |
| Topic produced | "Automating Radiology Reports with AI Agents" |
| Script | 336 words — **short**, see Troubleshooting |
| Voiceover | 142.7 s |
| Footage clips | 10 of 10 |
| Final video | 142.47 s, 115.1 MB, 1920×1080 — **0.23 s drift** vs narration |
| Upload | ✅ private, processed, category 27, tags + description applied |
| Custom thumbnail | ❌ 403 — channel not verified for custom thumbnails |
| End-to-end wall clock | 9.2 min (upload dominates) |
| Thumbnail | 88 KB |
| Render wall clock | 188 s = **1.3× realtime** |

---

## Failure behaviour

| Failure | What happens |
|---|---|
| One channel search fails | Logged, run continues on the remaining channels |
| All searches fail | `Flatten & Tag Domain` throws with the collected error messages |
| Transcripts unavailable | Per-video sentinel `transcript_unavailable`; run continues on metadata |
| Research/script JSON unparseable | One retry with a JSON-only reminder appended; then throws |
| No usable Pexels footage | Renders over a plain dark background rather than losing the script |
| Render fails | `Switch · Render State` routes to `Render Failed`, which stops with the worker's error |
| **Upload fails** | Error branch → `Upload Failed · Keep Artifacts`. **Cleanup is skipped**, so the video and thumbnail survive on the worker volume |
| Thumbnail rejected | Logged, video keeps its auto-generated thumbnail |

Recovering a failed upload's artifacts:

```sh
curl -s http://localhost:8099/jobs | python -m json.tool
curl -o recovered.mp4 http://localhost:8099/jobs/<job_id>/video
curl -o recovered.jpg http://localhost:8099/jobs/<job_id>/thumbnail
```

---

## Troubleshooting

**`bad address 'yt-media-worker'`** — something is using the container name. Use
`host.docker.internal`; the default bridge network has no DNS.

**Upload 403 `youtubeSignupRequired` / `forbidden`** — the refresh token lacks the
`youtube.upload` scope. `create-credentials.js` warns about this at creation time; regenerate the
token in the OAuth Playground with that scope selected.

**Uploaded video is stuck at `private` even though `PRIVACY_STATUS` is `public`** — YouTube forces
API uploads to private until the Google Cloud project is verified. This is a Google-side
restriction, not a workflow bug.

**The custom thumbnail is never applied** — `thumbnails/set` returns **403 "The authenticated user
doesn't have permissions to upload and set custom video thumbnails."** Custom thumbnails require a
**verified YouTube channel**; the API cannot grant what the account does not have. Verify the
channel at [youtube.com/verify](https://www.youtube.com/verify) and it starts working with no
workflow change.

Until then the video keeps YouTube's auto-generated thumbnail and the run still succeeds — the node
is wired `onError: continueRegularOutput` precisely so a cosmetic failure cannot cost you an
uploaded video. `Final Log` still reports success; check the node output if you care whether the
thumbnail landed.

**`video_url` ends in `undefined`** — fixed, but worth knowing if you edit these nodes: the n8n
YouTube node returns the new video id as **`uploadId`**, not `id`. Reading `.id` gives `undefined`,
which also makes `thumbnails/set` fail with a generic *"Internal error encountered"* that looks like
a Google outage rather than a bad parameter.

**Render never finishes** — `docker logs yt-media-worker`, and check `GET /jobs/<id>` for the
current `stage`. Measured on this host: **1.9x realtime**, i.e. 30s of wall clock for 15.7s of
finished video, which projects to **~15 minutes for a full 8-minute video**. The workflow's
`executionTimeout` is 5400s (90 min), so there is generous headroom. The poll loop has no
iteration cap, so a genuinely wedged job loops until that timeout.

If renders are too slow on your hardware, the encoder is tunable without touching code:

```yaml
environment:
  X264_PRESET: ultrafast   # default; 'veryfast' measured ~10x realtime here
  X264_CRF: "24"
```

**Transcripts sometimes all unavailable** — this is **intermittent rate limiting, not a permanent
block.** During testing YouTube returned `429 Too Many Requests` with a `google.com/sorry/` CAPTCHA
redirect for every video tried (`youtube-transcript-api` 1.x names this `IpBlocked`), and roughly an
hour later the same pipeline fetched **6 of 6 transcripts successfully** with no configuration
change. Do not treat one failed batch as a broken setup — retry before changing anything.

When it does happen, the pipeline degrades exactly as the spec requires: each video gets the
sentinel `transcript_unavailable` and research proceeds on titles, descriptions, tags and view
counts for the top 10 videos. Research quality is lower, but no run fails because of this.

The only real remedy is routing those calls through a proxy:

```yaml
# worker/docker-compose.yml
environment:
  TRANSCRIPT_PROXY: http://user:pass@host:port
```

The block may also lift on its own — it is a rate limit, not a ban. Re-test with:

```sh
curl -s -X POST http://localhost:8099/transcripts \
  -H 'Content-Type: application/json' \
  -d '{"video_ids":["sboNwYmH3AY"],"domain_map":{},"limit":1}'
```

**Voiceover fails with `WSServerHandshakeError: 403`** — edge-tts 7.0.0 and older are rejected by
Microsoft's endpoint, which now requires a `Sec-MS-GEC` token those versions do not send. Pinned to
`edge-tts==7.2.8`, which works. If it returns, upgrade the pin rather than debugging the audio.

**The video is much shorter than 8 minutes** — small models reliably under-write. On the first live
run `gpt-4o-mini` returned **336 words against a ~1040-word target**, producing 2 min 23 s of video
instead of 8 minutes. The content was on-topic and correctly cross-domain; it was simply a third of
the requested length.

Three mitigations are in place:

- The script instruction sets a **per-section word budget** ("each of the 5 body sections: 178 words
  minimum") rather than one total, and states that a short script will be regenerated. Per-section
  targets control LLM length far better than a single overall number.
- **`Editorial Checks` enforces it**, alongside every other ruling, so one component owns quality
  and there is a single threshold rather than two that drift apart. A script under 70% of target is
  flagged. If it is still short after the revision round the run proceeds anyway — shipping a
  slightly short video beats discarding a whole run's research — and `Final Log` reports
  `script_word_count` and `script_word_target`.
- `WRITER_MODEL` is `anthropic/claude-sonnet-4.5`. This is the main reason the per-run cost is
  ~$0.05 rather than fractions of a cent, and it is the right place to spend it.

**Do not "save money" by pointing `WRITER_MODEL` at the judge's model.** It would collapse the
cross-vendor separation the gate depends on, and nothing in the test suite would fail.

---

## Notes on publishing

Uploads default to `private`. Two things to know before changing that:

- **YouTube requires disclosure of synthetic/AI-generated content.** You make that declaration in
  YouTube Studio when publishing. Setting `PRIVACY_STATUS` to `public` skips the point at which a
  human would make it.
- The [editorial gate](#the-editorial-gate) blocks fabricated claims; it does not certify that the
  script is *good*. Telling a genuine cross-domain insight from a plausible sentence about one is
  still a human judgement, and a writer at temperature 0.7 will occasionally produce the latter.
  Reviewing before publishing is the whole reason `private` is the default.
