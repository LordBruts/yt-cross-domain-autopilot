# YT Cross-Domain Autopilot — AI × Radiology

A scheduled n8n pipeline that finds a real, sourced fact at the **intersection** of AI automation
and radiology, writes a **3-minute** "Did you know?" script around it, renders the video with
burned-in captions, and uploads it to YouTube. No manual trigger, no human input per run.

Voiceover is **ElevenLabs** (`eleven_multilingual_v2`) with **edge-tts** as a first-class fallback —
the ElevenLabs free tier covers about four videos a month, which is why the cadence is weekly and
why the fallback is a normal operating mode rather than an error path. See
[Voiceover](#voiceover-elevenlabs-with-edge-tts-as-a-first-class-fallback).

Two things make or break a run, and neither is visible in a green execution:

- **The intersection is the deliverable.** A generic AI tutorial fails. A generic radiology lesson
  fails. So does anything that could have been written about any hospital in any week.
- **Nothing is asserted that cannot be traced.** Every figure comes from a named article in the
  [grounding archive](#grounding-where-the-facts-come-from) and is attributed out loud, or it does
  not ship.

**Status: built, deployed, scheduled and active.** Three full runs have completed end to end.

### 3-minute / ElevenLabs change — verification status (2026-09-12)

Deployed: **54 nodes, active, no orphans, all 13 credentials attached.** Verified against the
worker over HTTP; **no full n8n run has been made since** (that costs an upload and YouTube quota,
and the first scheduled run will exercise it).

| Check | Result |
|---|---|
| Build + editorial regression suite | **pass** — includes a new boundary case at 507 words |
| Alignment unit tests (`worker/tests/`) | **13/13**, on host and in-container |
| ElevenLabs auth / voice / alignment | **pass** — 18-char probe, 3 words → 3 timings |
| Character→word fold at scale | **pass** — 66-word sample → 66 timings, 22 cues |
| Spend guard (`MAX_TTS_CHARS`) | **pass** — 9,300-char script refused in **3.6 ms**, 0 characters spent |
| Advisory ceiling ships anyway | **pass** — 450 words vs a 120 s ceiling → `over_length: true, by 22.5s`, `status: done` |
| Full render, edge provider | **pass** — 142.49 s voiceover → 142.49 s video (0.00 s drift), 5.7 MB, thumbnail 13 KB |
| Build guards (privacy / attribution / retry) | **pass** — all three verified to actually refuse |
| Clip pool at 48 | **not yet exercised** — needs a run with real Pexels URLs; watch `clips_downloaded` / `unique_clips` in `Final Log` |
| Full ElevenLabs render at target length | **not run** — deliberately: it costs ~2,610 of 10,000 monthly characters and the arithmetic is linear from the 66-word calibration |

ElevenLabs characters spent verifying: **412 of 10,000**.

**Not implemented: the HyperFrames renderer.** Rendering is still Pexels + ffmpeg with burned-in
ASS captions. See [the renderer note](#hyperframes-not-yet-implemented).

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

The schedule is **active** (weekly at 09:00) and uploads are `private`. Read the description
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
Schedule (weekly, 09:00)                      python3 · ffmpeg · ElevenLabs/edge-tts
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

## HyperFrames: not yet implemented

The intended end state is that **HeyGen HyperFrames** replaces both the ffmpeg shot assembly and
the ASS caption burn-in: one HTML composition holding the Pexels clips as `<video>` tracks, the
karaoke captions, a title card and per-section cards, rendered to MP4 in a single pass. That is a
net *simplification* — it deletes the shot loop and `build_ass()` rather than adding to them.

**None of it is in the pipeline.** Rendering is unchanged. What follows is what has been
established so far, so the work can resume without re-deriving it.

### Verified

| | |
|---|---|
| Package | `hyperframes@0.8.36` on npm, plus `@hyperframes/{core,engine,producer}` at the same version |
| Licence | Apache-2.0 — no per-render fee, no HeyGen account for local rendering |
| Runtime | `engines.node >= 22`; requires ffmpeg |
| Browser | `puppeteer-core` + `@puppeteer/browsers` — it fetches its **own** Chromium rather than using apt's, which matters because Debian's mirror is pathologically slow from this machine |
| Heavy deps | `sharp`, `onnxruntime-node` (native), `esbuild` |
| CLI | `bin/hyperframes.mjs`, plus `hyperframes-localize-fonts` |

**It is pre-1.0 (0.8.x).** Treat the composition format as unstable and pin the exact version.

### The composition schema — read out of the package, not guessed

`npx hyperframes init` produces **no output and no project** when run non-interactively, and `npx
… --help` fails on a corrupted npx cache. The schema below was instead read from
`node_modules/hyperframes/dist/templates/` and `dist/cli.js` after a local install. That is the
authoritative source; re-read it when bumping the version, because this is 0.8.x software.

A stage is a `<div>` carrying `data-composition-id`, `data-start`, `data-duration`, `data-width`,
`data-height`. Children are `class="clip"` with `data-start`, `data-duration`, `data-track-index`
(z-order / layering), `data-volume`.

**The three questions that gate the port are all answered, and all favourably:**

| Question | Answer |
|---|---|
| How is **fps** declared? | A render **option** (`options.fps`), not a stage attribute. Default **30** — already the target. |
| Does a `<video>` clip support a **source in-point**? | **Yes — `data-playback-start`**, alongside `data-playback-rate` and `data-loop`. The offset walk that stops a reused clip looking repetitive ports directly; no pre-trimmed per-shot files needed. |
| What is the **seek hook**? | A **paused GSAP timeline** published as `window.__timelines["<composition-id>"]`, driven by `.seek()`. Deterministic by construction. |

The determinism boundary still bites: any `rAF`, `setInterval` or `Date.now()` logic renders frozen
or jittering under frame-stepped capture and looks **correct** in `hyperframes preview`. Everything
animated must hang off that GSAP timeline.

**The single biggest de-risking finding:** the stock `captions.html` template drives its captions
from an array of `{ "text": ..., "start": ..., "end": ... }` — **byte-identical to the shape
`fold_characters_to_words()` already returns** and to what edge-tts produces. The word timings can
be injected verbatim, with no transformation layer and nothing new to unit-test.

Still unverified: whether `@hyperframes/producer` exposes a progress callback, and whether any
HTTP/server mode exists (none found — assume a wrapper must be written).

### The decision that gates the work

3 minutes at 30 fps is **5,400 Puppeteer frame captures**, with video decode in headless Chrome —
the slow part. The current ffmpeg path measures ~1.3× realtime. So Phase 3 is a **benchmark, not an
implementation**: a 15 s, 1920×1080, 30 fps composition containing a real Pexels clip as a `<video>`
track plus 3-word karaoke captions, run **under load** (this host swings ~5× with other containers
busy).

| 15 s bench | Extrapolated 3 min | Verdict |
|---|---|---|
| ≤ 40 s | ≤ 8 min | **Go** |
| 40–110 s | 8–22 min | Flag only; never make it the default |
| > 110 s | > 22 min | **Stop.** Keep ffmpeg, and record the number here |

A composition without video decode benchmarks the wrong thing by an order of magnitude.

### Architecture, when it happens

A **second** service in `worker/docker-compose.yml` (`node:22-bookworm-slim` + hyperframes, port
8098, `shm_size: 1gb` — Docker's 64 MB default kills headless Chrome as `Target closed`, which
reads as a composition bug), sharing the `/data/jobs` volume. The Python worker keeps owning the
job lifecycle and calls it over HTTP.

Compose creates a **user-defined network per project**, so those two sidecars resolve each other by
service name (`http://yt-hyperframes:8098`). n8n was started by a different project on the default
bridge and does **not** get that — n8n→worker stays `host.docker.internal:8099`. Do not unify them
"for consistency"; it breaks one or the other.

Keep the ffmpeg path behind a `RENDERER` knob defaulting to `ffmpeg`, and extract `plan_shots()` as
a pure function shared by both — otherwise the two paths drift apart within a few commits and
"matches the old look" quietly stops being true, invisibly, because the flag defaults away from the
new one. The thumbnail stays in ffmpeg either way.

---

## Voiceover: ElevenLabs, with edge-tts as a first-class fallback

`synthesize()` in `worker/app.py` is a dispatcher over two providers that return an **identical**
contract: an mp3 at the given path, plus word timings as `[{text, start, end}]`. Everything
downstream — the ASS caption builder, the shot planner, the mux — is unchanged and provider-blind.

**The fallback is not an error path.** The ElevenLabs free tier is 10,000 characters a *month* and
a 3-minute script is ~2,610 of them, so the quota covers **roughly 4 videos**. At a weekly cadence
(~4.33 runs/month) about one run a month runs on edge-tts by arithmetic, not by failure. Treat it
as a normal operating mode.

Fallback triggers, each recorded in `tts_fallback_reason`: no API key, no voice id, insufficient
remaining quota (checked by a free preflight against `/v1/user/subscription`), HTTP 401/403, HTTP
402, any network error, empty alignment, empty audio.

### Character-level alignment, folded to words

ElevenLabs' `/with-timestamps` endpoint returns **one timestamp per character**; the caption builder
needs one per word. `worker/alignment.py` does that fold and is the only pure, stdlib-only module in
the worker — deliberately, so `worker/tests/test_alignment.py` can exercise the **real** function
with no container and no dependencies. There is no second copy of the logic in a fixture. 13 tests,
including the negative cases that matter:

- **Use `alignment`, never `normalized_alignment`.** The normalized variant rewrites the text it
  timed — "33%" becomes "thirty three percent" — so the captions would say something different from
  the script while the audio, the duration and the upload all stayed perfect. Nothing errors; the
  only way to notice is to watch the finished video.
- **Mismatched array lengths raise rather than truncate.** `zip()` over unequal arrays stops
  silently at the shortest, which would end the captions part-way through the video — most likely
  in the back half nobody rewatches.
- Audio is written to a temp file and `os.replace()`d. Writing straight to `voiceover.mp3` and then
  falling back would leave a truncated file where the next stage expects a complete one.

### Spending guards

The free tier is small enough that a single duplicate call is 25% of the month.

- **`Worker · Render Video` has no `retryOnFail`.** A retried POST whose first attempt actually
  succeeded server-side starts a second render — a second paid synthesis, on a duplicate video
  nobody watches. A **build guard refuses to write `workflow.json`** if `retryOnFail`/`maxTries`
  reappear on that node.
- **The worker de-duplicates** by `sha256(script_text + title)` with a 1-hour TTL, so a genuine
  transport failure can be retried safely: the repeat request returns the original `job_id` with
  `deduplicated: true`.
- **`GET /tts/quota`** reports the month's spend and a `videos_remaining_estimate`. It is manual and
  is **never** called during a render — a render must not depend on a second vendor call succeeding.
- Every job records `tts_characters`.

### The silent-failure surface

A wrong voice id, a revoked key or an exhausted quota all produce a **perfectly good video** via
edge-tts. Nothing errors. The only symptoms are `tts_provider` and `tts_fallback_reason`, reported
in the job dict, in `Final Log`, and (for configuration) on `GET /health`. This is the same class as
the pre-existing silent DejaVu font fallback, and it is surfaced the same way — check it before
concluding ElevenLabs is working.

### Licensing: private uploads are a constraint, not a preference

The free tier grants **no commercial rights** and **requires attribution**. Two controls:

- `TTS_ATTRIBUTION_TEXT` is appended to the YouTube description, **conditional on
  `tts_provider === 'elevenlabs'`**. An unconditional line would credit a vendor that had nothing to
  do with a run that fell back to edge.
- A **build guard refuses to write** if `PRIVACY_STATUS` is anything but `private`, or if
  `TTS_ATTRIBUTION_TEXT` is empty. Flipping to public is then a deliberate act: pay for a plan (or
  set `TTS_PROVIDER=edge`) and remove the guard in the same commit, so the reason is recorded.

### Where the key lives

`worker/.env` only — gitignored, `env_file` in `docker-compose.yml`, `required: false` so the worker
still starts without it. **Never the n8n Config node**: Config values are written into
`workflow.json`, and that file is committed.

---

## Spec node → implementation

Every node in the original spec is accounted for. Five moved into the worker.

| Spec node | Implemented as | Note |
|---|---|---|
| 1 Schedule | `Schedule · Weekly 09:00` | `daysInterval: 7`, 09:00 Africa/Lagos |
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
| `MAX_VIDEO_SECONDS` | `180` — advisory ceiling; over-length ships anyway |
| `SPEECH_WPM` | `165` — a MEASUREMENT; drives the whole word budget |
| `VIDEO_LENGTH_MINUTES` | `3` — prose only; no word count derives from it |
| `BODY_SECTIONS` | `3` — enforced exactly (~103 words each) |
| `SHOT_SECONDS` | `4` — one new shot every 4 s |
| `FOOTAGE_KEYWORDS` | `12` — distinct search terms |
| `FOOTAGE_PER_KEYWORD` | `4` — up to 48 clips per run |
| `FOOTAGE_POOL_MAX` | `48` — was hardcoded to 10 downstream; see below |
| `FOOTAGE_MIN_DURATION` | `15` — must exceed `SHOT_SECONDS` for the offset walk |
| `TTS_ATTRIBUTION_TEXT` | appended only on ElevenLabs runs |
| `RESEARCH_MODEL` | `openai/gpt-5.6-luna` |
| `WRITER_MODEL` | `anthropic/claude-sonnet-4.5` |
| `JUDGE_MODEL` | `openai/gpt-5.6-luna` |
| `MEDIA_WORKER_URL` | `http://host.docker.internal:8099` |
| `PRIVACY_STATUS` | `private` |

The three model fields replaced a single `LLM_MODEL`. Keep `WRITER_MODEL` and `JUDGE_MODEL` on
different vendors — see [the judge](#layer-3--the-judge-editorial-verifier).

`FOOTAGE_KEYWORDS × FOOTAGE_PER_KEYWORD` is the clip pool, and `MAX_VIDEO_SECONDS / SHOT_SECONDS`
is the number of shots — at the defaults, 48 clips for ~45 shots, so most clips are used once.

**`Collect Footage URLs` used to cap that pool at a hardcoded 10** while Config advertised 48. That
is 45 shots drawn from 10 clips, each reappearing ~5 times: the exact repetition `SHOT_SECONDS` was
introduced to prevent, reintroduced two nodes downstream of it where nothing in Config hinted at it.
The cap is now `FOOTAGE_POOL_MAX`.

The offset walk that makes a reused clip show *different* footage depends on headroom
(`clip_length − shot_length`). Pexels `min_duration` was **8** against 4-second shots, leaving 4
seconds to walk before wrapping — so reuse looked far more repetitive than the design implied. It is
now `FOOTAGE_MIN_DURATION` = 15, giving 11 seconds of genuine variation.

Raising the pool raises download volume ~5× (200–400 MB), and 48 clips at the 120 s per-clip timeout
is 96 minutes inside a 90-minute execution — hence `DOWNLOAD_BUDGET_SECONDS` (420 s) as a **total**
budget. Running out degrades variety rather than failing the run. `Final Log` reports
`clips_downloaded` and `download_budget_hit`.

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

YouTube quota is comfortable at any cadence here. **The binding constraint is ElevenLabs**: the
free tier is 10,000 characters/month and a 3-minute script is ~2,610, so the quota covers about
**4 videos a month**. Weekly (~4.33 runs) is therefore the right cadence — roughly one run a month
falls back to edge-tts by arithmetic, which is what the fallback is for. Every 3 days (~10 runs)
would exhaust the month's characters in under two weeks.

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
- **`Editorial Checks` enforces both bounds** — under 70% of target *and* over the hard word
  ceiling are blocking — alongside every other ruling, so one component owns quality and there is a
  single threshold rather than two that drift apart. If it is still wrong after the revision round
  the run proceeds anyway (shipping a slightly off-length video beats discarding a whole run's
  research) and `Final Log` reports `script_word_count` and `script_word_target`.
- The format is now **3 minutes**, derived rather than declared — see below.
- `WRITER_MODEL` is `anthropic/claude-sonnet-4.5`. This is the main reason the per-run cost is
  ~$0.05 rather than fractions of a cent, and it is the right place to spend it.

**Do not "save money" by pointing `WRITER_MODEL` at the judge's model.** It would collapse the
cross-vendor separation the gate depends on, and nothing in the test suite would fail.

### The 3-minute budget is DERIVED, not declared

There used to be two independent length constants and they disagreed exactly at the margin: the
writer's target was `VIDEO_LENGTH_MINUTES * 130`, while the ceiling was `target * 1.35`. At a
130 wpm assumption that permitted 183 s of speech against a 180 s intent — the gate passed scripts
the format could not hold, and looked correct doing it. Same failure class as the `|| 8` vs `|| 4`
fallback drift corrected earlier.

Now there are two inputs and everything else falls out of them:

```
MAX_VIDEO_SECONDS = 180     Config knob, advisory ceiling
SPEECH_WPM        = 165     Config knob, a MEASUREMENT

maxWords    = MAX_VIDEO_SECONDS * SPEECH_WPM / 60   -> 495   (hard, blocking)
targetWords = maxWords / 1.10                       -> 450   (what the writer is asked for)
floor       = targetWords * 0.70                    -> 315   (blocking)
perSection  = (targetWords - 140) / BODY_SECTIONS   -> ~103
```

The derivation is a single string, `LENGTH_BUDGET` in `build-workflow.js`, embedded verbatim into
both the node that instructs the writer and the node that judges the result. They cannot drift
because there is one copy. `test-editorial-checks.js` re-derives the same numbers from the live
Config, so a change to either knob moves the assertions with it.

### `SPEECH_WPM` is a measurement, and the old number was wrong

**Measured on this stack, over the wire:**

| Provider | Voice | Sample | Result |
|---|---|---|---|
| ElevenLabs `eleven_multilingual_v2` | `JBFqnCBsd6RMkjVDRZzb` | 66 words / 23.41 s | **169.2 wpm** |
| edge-tts | `en-GB-RyanNeural` | 450 words / 142.49 s | **189.5 wpm** |

The 141 wpm figure this repo previously carried (336 words → 142.7 s) is **not reproducible** and
should not be trusted. Both real providers are substantially faster.

`SPEECH_WPM` is set to **165** — deliberately below the measured 169.2, because the rate varies
with the text (numbers, abbreviations and long proper nouns all read slower than plain prose) and
the margin keeps the ceiling honest. At 165 a target script runs ~2 min 40 s and a ceiling script
~2 min 55 s.

The worker reports **`measured_wpm` on every job**, and `Final Log` surfaces it next to
`configured_wpm`. If they disagree consistently, change `SPEECH_WPM` — that is the whole point of
reporting it. Leaving it at edge's old 141 would have produced 385-word scripts that ElevenLabs
reads in 2 min 16 s: three quarters of a minute short of the format, with nothing failing to
indicate it.

### The 180-second ceiling STEERS; it does not discard

Two limits, with deliberately different severities. Conflating them is the mistake:

| Limit | Where | Severity | Purpose |
|---|---|---|---|
| `maxWords` (495) | `Editorial Checks` | **blocking** | Refuses an overlong *script*, before any TTS spend |
| `MAX_VIDEO_SECONDS` (180) | worker, post-TTS | **advisory** | Records `over_length` and ships anyway |
| `MAX_TTS_CHARS` (3200) | worker, pre-TTS | **blocking** | Spend guard, not a length gate |

A run that lands at 3:08 **still uploads**. Discarding a whole run's research, TTS spend and render
time over eight seconds of runtime is a worse outcome than a slightly long video, so the worker
records `over_length` / `over_length_by` and continues. Verified: a 450-word script against a
lowered 120 s ceiling reported `over_length: true, over_length_by: 22.5` and proceeded to assemble.

`MAX_TTS_CHARS` is the one hard stop, and it exists to protect money rather than format. Verified:
a 9,300-character runaway was refused in **3.6 ms** with **zero characters spent**.

`MAX_VIDEO_SECONDS` appears in both the Config node and the worker env, deliberately. The request
may **lower** the ceiling, never raise it (`_effective_max`) — a safety limit a workflow can talk
its way out of is not a limit.

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
