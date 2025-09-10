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
      '--get-title',
      '--get-duration', 
      '--no-warnings',
      url
    ];
    
    if (hasCookies) {
      args.unshift('--cookies', cookiesPath);
    }
    
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
        reject(new Error(`Erreur: ${error}`));
        return;
      }
      
      const lines = output.trim().split('\n');
      const title = lines[0] || 'Titre inconnu';
      const duration = lines[1] || 'Durée inconnue';
      
      resolve({ title, duration });
    });
    
    process.on('error', (err) => {
      reject(err);
    });
  });
}

// Fonction pour formater la durée
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return 'Durée inconnue';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
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
        .container { background: white; padding: 30px; border-radius: 10px; max-width: 600px; }
        input, select, button { padding: 12px; margin: 8px 0; border: 1px solid #ddd; border-radius: 5px; }
        input[type="text"] { width: 100%; box-sizing: border-box; }
        button { background: #ff0000; color: white; cursor: pointer; font-weight: bold; border: none; }
        button:hover { background: #cc0000; }
        button:disabled { background: #ccc; cursor: not-allowed; }
        .info-box { background: #e8f5e8; padding: 15px; border-radius: 5px; margin: 10px 0; display: none; }
        .error-box { background: #ffe8e8; padding: 15px; border-radius: 5px; margin: 10px 0; color: red; display: none; }
        .loading { background: #fff3cd; padding: 15px; border-radius: 5px; margin: 10px 0; display: none; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>🎬 Téléchargeur YouTube</h2>
        
        <input type="text" id="url" placeholder="Collez le lien YouTube ici..." />
        <button onclick="getInfo()">📋 Vérifier la vidéo</button>
        
        <div id="loading" class="loading">🔄 Vérification en cours...</div>
        <div id="videoInfo" class="info-box"></div>
        <div id="errorMsg" class="error-box"></div>
        
        <div id="downloadOptions" style="display: none;">
          <select id="format">
            <option value="video">📹 Vidéo (MP4)</option>
            <option value="audio">🎵 Audio (MP3)</option>
          </select>
          
          <select id="quality">
            <option value="best">🏆 Meilleure qualité</option>
            <option value="1080">📺 1080p</option>
            <option value="720">📱 720p</option>
            <option value="480">💻 480p</option>
          </select>
          
          <button onclick="download()">⬇️ Télécharger</button>
        </div>
      </div>

      <script>
        let currentUrl = '';

        function showElement(id) {
          document.getElementById(id).style.display = 'block';
        }

        function hideElement(id) {
          document.getElementById(id).style.display = 'none';
        }

        function showError(message) {
          document.getElementById('errorMsg').textContent = '❌ ' + message;
          showElement('errorMsg');
        }

        async function getInfo() {
          const url = document.getElementById('url').value.trim();
          
          if (!url) {
            showError('Veuillez entrer une URL YouTube');
            return;
          }

          if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
            showError('URL YouTube invalide');
            return;
          }

          // Reset interface
          hideElement('videoInfo');
          hideElement('errorMsg');
          hideElement('downloadOptions');
          showElement('loading');
          
          currentUrl = url;

          try {
            const response = await fetch('/info?url=' + encodeURIComponent(url));
            const data = await response.json();
            
            hideElement('loading');
            
            if (response.ok) {
              document.getElementById('videoInfo').innerHTML = 
                '<h4>📺 ' + data.title + '</h4><p>⏱️ Durée: ' + data.duration + '</p>';
              showElement('videoInfo');
              showElement('downloadOptions');
            } else {
              showError(data.error || 'Erreur lors de la vérification');
            }
          } catch (err) {
            hideElement('loading');
            showError('Erreur de connexion au serveur');
          }
        }

        function download() {
          if (!currentUrl) {
            showError('Veuillez d\'abord vérifier la vidéo');
            return;
          }
          
          const format = document.getElementById('format').value;
          const quality = document.getElementById('quality').value;
          
          const downloadUrl = '/download?url=' + encodeURIComponent(currentUrl) + 
                             '&format=' + format + '&quality=' + quality;
          
          window.open(downloadUrl, '_blank');
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

  console.log(`📋 Vérification: ${url.substring(0, 50)}...`);

  try {
    const info = await getVideoInfo(url);
    
    res.json({
      title: info.title,
      duration: formatDuration(parseInt(info.duration))
    });
    
  } catch (error) {
    console.error('❌ Erreur info:', error.message);
    res.status(500).json({ error: "Vidéo introuvable ou inaccessible" });
  }
});

// Route de téléchargement
app.get("/download", async (req, res) => {
  const { url, format, quality } = req.query;
  
  if (!url) {
    return res.status(400).send("❌ URL manquante");
  }

  console.log(`📥 Téléchargement: ${format} | ${quality}`);

  try {
    // Nom de fichier simple
    const timestamp = Date.now();
    const extension = format === 'audio' ? 'mp3' : 'mp4';
    const filename = `youtube_${timestamp}.${extension}`;

    // Headers
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', format === 'audio' ? 'audio/mpeg' : 'video/mp4');

    // Arguments yt-dlp
    let args = ['-o', '-'];
    
    if (hasCookies) {
      args.push('--cookies', cookiesPath);
    }

    if (format === 'audio') {
      args.push(
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '192K'
      );
    } else {
      let formatSelector = 'best';
      if (quality !== 'best') {
        formatSelector = `best[height<=${quality}]`;
      }
      args.push('--format', formatSelector);
    }

    args.push('--no-playlist', url);

    console.log(`🔧 Commande: yt-dlp ${args.join(' ')}`);

    // Lancer yt-dlp
    const ytProcess = spawn('yt-dlp', args);
    let hasStarted = false;

    ytProcess.stdout.on('data', (chunk) => {
      if (!hasStarted) {
        hasStarted = true;
        console.log(`📤 Début streaming: ${filename}`);
      }
      res.write(chunk);
    });

    ytProcess.stderr.on('data', (data) => {
      const error = data.toString();
      if (error.includes('ERROR:')) {
        console.error('❌ yt-dlp error:', error);
      }
    });

    ytProcess.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ Téléchargement terminé: ${filename}`);
      } else {
        console.error(`❌ Échec téléchargement (code: ${code})`);
      }
      res.end();
    });

    ytProcess.on('error', (err) => {
      console.error('💥 Erreur spawn:', err.message);
      if (!hasStarted) {
        res.status(500).send('❌ Erreur système');
      }
      res.end();
    });

  } catch (error) {
    console.error('💀 Erreur globale:', error.message);
    if (!res.headersSent) {
      res.status(500).send('❌ Erreur serveur');
    }
  }
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`🚀 Serveur YouTube Downloader démarré !`);
  console.log(`🔗 Ouvrez: http://localhost:${PORT}`);
  console.log(`📂 Cookies: ${hasCookies ? '✅ Présents' : '❌ Absents'}`);
});

process.on('SIGINT', () => {
  console.log('\n👋 Arrêt du serveur...');
  process.exit(0);
});
