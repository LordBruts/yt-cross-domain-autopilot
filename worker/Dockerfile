FROM python:3.12-slim

# ffmpeg/ffprobe for assembly. Debian's build carries libass, which the burned-in
# captions need -- check `ffmpeg -filters | grep ass` before swapping the base.
# bc is not needed: all arithmetic happens in Python, not shell.
#
# KEEP THIS LINE STABLE. It pulls ~150 packages and Debian's mirror is slow
# enough from some networks that a cache miss here costs the better part of an
# hour -- adding two font packages to it once turned a seconds-long change into
# a 40-minute rebuild. Anything more volatile goes in its own layer below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Display faces, in their own layer so editing them never invalidates ffmpeg:
# Montserrat for the burned-in captions, Bebas Neue for the thumbnail title.
# Anton is the obvious pick for this look and is NOT packaged for Debian trixie
# -- verify with `apt-cache search '^fonts-'` inside the base image, never with
# packages.debian.org, which returns HTTP 200 for packages that do not exist.
# Both fall back to DejaVu Sans Bold in app.py, so an image built without them
# degrades to plain captions rather than failing the render.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fonts-montserrat fonts-bebas-neue fontconfig \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY alignment.py .
COPY app.py .
# Tests ship with the image so the fold can be exercised against the deployed
# code: docker exec yt-media-worker python -m unittest discover -s /app/tests
COPY tests/ ./tests/

ENV JOBS_ROOT=/data/jobs \
    PROMPTS_DIR=/prompts \
    TTS_VOICE=en-GB-RyanNeural \
    PYTHONUNBUFFERED=1

EXPOSE 8099
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8099"]
