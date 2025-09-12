# Étape 1 : partir d'une image Python 3.11 slim
FROM python:3.11-slim

# Installer Node.js 20, ffmpeg, wget et yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ffmpeg \
    ca-certificates \
    build-essential \
    git \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && pip install --upgrade pip yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Définir le dossier de travail
WORKDIR /app

# Copier l'application
COPY . /app

# Installer les dépendances Node.js
RUN npm install --omit=dev

# Exposer le port
EXPOSE 3000

# Commande de démarrage
CMD ["npm", "start"]
