FROM node:20

# Installer ffmpeg et yt-dlp
RUN apt-get update && apt-get install -y ffmpeg python3-pip
RUN pip3 install yt-dlp

# Setup app
WORKDIR /app
COPY . .
RUN npm install

EXPOSE 3000
CMD ["npm", "start"]
