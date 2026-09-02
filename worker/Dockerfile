FROM python:3.12-slim

# ffmpeg/ffprobe for assembly, fonts-dejavu-core for the thumbnail drawtext overlay.
# bc is not needed: all arithmetic happens in Python, not shell.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV JOBS_ROOT=/data/jobs \
    PROMPTS_DIR=/prompts \
    TTS_VOICE=en-GB-RyanNeural \
    PYTHONUNBUFFERED=1

EXPOSE 8099
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8099"]
