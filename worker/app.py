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

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

JOBS_ROOT = Path(os.environ.get("JOBS_ROOT", "/data/jobs"))
PROMPTS_DIR = Path(os.environ.get("PROMPTS_DIR", "/prompts"))
VOICE = os.environ.get("TTS_VOICE", "en-GB-RyanNeural")
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

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
        "font": FONT if Path(FONT).exists() else "MISSING",
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

class RenderRequest(BaseModel):
    script_text: str
    footage_urls: List[str] = []
    title: str = ""
    voice: Optional[str] = None


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
        run([
            "edge-tts",
            "--file", str(script_path),
            "--voice", req.voice or VOICE,
            "--write-media", str(voiceover),
        ], timeout=900)
        duration = probe_duration(voiceover)
        set_job(job_id, voiceover_seconds=round(duration, 2))

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
            segment = duration / len(clips)
            concat_list = job_dir / "concat.txt"
            with open(concat_list, "w", encoding="utf-8") as fh:
                for i, clip in enumerate(clips):
                    trimmed = job_dir / ("trimmed_%02d.mp4" % i)

                    # A stock clip shorter than its slot must repeat to fill it,
                    # or the concatenated video ends up far shorter than the
                    # voiceover and the final -shortest mux truncates everything
                    # to match. Two details matter here:
                    #
                    #  * The loop count is FINITE (ceil(segment/clip) - 1), not
                    #    -1. With an infinite loop the input never ends, and -t
                    #    is not a reliable stop: each iteration restarts the
                    #    input PTS, so the output duration check can fail to
                    #    trip and ffmpeg encodes forever. Observed directly.
                    #  * setpts=N/FRAME_RATE/TB rebuilds monotonic timestamps
                    #    across the loop boundary. Without it the repeated
                    #    segments carry duplicate PTS and the muxer stalls.
                    try:
                        clip_seconds = probe_duration(clip)
                    except Exception:  # noqa: BLE001 - unreadable clip, skip it
                        continue

                    cmd = ["ffmpeg", "-y"]
                    if 0.1 < clip_seconds < segment:
                        loops = math.ceil(segment / clip_seconds) - 1
                        cmd += ["-stream_loop", str(loops)]
                    cmd += [
                        "-i", str(clip),
                        "-t", "%.3f" % segment,
                        "-an",
                        "-vf", vf + ",setpts=N/FRAME_RATE/TB",
                        "-r", str(FPS),
                        "-c:v", "libx264", "-preset", X264_PRESET, "-crf", X264_CRF,
                        "-pix_fmt", "yuv420p",
                        str(trimmed),
                    ]
                    # Per-clip ceiling so one pathological source cannot hang
                    # the whole job the way an unbounded encode would.
                    run(cmd, timeout=420)
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

        # -- 4. mux voiceover -------------------------------------------------
        final_video = job_dir / "final_video.mp4"
        run([
            "ffmpeg", "-y",
            "-i", str(base_video),
            "-i", str(voiceover),
            "-map", "0:v", "-map", "1:a",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            "-movflags", "+faststart",
            str(final_video),
        ])

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
        "fontfile='" + FONT + "':shadowcolor=black:shadowx=2:shadowy=2"
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
