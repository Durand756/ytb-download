# Utiliser Node.js LTS officiel
FROM node:18-bullseye

# Installer Python et pip pour yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Installer yt-dlp via pip (dernière version)
RUN pip3 install --upgrade yt-dlp

# Créer le répertoire de travail
WORKDIR /app

# Copier package.json et package-lock.json
COPY package*.json ./

# Installer les dépendances Node.js
RUN npm ci --only=production

# Copier le code source
COPY . .

# Créer un utilisateur non-root pour la sécurité
RUN groupadd -r appuser && useradd -r -g appuser appuser
RUN chown -R appuser:appuser /app
USER appuser

# Exposer le port (Railway l'assigne dynamiquement)
EXPOSE $PORT

# Commande de démarrage
CMD ["npm", "start"]
