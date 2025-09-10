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

// Fonction pour obtenir les informations de la vidéo
async function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--print', '{"title": "%(title)s", "duration": "%(duration)s", "filesize": "%(filesize)s", "filesize_approx": "%(filesize_approx)s"}',
      '--no-warnings',
      url
    ];
    
    if (hasCookies) args.splice(-1, 0, '--cookies', cookiesPath);
    
    const process = spawn('yt-dlp', args);
    let output = '';
    let error = '';
    
    process.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    process.stderr.on('data', (data) => {
      error += data.toString();
    });
    
    process.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Erreur info: ${error}`));
        return;
      }
      
      try {
        const info = JSON.parse(output.trim());
        resolve(info);
      } catch (e) {
        reject(new Error('Impossible de parser les infos vidéo'));
      }
    });
    
    process.on('error', (err) => {
      reject(err);
    });
  });
}

// Fonction pour formater la taille
function formatSize(bytes) {
  if (!bytes || bytes === 'NA') return 'Taille inconnue';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

// Fonction pour formater la durée
function formatDuration(seconds) {
  if (!seconds || seconds === 'NA') return 'Durée inconnue';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hrs > 0) {
    return `${hrs}h ${mins}m ${secs}s`;
  }
  return `${mins}m ${secs}s`;
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
        body { font-family: Arial; margin: 50px; background: #f5f5f5; }
        .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        input, select, button { padding: 12px; margin: 8px 0; border: 1px solid #ddd; border-radius: 5px; }
        input[type="text"] { width: 400px; }
        button { background: #ff0000; color: white; cursor: pointer; font-weight: bold; }
        button:hover { background: #cc0000; }
        .info-box { background: #e8f5e8; padding: 15px; border-radius: 5px; margin: 10px 0; display: none; }
        .error-box { background: #ffe8e8; padding: 15px; border-radius: 5px; margin: 10px 0; color: red; display: none; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>🎬 Téléchargeur YouTube</h2>
        <form id="downloadForm">
          <input type="text" id="url" name="url" placeholder="Collez le lien YouTube ici..." required/><br/>
          <button type="button" onclick="getInfo()">📋 Vérifier la vidéo</button><br/>
          
          <div id="videoInfo" class="info-box"></div>
          <div id="errorMsg" class="error-box"></div>
          
          <select id="format" name="format">
            <option value="video">📹 Vidéo (MP4)</option>
            <option value="audio">🎵 Audio (MP3)</option>
          </select>
          <select id="quality" name="quality">
            <option value="best">🏆 Meilleure qualité</option>
            <option value="1080">📺 1080p</option>
            <option value="720">📱 720p</option>
            <option value="480">💻 480p</option>
          </select><br/>
          <button type="button" onclick="download()" id="downloadBtn" disabled>⬇️ Télécharger</button>
        </form>
      </div>

      <script>
        let videoData = null;

        async function getInfo() {
          const url = document.getElementById('url').value;
          const infoDiv = document.getElementById('videoInfo');
          const errorDiv = document.getElementById('errorMsg');
          const downloadBtn = document.getElementById('downloadBtn');
          
          if (!url) {
            showError('Veuillez entrer une URL');
            return;
          }

          infoDiv.style.display = 'none';
          errorDiv.style.display = 'none';
          downloadBtn.disabled = true;

          try {
            const response = await fetch('/info?url=' + encodeURIComponent(url));
            const data = await response.json();
            
            if (response.ok) {
              videoData = data;
              infoDiv.innerHTML = \`
                <h4>📺 \${data.title}</h4>
                <p>⏱️ Durée: \${data.duration}</p>
                <p>📦 Taille approximative: \${data.size}</p>
              \`;
              infoDiv.style.display = 'block';
              downloadBtn.disabled = false;
            } else {
              showError(data.error || 'Erreur lors de la récupération des informations');
            }
          } catch (err) {
            showError('Erreur de connexion');
          }
        }

        function showError(message) {
          const errorDiv = document.getElementById('errorMsg');
          errorDiv.textContent = message;
          errorDiv.style.display = 'block';
        }

        function download() {
          if (!videoData) {
            showError('Veuillez d\'abord vérifier la vidéo');
            return;
          }
          
          const url = document.getElementById('url').value;
          const format = document.getElementById('format').value;
          const quality = document.getElementById('quality').value;
          
          const downloadUrl = \`/download?url=\${encodeURIComponent(url)}&format=\${format}&quality=\${quality}\`;
          window.location.href = downloadUrl;
        }
      </script>
    </body>
    </html>
  `);
});

// Route pour obtenir les informations de la vidéo
app.get("/info", async (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: "URL manquante" });
  }
  
  if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
    return res.status(400).json({ error: "URL YouTube invalide" });
  }

  try {
    const info = await getVideoInfo(url);
    
    res.json({
      title: info.title || 'Titre inconnu',
      duration: formatDuration(info.duration),
      size: formatSize(info.filesize || info.filesize_approx)
    });
  } catch (error) {
    console.error('Erreur info:', error.message);
    res.status(500).json({ error: "Impossible d'obtenir les informations de la vidéo" });
  }
});

// Route de téléchargement
app.get("/download", async (req, res) => {
  const { url, format, quality } = req.query;
  
  if (!url) {
    return res.status(400).send("❌ URL manquante");
  }
  
  if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
    return res.status(400).send("❌ URL YouTube invalide");
  }

  console.log(`📥 Téléchargement: ${format} | ${quality} | ${url.substring(0, 50)}...`);

  try {
    // Obtenir le titre pour le nom de fichier
    const info = await getVideoInfo(url);
    const safeTitle = info.title.replace(/[^\w\s-]/g, '').substring(0, 50) || 'media';
    const extension = format === 'audio' ? 'mp3' : 'mp4';
    const filename = `${safeTitle}.${extension}`;

    // Headers appropriés
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    if (format === 'audio') {
      res.setHeader('Content-Type', 'audio/mpeg');
    } else {
      res.setHeader('Content-Type', 'video/mp4');
    }

    // Arguments yt-dlp
    let args = ['-o', '-'];
    
    if (hasCookies) {
      args.push('--cookies', cookiesPath);
    }

    if (format === 'audio') {
      // CORRECTION AUDIO: Forcer l'extraction audio proprement
      args.push(
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '0',  // Meilleure qualité audio
        '--embed-metadata',
        '--no-playlist'
      );
    } else {
      // CORRECTION VIDÉO: Forcer le bon format vidéo
      let formatSelector;
      
      if (quality === 'best') {
        // Meilleur format vidéo + audio disponible
        formatSelector = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
      } else {
        // Qualité spécifique
        formatSelector = `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${quality}][ext=mp4]/best[height<=${quality}]`;
      }
      
      args.push(
        '--format', formatSelector,
        '--merge-output-format', 'mp4',
        '--no-playlist'
      );
    }

    // Ajouter l'URL à la fin
    args.push(url);

    console.log(`🔧 yt-dlp ${args.join(' ')}`);

    // Lancer yt-dlp
    const ytProcess = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let hasData = false;
    let totalSize = 0;

    ytProcess.stdout.on('data', (chunk) => {
      hasData = true;
      totalSize += chunk.length;
      res.write(chunk);
    });

    ytProcess.stderr.on('data', (data) => {
      const errorMsg = data.toString();
      console.error('📛 yt-dlp stderr:', errorMsg);
      
      if (errorMsg.includes('ERROR:') && !hasData) {
        if (errorMsg.includes('Video unavailable')) {
          res.status(404).send('❌ Vidéo indisponible');
        } else if (errorMsg.includes('Private video')) {
          res.status(403).send('❌ Vidéo privée');
        } else {
          res.status(500).send('❌ Erreur de téléchargement');
        }
      }
    });

    ytProcess.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ Succès: ${filename} (${formatSize(totalSize)})`);
      } else {
        console.error(`❌ Échec (code: ${code})`);
        if (!hasData) {
          res.status(500).send('❌ Erreur de téléchargement');
        }
      }
      res.end();
    });

    ytProcess.on('error', (err) => {
      console.error('💥 Erreur processus:', err.message);
      if (!hasData) {
        res.status(500).send('❌ yt-dlp non trouvé ou erreur système');
      }
      res.end();
    });

    // Timeout sécurisé
    const timeout = setTimeout(() => {
      if (!ytProcess.killed) {
        ytProcess.kill('SIGTERM');
        console.log('⏰ Timeout - arrêt forcé');
        if (!hasData) {
          res.status(408).send('❌ Timeout');
        }
      }
    }, 900000); // 15 minutes

    ytProcess.on('close', () => {
      clearTimeout(timeout);
    });

  } catch (error) {
    console.error('💀 Erreur globale:', error.message);
    if (!res.headersSent) {
      res.status(500).send('❌ Erreur interne du serveur');
    }
  }
});

// Gestion des erreurs
app.use((err, req, res, next) => {
  console.error('🚨 Erreur Express:', err.stack);
  if (!res.headersSent) {
    res.status(500).send('❌ Erreur serveur interne');
  }
});

// Démarrage
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📂 Cookies: ${hasCookies ? '✅' : '❌'}`);
  console.log(`🔗 Interface: http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  console.log('\n👋 Arrêt du serveur...');
  process.exit(0);
});
