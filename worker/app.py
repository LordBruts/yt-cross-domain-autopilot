"""
yt-media-worker — the media toolchain for the yt-cross-domain-autopilot workflow.

Exists because the n8n container is a Docker Hardened Alpine image with no
python3, ffmpeg, ffprobe, bash or package manager, and no root to install them.
Rather than rebuild the n8n image on every upgrade, the toolchain lives here and
n8n reaches it over HTTP at host.docker.internal:8099.

Replaces spec nodes 4 (transcripts), 8 (edge-tts voiceover), 9 (ffmpeg assembly),
10 (ffmpeg thumbnail) and 12 (cleanup).

Rendering is asynchronous: POST /render returns a job_id immediately and the
caller polls GET /jobs/{id}. An 8-minute 1080p encode takes minutes, and holding
a single HTTP request open that long is needlessly fragile.
"""

import asyncio
import base64
import hashlib
import math
import os
import shutil
import subprocess
import textwrap
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import edge_tts
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

# Pure, stdlib-only, and unit-tested in tests/test_alignment.py. Lives in its
# own module so those tests need neither a container nor this file's imports.
from alignment import fold_characters_to_words

JOBS_ROOT = Path(os.environ.get("JOBS_ROOT", "/data/jobs"))
PROMPTS_DIR = Path(os.environ.get("PROMPTS_DIR", "/prompts"))
VOICE = os.environ.get("TTS_VOICE", "en-GB-RyanNeural")

# --------------------------------------------------------------------------
# text to speech
# --------------------------------------------------------------------------
# Two providers, one contract. ElevenLabs is the primary voice; edge-tts is the
# fallback and is NOT vestigial -- the ElevenLabs free tier is 10,000 characters
# a month against ~2,260 per video, so roughly every fifth weekly run has to use
# it. Treat edge as a normal operating mode, not an error path.
#
# The key lives ONLY in the environment (worker/.env, gitignored). It must never
# reach the n8n Config node: Config values are written into workflow.json, which
# is committed.
TTS_PROVIDER = os.environ.get("TTS_PROVIDER", "elevenlabs").strip().lower()
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "").strip()
ELEVENLABS_BASE = os.environ.get("ELEVENLABS_BASE", "https://api.elevenlabs.io/v1")
# A voice id, not a voice name -- the API takes the id in the URL path. List
# them with: curl -H "xi-api-key: $KEY" https://api.elevenlabs.io/v1/voices
# Default is "George", a stock voice available on the free tier.
ELEVENLABS_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb").strip()
ELEVENLABS_MODEL_ID = os.environ.get("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")
ELEVENLABS_OUTPUT_FORMAT = os.environ.get("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_128")
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# Display faces. Montserrat Black carries the burned-in captions (heavy, legible
# at a glance over busy footage) and Bebas Neue the thumbnail title (condensed
# all-caps). Both are resolved by PATH, not by name, and fall back to DejaVu Bold
# so an image built without them degrades to plain captions instead of failing
# the render.
#
# Two traps here, both hit in practice:
#   * Anton is the obvious face for this look and is NOT packaged for Debian
#     trixie. Do not reintroduce it without checking `apt-cache search '^fonts-'`
#     inside the base image.
#   * Bebas Neue installs under opentype/, not truetype/ -- listing only the
#     truetype directory makes an installed font look missing.
_CAPTION_CANDIDATES = [
    "/usr/share/fonts/truetype/montserrat/Montserrat-Black.ttf",
    "/usr/share/fonts/truetype/montserrat/Montserrat-ExtraBold.ttf",
    "/usr/share/fonts/truetype/montserrat/Montserrat-Bold.ttf",
]
_TITLE_CANDIDATES = [
    "/usr/share/fonts/opentype/bebas-neue/BebasNeue-Bold.otf",
    "/usr/share/fonts/opentype/bebas-neue/BebasNeue-Regular.otf",
    "/usr/share/fonts/opentype/bebas-neue/BebasNeue-Book.otf",
]


def _first_existing(paths: List[str], fallback: str) -> str:
    for p in paths:
        if Path(p).exists():
            return p
    return fallback


CAPTION_FONT_FILE = _first_existing(_CAPTION_CANDIDATES, FONT)
DISPLAY_FONT_FILE = _first_existing(_TITLE_CANDIDATES, FONT)
# libass resolves by FAMILY name via fontconfig, not by path, so this must be the
# family fc-match reports -- "Montserrat", not the filename.
CAPTION_FONT_NAME = (
    "Montserrat" if CAPTION_FONT_FILE != FONT else "DejaVu Sans"
)

# Caption look. Bright accent on a heavy black outline reads over any footage,
# which a translucent box does not once the b-roll is busy.
SUB_FONT_SIZE = int(os.environ.get("SUB_FONT_SIZE", "64"))
SUB_PRIMARY = os.environ.get("SUB_PRIMARY", "&H00FFFFFF")   # white  (BGR)
SUB_ACCENT = os.environ.get("SUB_ACCENT", "&H0000E5FF")     # amber  (BGR)
SUB_WORDS_PER_CUE = int(os.environ.get("SUB_WORDS_PER_CUE", "3"))
SHOT_SECONDS_DEFAULT = float(os.environ.get("SHOT_SECONDS", "4"))

WIDTH, HEIGHT, FPS = 1920, 1080, 30
MAX_TRANSCRIPT_CHARS = 3000

# --------------------------------------------------------------------------
# length budget
# --------------------------------------------------------------------------
# Two limits with DELIBERATELY different severities. Conflating them is the
# mistake: one protects the format, the other protects money.
#
# MAX_VIDEO_SECONDS is ADVISORY. A run that lands at 3:08 still ships. The job
# records over_length and measured_wpm and carries on to upload, because
# discarding a whole run's research, TTS spend and render time over eight
# seconds of runtime is a worse outcome than a slightly long video. The real
# defence against overlong videos is the editorial gate upstream, which refuses
# a script above the word ceiling before a single character is synthesized.
MAX_VIDEO_SECONDS = float(os.environ.get("MAX_VIDEO_SECONDS", "180"))

# MAX_TTS_CHARS is BLOCKING, and it is a spend guard rather than a length gate.
# ElevenLabs' free tier is 10,000 characters a MONTH and a normal 3-minute
# script is ~2,260 of them, so one runaway draft can eat most of the budget in
# a single call. 3200 chars is ~550 words (~3.9 min) -- comfortably above
# anything the format should produce, so it only ever catches a genuine
# runaway, never a merely-long script. Checked BEFORE synthesis: the whole
# point is that a rejected script costs zero characters.
MAX_TTS_CHARS = int(os.environ.get("MAX_TTS_CHARS", "3200"))

# A wedged mux used to be able to outlive the thing meant to catch it: the
# timeout is scaled to the material (duration * 40) and at 180s that is 7200s,
# while n8n's executionTimeout is 5400s. The workflow would give up first and
# the container would keep burning CPU on an orphaned encode.
MUX_TIMEOUT_CAP = int(os.environ.get("MUX_TIMEOUT_CAP", "2400"))

# Raising the footage pool from a hardcoded 10 to 48 raises download volume
# roughly fivefold (200-400 MB). At a 120s per-clip timeout, 48 unlucky clips
# is 96 minutes of downloading inside a 90-minute execution -- so the per-clip
# timeout needs a total budget above it. Whatever has arrived when the budget
# expires is what the video is built from; clips are optional by design and the
# assembler already handles a short pool.
DOWNLOAD_BUDGET_SECONDS = float(os.environ.get("DOWNLOAD_BUDGET_SECONDS", "420"))

# Encoding an 8-minute 1080p30 video is the slowest thing this service does, and
# it is the one step that can push a run past n8n's execution timeout. Measured
# on this host (shared with 7 other containers): 'veryfast' ran ~10x slower than
# realtime, which extrapolates to ~80 minutes for a full 8-minute video.
# 'ultrafast' is roughly 3x quicker for a modest bitrate cost that does not
# matter here -- the footage is stock B-roll under a voiceover, and YouTube
# re-encodes everything on upload anyway. Override if you have CPU to spare.
X264_PRESET = os.environ.get("X264_PRESET", "ultrafast")
X264_CRF = os.environ.get("X264_CRF", "24")

app = FastAPI(title="yt-media-worker", version="1.0.0")

_jobs: Dict[str, Dict[str, Any]] = {}
_lock = threading.Lock()

# fingerprint -> (job_id, created_at). Guards against a retried POST spawning a
# second paid synthesis; see the note in /render.
_render_fingerprints: Dict[str, Tuple[str, float]] = {}
RENDER_DEDUPE_TTL = float(os.environ.get("RENDER_DEDUPE_TTL", "3600"))


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def run(cmd: List[str], cwd: Optional[Path] = None, timeout: int = 1800) -> str:
    """Run a command as an argv list. Never through a shell, so a title
    containing quotes, colons or backticks cannot break or inject anything."""
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-1500:]
        raise RuntimeError("command failed: " + " ".join(cmd[:4]) + " ... -> " + tail)
    return proc.stdout


def probe_duration(path: Path) -> float:
    out = run([
        "ffprobe", "-v", "quiet", "-of", "csv=p=0",
        "-show_entries", "format=duration", str(path),
    ], timeout=120)
    return float(out.strip())


def set_job(job_id: str, **fields: Any) -> None:
    with _lock:
        entry = _jobs.setdefault(job_id, {"job_id": job_id})
        entry.update(fields)


def get_job(job_id: str) -> Dict[str, Any]:
    with _lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job_id: " + job_id)
    return job


# --------------------------------------------------------------------------
# health + prompts
# --------------------------------------------------------------------------

@app.get("/health")
def health() -> Dict[str, Any]:
    tools = {}
    for tool in ("ffmpeg", "ffprobe", "edge-tts"):
        tools[tool] = shutil.which(tool) or "MISSING"
    prompts = {}
    for name in ("research", "script", "verifier"):
        p = PROMPTS_DIR / (name + "_prompt.txt")
        prompts[name] = p.stat().st_size if p.exists() else "MISSING"
    ok = all(v != "MISSING" for v in tools.values()) and all(
        v != "MISSING" for v in prompts.values()
    )
    return {
        "ok": ok,
        "tools": tools,
        "prompts": prompts,
        # Reported explicitly because the font fallback is SILENT: an image
        # built without the display faces still renders, just in DejaVu, and
        # nothing in a successful run would tell you the captions came out
        # plain. Compare these against the intended Montserrat / Bebas Neue.
        "fonts": {
            "captions": CAPTION_FONT_FILE,
            "caption_family": CAPTION_FONT_NAME,
            "title": DISPLAY_FONT_FILE,
            "using_fallback": CAPTION_FONT_FILE == FONT or DISPLAY_FONT_FILE == FONT,
        },
        # Same reasoning as the font block above: the TTS fallback is silent by
        # design, so the configuration that decides it has to be visible here.
        # A wrong or missing voice id produces perfectly good edge-tts videos
        # forever while you believe you are paying for ElevenLabs.
        "tts": {
            "provider": TTS_PROVIDER,
            "elevenlabs_key_present": bool(ELEVENLABS_API_KEY),
            "elevenlabs_voice_id": ELEVENLABS_VOICE_ID or "MISSING",
            "elevenlabs_model_id": ELEVENLABS_MODEL_ID,
            "edge_voice": VOICE,
        },
        "limits": {
            "max_video_seconds": MAX_VIDEO_SECONDS,
            "max_tts_chars": MAX_TTS_CHARS,
            "download_budget_seconds": DOWNLOAD_BUDGET_SECONDS,
            "mux_timeout_cap": MUX_TIMEOUT_CAP,
        },
        "voice": VOICE,
        "jobs_tracked": len(_jobs),
    }


@app.get("/tts/quota")
def tts_quota() -> Dict[str, Any]:
    """Manual. Deliberately NOT called during a render.

    A render must not depend on a second vendor call succeeding -- the balance
    preflight inside the ElevenLabs path is advisory and non-fatal for exactly
    that reason. This endpoint exists so a human can check the month's spend
    before triggering a run.
    """
    if not ELEVENLABS_API_KEY:
        return {"ok": False, "error": "no ELEVENLABS_API_KEY configured"}
    try:
        resp = httpx.get(
            ELEVENLABS_BASE + "/user/subscription",
            headers={"xi-api-key": ELEVENLABS_API_KEY},
            timeout=15.0,
        )
        resp.raise_for_status()
        d = resp.json()
        used = int(d.get("character_count", 0))
        limit = int(d.get("character_limit", 0))
        return {
            "ok": True,
            "tier": d.get("tier"),
            "character_count": used,
            "character_limit": limit,
            "remaining": limit - used,
            # ~2,610 characters per video: a 450-word script (the target at
            # SPEECH_WPM 165) at ~5.8 characters per word including spaces.
            "videos_remaining_estimate": (limit - used) // 2610,
            "next_reset_unix": d.get("next_character_count_reset_unix"),
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}


@app.get("/prompts/{name}", response_class=PlainTextResponse)
def get_prompt(name: str) -> str:
    """Serve the prompt files from disk so the workflow injects them as system
    messages rather than hardcoding them in a node parameter."""
    if name not in ("research", "script", "verifier"):
        raise HTTPException(status_code=404, detail="no such prompt: " + name)
    path = PROMPTS_DIR / (name + "_prompt.txt")
    if not path.exists():
        raise HTTPException(status_code=500, detail="prompt file missing: " + str(path))
    return path.read_text(encoding="utf-8")


# --------------------------------------------------------------------------
# transcripts  (spec node 4)
# --------------------------------------------------------------------------

class TranscriptRequest(BaseModel):
    video_ids: List[str]
    domain_map: Dict[str, str] = {}
    limit: int = 6


def _fetch_one(video_id: str) -> str:
    """youtube-transcript-api changed shape at v1.0 (get_transcript -> fetch).
    Support both so a pip resolution drift does not silently break the run.

    YouTube rate-limits transcript scraping by IP and serves a CAPTCHA once it
    decides you are a bot; v1.x reports that as IpBlocked rather than a generic
    request failure. Set TRANSCRIPT_PROXY (e.g. http://user:pass@host:port) to
    route these calls through a proxy, which is the only real remedy.
    """
    from youtube_transcript_api import YouTubeTranscriptApi

    proxy = os.environ.get("TRANSCRIPT_PROXY", "").strip()

    # v1.x instance API
    if hasattr(YouTubeTranscriptApi, "fetch") or not hasattr(
        YouTubeTranscriptApi, "get_transcript"
    ):
        kwargs = {}
        if proxy:
            from youtube_transcript_api.proxies import GenericProxyConfig

            kwargs["proxy_config"] = GenericProxyConfig(http_url=proxy, https_url=proxy)
        fetched = YouTubeTranscriptApi(**kwargs).fetch(video_id)
        return " ".join(snippet.text for snippet in fetched)

    # v0.6.x classmethod API
    parts = YouTubeTranscriptApi.get_transcript(
        video_id, proxies={"http": proxy, "https": proxy} if proxy else None
    )
    return " ".join(p["text"] for p in parts)


@app.post("/transcripts")
def transcripts(req: TranscriptRequest) -> Dict[str, Any]:
    """Per-id failure is contained: an unavailable transcript yields the
    sentinel 'transcript_unavailable' and the run continues on metadata alone."""
    results: Dict[str, Any] = {}
    for video_id in req.video_ids[: req.limit]:
        domain = req.domain_map.get(video_id, "unknown")
        try:
            text = _fetch_one(video_id)
            results[video_id] = {
                "transcript": text[:MAX_TRANSCRIPT_CHARS],
                "domain": domain,
            }
        except Exception as exc:  # noqa: BLE001 - any failure degrades, never aborts
            results[video_id] = {
                "transcript": "transcript_unavailable",
                "domain": domain,
                "error": type(exc).__name__,
            }

    available = sum(
        1 for v in results.values() if v["transcript"] != "transcript_unavailable"
    )
    return {
        "transcripts": results,
        "available_count": available,
        "requested_count": len(results),
    }


# --------------------------------------------------------------------------
# render  (spec nodes 8, 9, 10)
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# voiceover + burned-in captions
# --------------------------------------------------------------------------
def _synthesize_edge(text: str, voice: str, out_mp3: Path) -> List[Dict[str, Any]]:
    """Writes the mp3 and returns word-level timings in one pass.

    Uses the edge-tts Python API rather than the CLI because the CLI's
    --write-subtitles emits SENTENCE cues (verified: a two-sentence sample
    produced exactly two, with overlapping timestamps). Karaoke captions need
    word timings, and those only appear when boundary='WordBoundary' is passed
    explicitly -- the default is SentenceBoundary and yields no word events at
    all, which looks like the feature is missing rather than switched off.

    Offsets are in 100-nanosecond ticks.
    """
    words: List[Dict[str, Any]] = []

    async def _run() -> None:
        comm = edge_tts.Communicate(text, voice, boundary="WordBoundary")
        with open(out_mp3, "wb") as fh:
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    fh.write(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    words.append({
                        "text": chunk["text"],
                        "start": chunk["offset"] / 1e7,
                        "end": (chunk["offset"] + chunk["duration"]) / 1e7,
                    })

    asyncio.run(_run())
    return words


class TTSFallback(Exception):
    """Raised when the ElevenLabs path cannot proceed and edge-tts should run.

    Carries a machine-readable reason so the job dict records WHY the fallback
    happened. A silent fallback is the dangerous case: the video comes out
    fine, so nothing looks wrong, and you can believe you are on ElevenLabs for
    months while every run is edge.
    """


def _elevenlabs_remaining() -> Optional[int]:
    """Characters left this month, or None if it cannot be determined.

    Free, and deliberately not fatal: if this call fails we simply do not know
    the balance and let the synthesis attempt proceed -- a quota problem will
    surface as a 401/402 there. Never let a secondary vendor call be the thing
    that breaks a render.
    """
    try:
        resp = httpx.get(
            ELEVENLABS_BASE + "/user/subscription",
            headers={"xi-api-key": ELEVENLABS_API_KEY},
            timeout=15.0,
        )
        resp.raise_for_status()
        data = resp.json()
        return int(data["character_limit"]) - int(data["character_count"])
    except Exception as exc:  # noqa: BLE001 - advisory only
        print("[tts] could not read ElevenLabs balance: %s" % exc, flush=True)
        return None


def _synthesize_elevenlabs(text: str, out_mp3: Path) -> List[Dict[str, Any]]:
    """Synthesize via ElevenLabs, returning edge-tts-shaped word timings.

    Raises TTSFallback for anything recoverable, so the caller can fall back to
    edge-tts rather than losing the run.
    """
    if not ELEVENLABS_API_KEY:
        raise TTSFallback("no_api_key")
    if not ELEVENLABS_VOICE_ID:
        raise TTSFallback("no_voice_id")

    # Preflight. The free tier is 10,000 characters a MONTH and a 3-minute
    # script is ~2,260, so the quota genuinely runs out -- roughly every fifth
    # weekly run. Checking first turns that from a mid-render 402 into a clean,
    # logged decision to use edge for this one.
    remaining = _elevenlabs_remaining()
    if remaining is not None and remaining < len(text):
        raise TTSFallback("insufficient_quota:%d_left_%d_needed" % (remaining, len(text)))

    try:
        resp = httpx.post(
            "%s/text-to-speech/%s/with-timestamps" % (ELEVENLABS_BASE, ELEVENLABS_VOICE_ID),
            headers={"xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json"},
            json={
                "text": text,
                "model_id": ELEVENLABS_MODEL_ID,
                "output_format": ELEVENLABS_OUTPUT_FORMAT,
            },
            timeout=300.0,
        )
    except Exception as exc:  # noqa: BLE001
        raise TTSFallback("network_error:%s" % type(exc).__name__) from exc

    if resp.status_code in (401, 403):
        raise TTSFallback("auth_failed:%d" % resp.status_code)
    if resp.status_code == 402:
        raise TTSFallback("quota_exceeded")
    if resp.status_code >= 400:
        raise TTSFallback("http_%d:%s" % (resp.status_code, resp.text[:200]))

    payload = resp.json()

    # `alignment`, never `normalized_alignment`. Normalization rewrites the text
    # it timed -- "33%" becomes "thirty three percent" -- so the captions would
    # say something different from the script while the audio, the duration and
    # the upload all stayed perfect. There is no error and nothing to notice
    # except by reading the finished video.
    align = payload.get("alignment") or {}
    chars = align.get("characters") or []
    starts = align.get("character_start_times_seconds") or []
    ends = align.get("character_end_times_seconds") or []
    if not chars:
        raise TTSFallback("empty_alignment")

    audio_b64 = payload.get("audio_base64")
    if not audio_b64:
        raise TTSFallback("empty_audio")

    words = fold_characters_to_words(chars, starts, ends)

    # Temp file then atomic replace. Writing straight to voiceover.mp3 and then
    # falling back would leave a truncated file where the next stage expects a
    # complete one.
    tmp = out_mp3.with_suffix(".el.part")
    tmp.write_bytes(base64.b64decode(audio_b64))
    os.replace(tmp, out_mp3)
    return words


def synthesize(
    text: str, voice: str, out_mp3: Path, provider: Optional[str] = None
) -> Tuple[List[Dict[str, Any]], str, Optional[str], int]:
    """Dispatch to the configured TTS provider, falling back to edge-tts.

    Returns (words, provider_used, fallback_reason, characters_charged).

    The fallback exists because the ElevenLabs free tier cannot cover a full
    month of runs: losing a whole run's research and render to an exhausted
    quota would be a far worse outcome than a week on the free voice.
    """
    chosen = (provider or TTS_PROVIDER).strip().lower()
    if chosen == "elevenlabs":
        try:
            words = _synthesize_elevenlabs(text, out_mp3)
            print("[tts] elevenlabs ok, %d characters" % len(text), flush=True)
            return words, "elevenlabs", None, len(text)
        except TTSFallback as exc:
            reason = str(exc)
            print("[tts] elevenlabs unavailable (%s) -- using edge-tts" % reason, flush=True)
        except Exception as exc:  # noqa: BLE001 - never lose a run to TTS
            reason = "unexpected:%s" % type(exc).__name__
            print("[tts] elevenlabs failed (%s) -- using edge-tts" % reason, flush=True)
    else:
        reason = None

    words = _synthesize_edge(text, voice, out_mp3)
    return words, "edge", reason, 0


def _effective_max(requested: Optional[float]) -> float:
    """The request may tighten the ceiling but never loosen it."""
    if requested is None:
        return MAX_VIDEO_SECONDS
    return min(float(requested), MAX_VIDEO_SECONDS)


def _check_tts_spend(text: str) -> None:
    """Refuse a runaway script BEFORE paying to synthesize it.

    Blocking, and deliberately set well above what the 3-minute format should
    ever produce -- this is not the length gate (that lives in the workflow's
    Editorial Checks and in the advisory measurement below). It exists so that
    a 1600-word draft, of the kind that has shipped from this pipeline before,
    costs zero ElevenLabs characters instead of most of a month's free tier.
    """
    if len(text) > MAX_TTS_CHARS:
        raise RuntimeError(
            "script is %d characters, over MAX_TTS_CHARS=%d -- refusing to synthesize. "
            "No TTS characters were spent. This is a spend guard, not the length "
            "limit: a script this long means the editorial gate upstream let "
            "something through." % (len(text), MAX_TTS_CHARS)
        )


def _ass_time(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    sec = t % 60
    return "%d:%02d:%05.2f" % (h, m, sec)


def build_ass(words: List[Dict[str, Any]], out_ass: Path) -> int:
    """Groups word timings into short phrases and writes a styled ASS file.

    Phrases of SUB_WORDS_PER_CUE keep the line short enough to read at a glance
    and give the caption a visible rhythm. Within a phrase the word currently
    being spoken is coloured, which is the karaoke effect -- done with inline
    colour overrides rather than ASS \\k, because \\k timing is relative to the
    line start and drifts once a phrase spans a pause.
    """
    if not words:
        return 0

    groups: List[List[Dict[str, Any]]] = []
    for i in range(0, len(words), SUB_WORDS_PER_CUE):
        chunk = words[i:i + SUB_WORDS_PER_CUE]
        if chunk:
            groups.append(chunk)

    header = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: %d" % WIDTH,
        "PlayResY: %d" % HEIGHT,
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, "
        "ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
        "MarginL, MarginR, MarginV, Encoding",
        # Alignment 2 = bottom centre. Outline 5 + shadow 3 is what keeps it
        # legible over bright stock footage without a background box.
        "Style: Pop,%s,%d,%s,%s,&H00000000,&H00000000,0,0,0,0,100,100,2,0,1,5,3,2,80,80,110,1"
        % (CAPTION_FONT_NAME, SUB_FONT_SIZE, SUB_PRIMARY, SUB_ACCENT),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    lines = []
    for g in groups:
        start = g[0]["start"]
        end = max(w["end"] for w in g)
        # Each word in the phrase gets its own event so the active word can be
        # accented. Events overlap in time only within their own phrase window.
        for idx, active in enumerate(g):
            seg_start = active["start"]
            seg_end = active["end"] if idx < len(g) - 1 else end
            if seg_end <= seg_start:
                continue
            parts = []
            for j, w in enumerate(g):
                txt = str(w["text"]).replace("{", "(").replace("}", ")")
                if j == idx:
                    parts.append(r"{\c%s}%s{\c%s}" % (SUB_ACCENT, txt, SUB_PRIMARY))
                else:
                    parts.append(txt)
            lines.append(
                "Dialogue: 0,%s,%s,Pop,,0,0,0,,%s"
                % (_ass_time(seg_start), _ass_time(seg_end), " ".join(parts))
            )

    out_ass.write_text("\n".join(header + lines) + "\n", encoding="utf-8")
    return len(groups)


class RenderRequest(BaseModel):
    script_text: str
    footage_urls: List[str] = []
    title: str = ""
    voice: Optional[str] = None
    # One new shot every shot_seconds. The old behaviour was to divide the whole
    # voiceover by the clip count, which produced 65-second slots and looped
    # each clip inside its own slot 3-6 times.
    shot_seconds: Optional[float] = None
    subtitles: bool = True
    # The request may LOWER the ceiling, never raise it (see _effective_max).
    # A safety limit that a workflow can talk its way out of is not a limit.
    max_seconds: Optional[float] = None
    # 'edge' or 'elevenlabs'. Exists so a full end-to-end test render costs
    # ZERO ElevenLabs characters: the free tier is ~4 videos a month, and
    # burning one on a pipeline check is a bad trade. n8n never sets this --
    # production runs use the worker's configured provider.
    provider: Optional[str] = None


@app.post("/render")
def render(req: RenderRequest) -> Dict[str, Any]:
    if not req.script_text.strip():
        raise HTTPException(status_code=400, detail="script_text is empty")

    # Idempotency. n8n's HTTP Request node can retry a POST whose response was
    # lost in transit even though the server handled it fine -- and a second
    # job means a second ElevenLabs synthesis, ~2,260 characters, roughly a
    # quarter of the monthly free tier, spent invisibly on a duplicate video.
    #
    # Keyed on the script and title, which is what actually determines the
    # output. Within the TTL the same request returns the original job rather
    # than starting another.
    fingerprint = hashlib.sha256(
        (req.script_text + "\x00" + (req.title or "")).encode("utf-8")
    ).hexdigest()
    now = time.time()
    with _lock:
        prior = _render_fingerprints.get(fingerprint)
        if prior and now - prior[1] < RENDER_DEDUPE_TTL and prior[0] in _jobs:
            print(
                "[render] duplicate request for job %s -- returning it unchanged" % prior[0],
                flush=True,
            )
            return {"job_id": prior[0], "status": _jobs[prior[0]].get("status"), "deduplicated": True}

    job_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    job_dir = JOBS_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    with _lock:
        _render_fingerprints[fingerprint] = (job_id, now)

    set_job(
        job_id,
        status="running",
        stage="queued",
        created_at=time.time(),
        title=req.title,
        error=None,
    )
    threading.Thread(
        target=_render_job, args=(job_id, job_dir, req), daemon=True
    ).start()
    return {"job_id": job_id, "status": "running"}


def _render_job(job_id: str, job_dir: Path, req: RenderRequest) -> None:
    try:
        # -- 1. voiceover (spec node 8) --------------------------------------
        set_job(job_id, stage="voiceover")
        script_path = job_dir / "script.txt"
        script_path.write_text(req.script_text, encoding="utf-8")

        max_seconds = _effective_max(req.max_seconds)
        _check_tts_spend(req.script_text)

        voiceover = job_dir / "voiceover.mp3"
        words, tts_provider, tts_fallback_reason, tts_characters = synthesize(
            req.script_text, req.voice or VOICE, voiceover, req.provider
        )
        # Recorded even on the happy path. A wrong voice id falls back to edge
        # on every single run, forever, and the only symptom is this field --
        # the video renders and uploads perfectly either way.
        set_job(
            job_id,
            tts_provider=tts_provider,
            tts_fallback_reason=tts_fallback_reason,
            tts_characters=tts_characters,
        )
        duration = probe_duration(voiceover)

        # ADVISORY, not blocking. The run continues and uploads even when it is
        # over the ceiling -- see MAX_VIDEO_SECONDS. What matters here is that
        # the overrun is RECORDED rather than discovered on YouTube.
        #
        # measured_wpm is the important field: the word budget upstream is
        # derived from an assumed speaking rate, and the only way that assumption
        # ever gets corrected is by reading the real number back off a real job.
        # edge-tts en-GB-RyanNeural measures ~141 wpm; ElevenLabs will differ,
        # and until a job reports it, nobody knows by how much.
        script_words = len(req.script_text.split())
        measured_wpm = round(script_words / duration * 60.0, 1) if duration > 0 else 0.0
        over = duration > max_seconds
        if over:
            print(
                "[%s] OVER LENGTH: %.1fs vs ceiling %.0fs (%d words at %.1f wpm) "
                "-- shipping anyway" % (job_id, duration, max_seconds, script_words, measured_wpm),
                flush=True,
            )

        subs_ass: Optional[Path] = None
        cue_count = 0
        if req.subtitles and words:
            subs_ass = job_dir / "captions.ass"
            cue_count = build_ass(words, subs_ass)
        set_job(
            job_id,
            voiceover_seconds=round(duration, 2),
            measured_wpm=measured_wpm,
            script_words=script_words,
            max_seconds=max_seconds,
            over_length=over,
            over_length_by=round(max(0.0, duration - max_seconds), 1),
            word_timings=len(words),
            caption_cues=cue_count,
        )

        # -- 2. footage ------------------------------------------------------
        set_job(job_id, stage="download")
        clips_dir = job_dir / "clips"
        clips_dir.mkdir(exist_ok=True)
        clips: List[Path] = []
        # A TOTAL budget on top of the per-clip timeout. The pool went from a
        # hardcoded 10 clips to 48, and 48 x the 120s per-clip timeout is 96
        # minutes -- longer than the whole execution. Clips are optional by
        # design (the assembler reuses what it has, and falls back to a solid
        # colour with none at all), so running out of budget degrades the
        # video's variety rather than failing the run.
        download_started = time.time()
        download_budget_hit = False
        with httpx.Client(timeout=120.0, follow_redirects=True) as client:
            for i, url in enumerate(req.footage_urls):
                if time.time() - download_started > DOWNLOAD_BUDGET_SECONDS:
                    download_budget_hit = True
                    print(
                        "[%s] download budget %.0fs exhausted after %d/%d clips"
                        % (job_id, DOWNLOAD_BUDGET_SECONDS, len(clips), len(req.footage_urls)),
                        flush=True,
                    )
                    break
                dest = clips_dir / ("clip_%02d.mp4" % i)
                try:
                    with client.stream("GET", url) as resp:
                        resp.raise_for_status()
                        with open(dest, "wb") as fh:
                            for chunk in resp.iter_bytes(1 << 16):
                                fh.write(chunk)
                    if dest.stat().st_size > 10240:
                        clips.append(dest)
                except Exception:  # noqa: BLE001 - a dead clip URL is not fatal
                    dest.unlink(missing_ok=True)
        set_job(
            job_id,
            clips_downloaded=len(clips),
            clips_requested=len(req.footage_urls),
            download_seconds=round(time.time() - download_started, 1),
            download_budget_hit=download_budget_hit,
        )

        # -- 3. trim + normalise ---------------------------------------------
        # Every segment is re-encoded to identical codec/size/fps/pix_fmt and
        # stripped of audio, so the concat demuxer can stream-copy them safely.
        # Source clips carry mismatched or absent audio streams; concatenating
        # those with -c copy glitches or fails outright.
        set_job(job_id, stage="assemble")
        base_video = job_dir / "base_video.mp4"
        vf = (
            "scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d"
            % (WIDTH, HEIGHT, WIDTH, HEIGHT)
        )

        if clips:
            # A SHOT LIST, not one slot per clip.
            #
            # The old code set segment = duration / len(clips). With 10 clips
            # over a 653-second voiceover that is a 65-second slot each, and
            # since stock clips run 10-20 seconds every one of them looped
            # 3-6 times in place. That is what made the finished video look
            # repetitive -- not a small clip pool, but each clip stretched over
            # a minute.
            #
            # Now the cut rhythm is fixed (shot_seconds) and the clips are
            # cycled. When the pool is smaller than the shot count a clip does
            # come back, but at a DIFFERENT offset each time, so the second
            # appearance is different footage from the same source rather than
            # the same few seconds again.
            shot_len = float(req.shot_seconds or SHOT_SECONDS_DEFAULT)
            shot_len = max(1.5, min(shot_len, 15.0))
            shot_count = max(1, math.ceil(duration / shot_len))

            durations: Dict[str, float] = {}
            usable: List[Path] = []
            for clip in clips:
                try:
                    d = probe_duration(clip)
                except Exception:  # noqa: BLE001 - unreadable clip, skip it
                    continue
                if d > 0.1:
                    durations[str(clip)] = d
                    usable.append(clip)

            if not usable:
                raise RuntimeError("no readable clips among %d downloads" % len(clips))

            set_job(
                job_id,
                shot_seconds=shot_len,
                shots_planned=shot_count,
                unique_clips=len(usable),
            )

            concat_list = job_dir / "concat.txt"
            reuse: Dict[str, int] = {}
            with open(concat_list, "w", encoding="utf-8") as fh:
                for shot in range(shot_count):
                    clip = usable[shot % len(usable)]
                    key = str(clip)
                    n = reuse.get(key, 0)
                    reuse[key] = n + 1
                    clip_seconds = durations[key]
                    trimmed = job_dir / ("shot_%03d.mp4" % shot)

                    # Walk further into the clip on each reuse, wrapping around
                    # whatever headroom it has beyond one shot.
                    headroom = clip_seconds - shot_len
                    start_at = (n * shot_len) % headroom if headroom > 0.2 else 0.0

                    cmd = ["ffmpeg", "-y"]
                    if clip_seconds < shot_len:
                        # Only a clip SHORTER than a single shot needs looping,
                        # which the Pexels min_duration=8 filter makes rare.
                        # The loop count stays FINITE: with -stream_loop -1 the
                        # input never ends and -t is not a reliable stop, since
                        # each iteration restarts the input PTS and the output
                        # duration check can fail to trip. Observed directly --
                        # an encode still running minutes past a 7.8s target.
                        cmd += ["-stream_loop", str(math.ceil(shot_len / clip_seconds) - 1)]
                    elif start_at > 0:
                        # Before -i so ffmpeg seeks rather than decodes-and-drops.
                        cmd += ["-ss", "%.3f" % start_at]
                    cmd += [
                        "-i", str(clip),
                        "-t", "%.3f" % shot_len,
                        "-an",
                        # setpts rebuilds monotonic timestamps after a seek or a
                        # loop boundary; without it the segments carry duplicate
                        # PTS and the muxer stalls.
                        "-vf", vf + ",setpts=N/FRAME_RATE/TB",
                        "-r", str(FPS),
                        "-c:v", "libx264", "-preset", X264_PRESET, "-crf", X264_CRF,
                        "-pix_fmt", "yuv420p",
                        str(trimmed),
                    ]
                    # Per-shot ceiling so one pathological source cannot hang
                    # the whole job the way an unbounded encode would.
                    run(cmd, timeout=120)
                    fh.write("file '" + str(trimmed) + "'\n")

            run([
                "ffmpeg", "-y", "-f", "concat", "-safe", "0",
                "-i", str(concat_list), "-c", "copy", str(base_video),
            ])
        else:
            # No usable footage: fall back to a plain dark background rather
            # than failing a run that already has a good script and voiceover.
            run([
                "ffmpeg", "-y",
                "-f", "lavfi",
                "-i", "color=c=0x101418:s=%dx%d:r=%d" % (WIDTH, HEIGHT, FPS),
                "-t", "%.3f" % duration,
                "-c:v", "libx264", "-preset", X264_PRESET, "-crf", "28",
                "-pix_fmt", "yuv420p",
                str(base_video),
            ])

        # -- 4. mux voiceover, burning in captions ----------------------------
        final_video = job_dir / "final_video.mp4"
        mux = [
            "ffmpeg", "-y",
            "-i", str(base_video),
            "-i", str(voiceover),
            "-map", "0:v", "-map", "1:a",
        ]
        if subs_ass is not None and cue_count:
            set_job(job_id, stage="captions")
            # The ass filter takes a path, and ffmpeg's filter parser treats
            # ':' and '\' as syntax -- on this platform the job dir is a plain
            # POSIX path inside the container, but chdir + a bare filename
            # removes the question entirely. Burning in forces a re-encode;
            # there is no copy path for a filter.
            mux += [
                "-vf", "ass=" + subs_ass.name,
                "-c:v", "libx264", "-preset", X264_PRESET, "-crf", X264_CRF,
                "-pix_fmt", "yuv420p",
            ]
        else:
            mux += ["-c:v", "copy"]
        mux += [
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            "-movflags", "+faststart",
            str(final_video),
        ]
        # Scaled to the material, not a flat cap. Burning in captions forces a
        # full second encode of the whole video (no filter has a stream-copy
        # path), and measured throughput swings wildly with host load: 1.9x
        # realtime idle, ~9x realtime while an image build was running. A flat
        # 1800s cap killed a 16-second test render under that load, which reads
        # as a hung encode rather than a busy machine. 40x duration with a 15
        # minute floor covers the bad case without waiting forever on a genuinely
        # wedged job.
        # Capped at MUX_TIMEOUT_CAP: duration * 40 at 180s is 7200s, which is
        # longer than n8n's executionTimeout of 5400s -- the guard would have
        # outlived the thing it is guarding.
        run(
            mux,
            timeout=min(int(max(900, duration * 40)), MUX_TIMEOUT_CAP),
            cwd=str(job_dir),
        )

        # -- 5. thumbnail (spec node 10) --------------------------------------
        set_job(job_id, stage="thumbnail")
        _make_thumbnail(job_dir, final_video, req.title)

        set_job(
            job_id,
            status="done",
            stage="complete",
            finished_at=time.time(),
            video_seconds=round(probe_duration(final_video), 2),
            video_bytes=final_video.stat().st_size,
            thumbnail_bytes=(job_dir / "thumbnail.jpg").stat().st_size,
        )
    except Exception as exc:  # noqa: BLE001
        set_job(job_id, status="failed", error=str(exc)[:2000], finished_at=time.time())


def _make_thumbnail(job_dir: Path, video: Path, title: str) -> None:
    raw = job_dir / "raw_thumb.jpg"
    run([
        "ffmpeg", "-y", "-ss", "00:00:04", "-i", str(video),
        "-vframes", "1", str(raw),
    ])

    # drawtext reads the title from a file. Interpolating it into the filter
    # string breaks on any title containing ':' or an apostrophe -- which SEO
    # titles routinely do -- and expansion=none stops '%' being interpreted.
    lines = textwrap.wrap(title.strip() or "Untitled", width=34)[:2]
    title_file = job_dir / "title.txt"
    title_file.write_text("\n".join(lines), encoding="utf-8")

    box_h = 140 if len(lines) < 2 else 195
    text_y = "h-115" if len(lines) < 2 else "h-170"

    vf = (
        "scale=1280:720,"
        "drawbox=x=0:y=ih-" + str(box_h) + ":w=iw:h=" + str(box_h)
        + ":color=black@0.75:t=fill,"
        "drawtext=textfile='" + str(title_file) + "':expansion=none:"
        "fontcolor=white:fontsize=44:line_spacing=10:"
        "x=(w-text_w)/2:y=" + text_y + ":"
        "fontfile='" + DISPLAY_FONT_FILE + "':shadowcolor=black:shadowx=3:shadowy=3"
    )
    run(["ffmpeg", "-y", "-i", str(raw), "-vf", vf, "-q:v", "3",
         str(job_dir / "thumbnail.jpg")])


# --------------------------------------------------------------------------
# job artifacts + cleanup  (spec node 12)
# --------------------------------------------------------------------------

@app.get("/jobs")
def list_jobs() -> Dict[str, Any]:
    with _lock:
        return {"jobs": list(_jobs.values())}


@app.get("/jobs/{job_id}")
def job_status(job_id: str) -> Dict[str, Any]:
    return get_job(job_id)


@app.get("/jobs/{job_id}/video")
def job_video(job_id: str) -> FileResponse:
    get_job(job_id)
    path = JOBS_ROOT / job_id / "final_video.mp4"
    if not path.exists():
        raise HTTPException(status_code=409, detail="video not ready for " + job_id)
    return FileResponse(path, media_type="video/mp4", filename="final_video.mp4")


@app.get("/jobs/{job_id}/thumbnail")
def job_thumbnail(job_id: str) -> FileResponse:
    get_job(job_id)
    path = JOBS_ROOT / job_id / "thumbnail.jpg"
    if not path.exists():
        raise HTTPException(status_code=409, detail="thumbnail not ready for " + job_id)
    return FileResponse(path, media_type="image/jpeg", filename="thumbnail.jpg")


def _rehydrate_jobs() -> None:
    """Job state lives in memory, so without this a worker restart would orphan
    every directory on the volume: /jobs would report nothing while the files sat
    there, and an in-flight poll from n8n would start 404ing mid-run. Rebuild
    what can be known from disk at startup.

    A directory holding both artifacts is complete regardless of which process
    produced it. Anything else was interrupted by the restart and is marked
    failed, which routes the workflow to its error branch instead of hanging.
    """
    if not JOBS_ROOT.exists():
        return
    for d in sorted(JOBS_ROOT.iterdir()):
        if not d.is_dir():
            continue
        final = d / "final_video.mp4"
        thumb = d / "thumbnail.jpg"
        if final.exists() and thumb.exists():
            fields: Dict[str, Any] = {
                "status": "done",
                "stage": "complete",
                "video_bytes": final.stat().st_size,
                "thumbnail_bytes": thumb.stat().st_size,
            }
            try:
                fields["video_seconds"] = round(probe_duration(final), 2)
            except Exception:  # noqa: BLE001 - duration is nice-to-have here
                pass
            set_job(d.name, recovered_from_disk=True, **fields)
        else:
            set_job(
                d.name,
                status="failed",
                stage="interrupted",
                recovered_from_disk=True,
                error="worker restarted before this job finished",
            )


_rehydrate_jobs()


@app.delete("/jobs/{job_id}")
def delete_job(job_id: str) -> Dict[str, Any]:
    """Called only after a successful upload. A failed run is deliberately left
    on disk so final_video.mp4 and thumbnail.jpg survive for post-mortem."""
    job_dir = JOBS_ROOT / job_id
    existed = job_dir.exists()
    shutil.rmtree(job_dir, ignore_errors=True)
    with _lock:
        _jobs.pop(job_id, None)
    return {"deleted": existed, "job_id": job_id}
