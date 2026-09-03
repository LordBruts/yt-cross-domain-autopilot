# YT Cross-Domain Autopilot — AI × Radiology

A scheduled n8n pipeline that finds a real, sourced fact at the **intersection** of AI automation
and radiology, writes a 4-minute "Did you know?" script around it, renders the video with burned-in
captions, and uploads it to YouTube. No manual trigger, no human input per run.

Two things make or break a run, and neither is visible in a green execution:

- **The intersection is the deliverable.** A generic AI tutorial fails. A generic radiology lesson
  fails. So does anything that could have been written about any hospital in any week.
- **Nothing is asserted that cannot be traced.** Every figure comes from a named article in the
  [grounding archive](#grounding-where-the-facts-come-from) and is attributed out loud, or it does
  not ship.

**Status: built, deployed, scheduled and active.** Three full runs have completed end to end.

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

The gate has since run live twice and caught real unsupported claims. But runs 655 and 656 exposed
four more problems that the gate could not have caught, because they were not violations of its
rules — they were the rules being wrong:

| Symptom | Cause |
|---|---|
| *"I Built an AI Radiology Report Writer in n8n"* — the actual SEO title of run 655 | The research step harvested competitor **title formulas** and handed them to the writer to imitate. It returned, verbatim, `"I Built the Ultimate Team of AI Agents in n8n"` and the hook style `"lead with revenue, user counts, or personal transformation"`. The pipeline was instructing itself to fabricate. |
| 10.9-minute video for an 8-minute target | Only a lower length bound was enforced. Overshoot was free. |
| Visibly repeating b-roll | `segment = duration / len(clips)` gave **65-second slots** across 10 clips, so each looped 3–6 times in place. |
| Reads generically | Nothing required the script to be anchored to anything specific, because there was nothing specific to anchor it to. |

All four are addressed below. The last one is the reason the [grounding
archive](#grounding-where-the-facts-come-from) exists.

The schedule is **active** (every 3 days at 09:00) and uploads are `private`. Read the description
of whatever it uploads: a script with surviving blocking violations is uploaded anyway, flagged, and
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
  → Postgres · Content Memory ──┐             FastAPI on host port 8099
  → 5× YouTube search.list      │
  → 1× videos.list (50 ids)     │ citable facts
  → Rank + domain balance       │  ──HTTP──▶  POST /transcripts
  → OpenRouter research  ◀──────┤  ──HTTP──▶  GET  /prompts/research
  → OpenRouter script    ◀──────┘  ──HTTP──▶  GET  /prompts/script
  → Editorial gate (x2)            ──HTTP──▶  GET  /prompts/verifier
  → Pexels footage (12 kw x 4)
  → Render + poll                  ──HTTP──▶  POST /render, GET /jobs/{id}
     (shots, TTS, captions burned in)
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

## Grounding: where the facts come from

`Postgres · Content Memory` reads the archive built by the sibling
[ai-radiography-content-engine](../ai-radiography-content-engine) project — a daily pipeline that
collects AI and radiography news, summarises it, and synthesises one cross-domain insight per run.
Measured on the live database: **886 articles, 848 summaries, 16 insights**, each carrying an outlet
name, a URL and a structured `key_findings`.

**This is the pipeline's only citable source, and that is the whole point.** Before it existed there
was nothing to fact-check against, so the gate could only ban every figure outright — which is a
safe rule and a useless one for an educational channel. Now a figure is allowed when it traces to a
stored row *and* the script names the outlet out loud.

Three things about the query are deliberate, and each fixes something that was wrong on the first
attempt:

- **It always returns exactly one row.** A Postgres node that returns zero rows stops the branch
  dead, so an empty archive would read as silence rather than "nothing found".
- **It is balanced by category**, 8 AI and 8 radiography. Ranking the whole pool by `value_score`
  returned 30 AI to 10 radiography, because the AI feeds are denser — and a cross-domain script
  cannot be written from a one-sided pile.
- **It caps each outlet at 3 rows.** Without that, OpenAI (115 rows) and Radiology Business (308)
  crowd out everything else and the video ends up sourced from two places.

The filter `key_findings NOT ILIKE '%no concrete findings%'` uses the archive's own honesty — its
summariser says so explicitly when an article carries nothing — to select only rows worth citing.

The node runs with `onError: continueRegularOutput`. If Postgres is down the run still produces a
video; it simply cannot cite anything, and the gate blocks every unattributed figure as before.

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
| `fabricated-statistic` — any percentage | blocking *(unless sourced, below)* |
| `measured-outcome-claim` — "a 30% decrease" | blocking *(unless sourced)* |
| `first-person-build` — "I built", "we created", "I automated" | blocking |
| `first-person-deployment` — "at our facility", "we implemented" | blocking |
| `unsourced-study-claim` — "a study shows", "research found" | blocking |
| `generic-filler` — "in today's video", "let's dive in" | blocking |
| `profession-confusion` — mentions of radiologists | advisory → judge adjudicates |
| `absolute-claim` — "guaranteed", "never fails" | advisory |
| `hype-cliche` — "game-changer", "revolutionize" | advisory |

`first-person-build` also runs against the **SEO title**, which was previously checked only for
length and topic — which is how *"I Built an AI Radiology Report Writer in n8n (No Code)"* shipped
as a title while the same words in the body would have been blocked.

#### The sourcing exemption, and the line it must not cross

A percentage passes only when **all** of these hold:

1. it is declared in `sourced_claims`;
2. that entry's `source_url` is a URL actually present in the Postgres archive;
3. the figure actually appears in that archive row's text;
4. the outlet name appears in the spoken line — attribution must be *audible*, not just declared.

**The exemption keys off the archive only. Competitor transcripts are never evidence.** Two earlier
designs got this wrong and the regression test caught both. Exempting figures whose digits appear in
the research payload was useless — the payload is full of view counts and video ids, so "50"
appeared somewhere and licensed "up to 50%". Tightening it to percentages-only *still* let it
through, because "50%" genuinely appears in a competitor's transcript. That second failure is the
instructive one: laundering another creator's unverified marketing number into this channel's voice
is worse than inventing one, because it arrives looking sourced. The two corpora are therefore
separate variables in the node, and `test-editorial-checks.js` has a dedicated case for it.

The rule stays narrow — "4 hours", "5 steps" and "400 integrations" are untouched, and "we can wire
this together" is not a build claim.

The same node owns every mechanical ruling, so one component owns quality: exactly `BODY_SECTIONS`
body sections · title ≤ 60 chars referencing AI or radiology · **70–135%** of target length (an
upper bound now, after a 1606-word draft shipped against a 1040 target) · CTA naming both audiences
· `FOOTAGE_KEYWORDS` **distinct** Pexels keywords, since too few or near-duplicate keywords is what
makes the finished video repeat itself.

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
from execution 654 copied out of the execution payload rather than hand-written. Four behaviour
cases: the hallucinated script must be caught on every known violation (6 blocking); a clean script
must pass with **zero** blocking, because a gate that rejects everything is as useless as one that
rejects nothing; a percentage must be blocked even when the corpus contains it; and ordinary numbers
must survive.

Plus a **wiring** group, which exists because the four above structurally could not catch the worst
bug this gate has had. They mock the node's inputs, so they test the code in isolation and pass just
as happily when the node is wired to the wrong upstream neighbour — which it was, on every run, for
the gate's entire first round. The wiring cases assert against the connection graph instead: each
round's checks must read a **named** node, must not read `$input`, and must feed its own verifier.
`$input` in the mock now throws rather than returning the script, so a regression fails loudly
instead of quietly agreeing with itself.

---

## How the video is cut and captioned

### Shots, not slots

The worker used to compute `segment = duration / len(clips)`. With 10 clips over a 653-second
voiceover that is a **65-second slot each**, and since stock clips run 10–20 seconds, every one of
them looped 3–6 times in place. The finished video looked repetitive not because the clip pool was
small but because each clip was stretched over a minute.

It now builds a **shot list**: `ceil(duration / SHOT_SECONDS)` shots, cycling the clip pool. When
the pool is smaller than the shot count a clip does come back — but at a different offset each time
(`(n × SHOT_SECONDS) mod headroom`), so the second appearance is different footage from the same
source rather than the same four seconds again.

The Pexels query enforces `min_duration=8`, so at a 4-second shot the normal path never loops at
all. The `-stream_loop` branch survives only for a clip shorter than one shot, and its loop count
stays **finite**: with `-stream_loop -1` the input never ends and `-t` is not a reliable stop,
because each iteration restarts the input PTS and the duration check can fail to trip. That was
observed directly — an encode still running minutes past a 7.8-second target.

### Captions

`edge-tts` gives word-level timings for free, but only if you ask correctly:

- The **CLI's** `--write-subtitles` emits **sentence** cues. Verified: a two-sentence sample produced
  exactly two, with overlapping timestamps. Useless for karaoke.
- The **Python API** yields word events — but only when constructed with
  `Communicate(..., boundary="WordBoundary")`. The default is `SentenceBoundary` and produces no
  word events at all, which reads as the feature being missing rather than switched off.

So the worker calls the Python API directly and gets audio plus word timings in one pass. Words are
grouped into 3-word phrases and written as ASS, with the spoken word accented via an inline colour
override rather than ASS `\k` — `\k` timing is relative to the line start and drifts once a phrase
spans a pause. ffmpeg burns them in with the `ass` filter at the mux step.

Fonts are **Montserrat** (captions) and **Bebas Neue** (thumbnail). Anton is the obvious choice for
this look and is *not packaged for Debian trixie* — check `apt-cache search '^fonts-'` in the base
image before adding a font, because `packages.debian.org` returns HTTP 200 for packages that do not
exist and proves nothing. Both faces fall back to DejaVu Sans Bold, so an un-rebuilt image degrades
to plain captions instead of failing the render.

Burning in forces a re-encode at the mux step — there is no stream-copy path through a filter.

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

   Fixed at the time by looping each clip to fill its slot. That fix was correct about the duration
   and wrong about the result — filling a 65-second slot with a 12-second clip is exactly what made
   the b-roll repeat. The slot model is gone; see [Shots, not
   slots](#shots-not-slots). Two details from it still apply:

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

9. **`Editorial Checks` reads a named node, never `$input`.** It sits downstream of
   `Worker · Verifier Prompt`, an HTTP Request node, and an HTTP Request node **replaces the item
   with its response body**. Reading `$input` there got `{ data: "<the verifier prompt text>" }` and
   no script at all.

   This shipped, and it is the most instructive failure in the project because *nothing looked
   wrong*. Round 1 of the gate reported 0 words, 0 body sections and an empty title on every single
   run, raised three blocking violations, and forced a revision that was never needed. The judge was
   blind too — its payload carried `script: undefined` — so it echoed those findings back, which is
   why the violation list came out doubled. `Prepare Revision` then told the writer *"your script
   was REJECTED"* while handing it `previous_script: undefined` and violations reading *"0 body
   sections"*. **The writer rewrote from nothing, against nonsense feedback**, which is why
   execution 656 came back with 6 body sections against a hard rule of 5, and 1606 words against a
   1040 target. A longer script means a longer voiceover, a longer render and a bigger upload, so it
   was also a large part of why runs took 36 minutes.

   Every execution still finished, uploaded, and reported `success`. Only round 2 — fed by a Code
   node — ever saw the real script.

   Fixed by reading `$('Script Ready')` and `$('Revision Parsed')` explicitly. The generator now
   **refuses to build** the shape: a Code node reading `$input` directly downstream of an HTTP
   Request node whose response is collected elsewhere by name. That combination means the fetch is a
   pass-through and the item still belongs to an earlier node. The check stays narrow deliberately —
   a Code node parsing an ordinary API response *should* read `$input`, and ten of them here do.

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
| `VIDEO_LENGTH_MINUTES` | `4` — ~520 words |
| `BODY_SECTIONS` | `4` — enforced exactly |
| `SHOT_SECONDS` | `4` — one new shot every 4 s |
| `FOOTAGE_KEYWORDS` | `12` — distinct search terms |
| `FOOTAGE_PER_KEYWORD` | `4` — up to 48 clips per run |
| `RESEARCH_MODEL` | `openai/gpt-5.6-luna` |
| `WRITER_MODEL` | `anthropic/claude-sonnet-4.5` |
| `JUDGE_MODEL` | `openai/gpt-5.6-luna` |
| `MEDIA_WORKER_URL` | `http://host.docker.internal:8099` |
| `PRIVACY_STATUS` | `private` |

The three model fields replaced a single `LLM_MODEL`. Keep `WRITER_MODEL` and `JUDGE_MODEL` on
different vendors — see [the judge](#layer-3--the-judge-editorial-verifier).

`FOOTAGE_KEYWORDS × FOOTAGE_PER_KEYWORD` is the clip pool, and `VIDEO_LENGTH_MINUTES × 60 /
SHOT_SECONDS` is the number of shots. At the defaults that is 48 clips for ~60 shots, so a clip
reappears about a dozen times — and when it does, the worker seeks to a **different offset** in it,
so the repeat is different footage from the same source. Lowering `FOOTAGE_KEYWORDS` or raising
`VIDEO_LENGTH_MINUTES` without raising the pool brings the repetition back.

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
| Research call (`gpt-5.6-luna`, ~17k in / ~600 out) | ~$0.004 |
| Script call (`claude-sonnet-4.5`, ~7k in / ~1.2k out) | ~$0.04 |
| Judge call (`gpt-5.6-luna`, ~12k in / ~800 out) | ~$0.004 |
| edge-tts voiceover | free, no account |
| Pexels footage | free |
| YouTube Data API | free within quota |
| **Total, clean first pass** | **~$0.05** |
| **Total, one revision round** | **~$0.09** |

The archive payload adds ~5k tokens to the research and script calls and ~5k to the judge; at
`gpt-5.6-luna` input pricing that is a fraction of a cent, and the 4-minute script saves more on
output than the extra context costs. The script call still dominates and is the one worth paying
for — see the length problem under [Troubleshooting](#troubleshooting). The judge is cheap because
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
finished video, which projects to **~8 minutes for a 4-minute video**, plus a caption burn-in pass
that forces a re-encode at the mux step. The workflow's
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

**The video is the wrong length** — it has gone wrong in both directions, so both are now bounded.

`gpt-4o-mini` returned **336 words against a ~1040-word target** on the first live run, producing
2 min 23 s of video. Then, after the writer was upgraded and the gate's first round was found to be
feeding it nonsense, run 656 came back at **1606 words** — 10.9 minutes for an 8-minute slot. Only a
lower bound was enforced, so overshoot cost nothing.

Four mitigations are in place:

- The script instruction sets a **per-section word budget** rather than one total. Per-section
  targets control LLM length far better than a single overall number.
- **`Editorial Checks` enforces both bounds** — under 70% *and* over 135% of target are blocking —
  alongside every other ruling, so one component owns quality and there is a single threshold rather
  than two that drift apart. If it is still wrong after the revision round the run proceeds anyway
  (shipping a slightly off-length video beats discarding a whole run's research) and `Final Log`
  reports `script_word_count` and `script_word_target`.
- `VIDEO_LENGTH_MINUTES` is **4**, so the target is ~520 words. Shorter is also cheaper and faster:
  render and upload were 29 of the 36 minutes an 8-minute run took.
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
