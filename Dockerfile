FROM node:20-bullseye

# Installer Python 3.11, ffmpeg et yt-dlp
RUN apt-get update && \
    apt-get install -y software-properties-common ffmpeg && \
    add-apt-repository ppa:deadsnakes/ppa && \
    apt-get update && \
    apt-get install -y python3.11 python3.11-distutils python3.11-venv python3-pip && \
    update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 && \
    pip install --upgrade pip yt-dlp

WORKDIR /app
COPY . /app
RUN npm install --omit=dev

EXPOSE 3000
CMD ["npm", "start"]
