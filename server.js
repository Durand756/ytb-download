const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const cookiesPath = path.join(__dirname, "cookies.txt");
const hasCookies = fs.existsSync(cookiesPath);

if (!hasCookies) {
  console.warn("⚠️ Aucun fichier cookies.txt trouvé.");
}

// Page d'accueil
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Téléchargeur YouTube</title>
      <style>
        body { font-family: Arial; margin: 50px; }
        input, select, button { padding: 10px; margin: 5px; }
        input[type="text"] { width: 400px; }
      </style>
    </head>
    <body>
      <h2>🎬 Téléchargeur YouTube</h2>
      <form action="/download" method="get">
        <input type="text" name="url" placeholder="Collez le lien YouTube ici..." required/><br/>
        <select name="format" required>
          <option value="video">📹 Vidéo (MP4)</option>
          <option value="audio">🎵 Audio (MP3)</option>
        </select>
        <select name="quality">
          <option value="best">🏆 Meilleure qualité</option>
          <option value="1080">📺 1080p</option>
          <option value="720">📱 720p</option>
          <option value="480">💻 480p</option>
        </select><br/>
        <button type="submit">⬇️ Télécharger</button>
      </form>
    </body>
    </html>
  `);
});

// Route de téléchargement
app.get("/download", async (req, res) => {
  const { url, format, quality } = req.query;
  
  // Validation
  if (!url) {
    return res.status(400).send("❌ URL manquante");
  }
  
  if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
    return res.status(400).send("❌ URL YouTube invalide");
  }

  console.log(`📥 Demande: ${format} | ${quality} | ${url.substring(0, 50)}...`);

  try {
    // Obtenir les infos de la vidéo d'abord
    const infoArgs = ['--get-title', '--get-duration', url];
    if (hasCookies) infoArgs.unshift('--cookies', cookiesPath);
    
    const infoProcess = spawn('yt-dlp', infoArgs);
    let videoTitle = '';
    
    infoProcess.stdout.on('data', (data) => {
      videoTitle = data.toString().split('\n')[0].trim();
    });

    await new Promise((resolve) => {
      infoProcess.on('close', resolve);
    });

    // Nom de fichier sécurisé
    const safeTitle = videoTitle.replace(/[^\w\s-]/g, '').substring(0, 50) || 'video';
    const extension = format === 'audio' ? 'mp3' : 'mp4';
    const filename = `${safeTitle}_${Date.now()}.${extension}`;

    // Headers de réponse
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', format === 'audio' ? 'audio/mpeg' : 'video/mp4');

    // Construction des arguments yt-dlp
    let args = ['-o', '-'];
    
    if (hasCookies) {
      args.push('--cookies', cookiesPath);
    }

    if (format === 'audio') {
      // Pour l'audio: extraction + conversion MP3
      args.push(
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '192K'
      );
    } else {
      // Pour la vidéo: format vidéo + audio
      let formatSelector;
      if (quality === 'best') {
        formatSelector = 'bestvideo+bestaudio/best';
      } else {
        formatSelector = `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`;
      }
      
      args.push(
        '--format', formatSelector,
        '--merge-output-format', 'mp4'
      );
    }

    args.push(url);

    console.log(`🔧 Commande: yt-dlp ${args.join(' ')}`);

    // Lancement du processus yt-dlp
    const ytProcess = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let hasData = false;

    ytProcess.stdout.on('data', (chunk) => {
      hasData = true;
      res.write(chunk);
    });

    ytProcess.stderr.on('data', (data) => {
      const errorMsg = data.toString();
      console.error('📛 yt-dlp stderr:', errorMsg);
      
      // Gestion des erreurs spécifiques
      if (errorMsg.includes('Video unavailable')) {
        if (!hasData) res.status(404).send('❌ Vidéo indisponible');
      } else if (errorMsg.includes('Private video')) {
        if (!hasData) res.status(403).send('❌ Vidéo privée');
      }
    });

    ytProcess.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ Téléchargement réussi: ${filename}`);
      } else {
        console.error(`❌ Échec du téléchargement (code: ${code})`);
        if (!hasData) {
          res.status(500).send('❌ Erreur de téléchargement');
        }
      }
      res.end();
    });

    ytProcess.on('error', (err) => {
      console.error('💥 Erreur processus:', err.message);
      if (!hasData) {
        res.status(500).send('❌ Erreur serveur');
      }
      res.end();
    });

    // Timeout de sécurité (10 minutes)
    setTimeout(() => {
      if (!ytProcess.killed) {
        ytProcess.kill('SIGTERM');
        console.log('⏰ Timeout - processus arrêté');
        if (!hasData) {
          res.status(408).send('❌ Timeout de téléchargement');
        }
      }
    }, 600000);

  } catch (error) {
    console.error('💀 Erreur globale:', error.message);
    res.status(500).send('❌ Erreur interne');
  }
});

// Gestion des erreurs globales
app.use((err, req, res, next) => {
  console.error('🚨 Erreur Express:', err.message);
  res.status(500).send('❌ Erreur serveur');
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`🚀 Serveur YouTube Downloader démarré sur le port ${PORT}`);
  console.log(`📂 Cookies: ${hasCookies ? '✅ Trouvés' : '❌ Absents'}`);
});

// Gestion propre de l'arrêt
process.on('SIGINT', () => {
  console.log('\n👋 Arrêt du serveur...');
  process.exit(0);
});
