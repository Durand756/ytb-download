FROM node:20-bullseye

# Installer Python3 et yt-dlp
RUN apt-get update && apt-get install -y python3-pip && pip install -U yt-dlp

WORKDIR /app
COPY . /app

RUN npm install --omit=dev

EXPOSE 3000

CMD ["npm", "start"]
