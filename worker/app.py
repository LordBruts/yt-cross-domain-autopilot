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
import math
import os
import shutil
import subprocess
import textwrap
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import edge_tts
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

JOBS_ROOT = Path(os.environ.get("JOBS_ROOT", "/data/jobs"))
PROMPTS_DIR = Path(os.environ.get("PROMPTS_DIR", "/prompts"))
VOICE = os.environ.get("TTS_VOICE", "en-GB-RyanNeural")
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
        "voice": VOICE,
        "jobs_tracked": len(_jobs),
    }


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
def synthesize(text: str, voice: str, out_mp3: Path) -> List[Dict[str, Any]]:
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


@app.post("/render")
def render(req: RenderRequest) -> Dict[str, Any]:
    if not req.script_text.strip():
        raise HTTPException(status_code=400, detail="script_text is empty")

    job_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    job_dir = JOBS_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

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

        voiceover = job_dir / "voiceover.mp3"
        words = synthesize(req.script_text, req.voice or VOICE, voiceover)
        duration = probe_duration(voiceover)

        subs_ass: Optional[Path] = None
        cue_count = 0
        if req.subtitles and words:
            subs_ass = job_dir / "captions.ass"
            cue_count = build_ass(words, subs_ass)
        set_job(
            job_id,
            voiceover_seconds=round(duration, 2),
            word_timings=len(words),
            caption_cues=cue_count,
        )

        # -- 2. footage ------------------------------------------------------
        set_job(job_id, stage="download")
        clips_dir = job_dir / "clips"
        clips_dir.mkdir(exist_ok=True)
        clips: List[Path] = []
        with httpx.Client(timeout=120.0, follow_redirects=True) as client:
            for i, url in enumerate(req.footage_urls):
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
        set_job(job_id, clips_downloaded=len(clips))

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
        run(mux, timeout=int(max(900, duration * 40)), cwd=str(job_dir))

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
