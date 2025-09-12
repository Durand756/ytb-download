FROM node:20-bullseye-slim

# Installer Python 3.11 minimal, ffmpeg et yt-dlp
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3.11-distutils ffmpeg wget ca-certificates && \
    python3.11 -m ensurepip && \
    python3.11 -m pip install --upgrade pip yt-dlp && \
    update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app
RUN npm install --omit=dev

EXPOSE 3000
CMD ["npm", "start"]
