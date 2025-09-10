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

// Fonction pour obtenir les infos vidéo
async function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--get-title',
      '--get-duration', 
      '--get-filesize',
      '--print-json'
    ];
    
    if (hasCookies) args.unshift('--cookies', cookiesPath);
    args.push(url);

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
      if (code === 0) {
        try {
          const lines = output.trim().split('\n');
          const jsonLine = lines.find(line => line.startsWith('{'));
          const info = jsonLine ? JSON.parse(jsonLine) : {};
          
          resolve({
            title: info.title || 'video',
            duration: info.duration || 0,
            filesize: info.filesize || info.filesize_approx || 0,
            formats: info.formats || []
          });
        } catch (e) {
          reject(new Error('Impossible de parser les infos vidéo'));
        }
      } else {
        reject(new Error(error || 'Erreur lors de la récupération des infos'));
      }
    });
  });
}

// Fonction pour formater la taille
function formatFileSize(bytes) {
  if (!bytes) return 'Taille inconnue';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

// Page d'accueil avec aperçu des tailles
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Téléchargeur YouTube</title>
      <style>
        body { font-family: Arial; margin: 50px; background: #f5f5f5; }
        .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        input, select, button { padding: 12px; margin: 8px 0; border: 1px solid #ddd; border-radius: 5px; }
        input[type="text"] { width: 100%; box-sizing: border-box; }
        button { background: #007bff; color: white; border: none; cursor: pointer; font-weight: bold; }
        button:hover { background: #0056b3; }
        #info { margin: 20px 0; padding: 15px; background: #e8f4fd; border-radius: 5px; display: none; }
        .loading { text-align: center; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>🎬 Téléchargeur YouTube</h2>
        
        <div>
          <input type="text" id="url" placeholder="Collez le lien YouTube ici..." />
          <button onclick="getInfo()">📊 Voir les infos</button>
        </div>
        
        <div id="loading" class="loading" style="display:none;">
          <p>🔍 Analyse de la vidéo...</p>
        </div>
        
        <div id="info">
          <h3 id="title"></h3>
          <p id="duration"></p>
          <form action="/download" method="get">
            <input type="hidden" id="hiddenUrl" name="url" />
            
            <label>📁 Format :</label><br/>
            <select name="format" id="format" onchange="updateSizeInfo()">
              <option value="audio">🎵 Audio MP3</option>
              <option value="video">📹 Vidéo MP4</option>
            </select><br/>
            
            <label>🎯 Qualité :</label><br/>
            <select name="quality" id="quality" onchange="updateSizeInfo()">
              <option value="best">🏆 Meilleure qualité</option>
              <option value="1080">📺 1080p</option>
              <option value="720">📱 720p</option>
              <option value="480">💻 480p</option>
            </select><br/>
            
            <div id="sizeInfo" style="margin: 15px 0; padding: 10px; background: #fff3cd; border-radius: 5px;">
              <strong>📏 Taille estimée : <span id="estimatedSize">Calculer...</span></strong>
            </div>
            
            <button type="submit">⬇️ Télécharger</button>
          </form>
        </div>
      </div>

      <script>
        let videoInfo = null;
        
        async function getInfo() {
          const url = document.getElementById('url').value;
          if (!url) {
            alert('Veuillez entrer une URL YouTube');
            return;
          }
          
          document.getElementById('loading').style.display = 'block';
          document.getElementById('info').style.display = 'none';
          
          try {
            const response = await fetch('/info?url=' + encodeURIComponent(url));
            const data = await response.json();
            
            if (data.error) {
              alert('Erreur: ' + data.error);
              return;
            }
            
            videoInfo = data;
            document.getElementById('title').textContent = data.title;
            document.getElementById('duration').textContent = '⏱️ Durée: ' + formatDuration(data.duration);
            document.getElementById('hiddenUrl').value = url;
            
            document.getElementById('loading').style.display = 'none';
            document.getElementById('info').style.display = 'block';
            
            updateSizeInfo();
            
          } catch (error) {
            alert('Erreur lors de la récupération des infos');
            document.getElementById('loading').style.display = 'none';
          }
        }
        
        function updateSizeInfo() {
          if (!videoInfo) return;
          
          const format = document.getElementById('format').value;
          const quality = document.getElementById('quality').value;
          
          let estimatedSize = 'Calcul...';
          
          if (format === 'audio') {
            // Audio MP3 ~128kbps = ~16KB/s
            const sizeBytes = videoInfo.duration * 16 * 1024;
            estimatedSize = formatFileSize(sizeBytes);
          } else {
            // Estimation vidéo selon qualité
            const rates = {
              '480': 1000,   // 1 Mbps
              '720': 2500,   // 2.5 Mbps  
              '1080': 5000,  // 5 Mbps
              'best': 8000   // 8 Mbps
            };
            const rate = rates[quality] || 2500;
            const sizeBytes = (videoInfo.duration * rate * 1024) / 8; // Convert to bytes
            estimatedSize = formatFileSize(sizeBytes);
          }
          
          document.getElementById('estimatedSize').textContent = estimatedSize;
        }
        
        function formatDuration(seconds) {
          if (!seconds) return 'Inconnue';
          const mins = Math.floor(seconds / 60);
          const secs = seconds % 60;
          return mins + 'm ' + secs + 's';
        }
        
        function formatFileSize(bytes) {
          const sizes = ['B', 'KB', 'MB', 'GB'];
          if (bytes === 0) return '0 B';
          const i = Math.floor(Math.log(bytes) / Math.log(1024));
          return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
        }
      </script>
    </body>
    </html>
  `);
});

// Route pour obtenir les infos vidéo
app.get("/info", async (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.json({ error: 'URL manquante' });
  }
  
  try {
    const info = await getVideoInfo(url);
    res.json(info);
  } catch (error) {
    console.error('Erreur info:', error.message);
    res.json({ error: error.message });
  }
});

// Route de téléchargement corrigée
app.get("/download", async (req, res) => {
  const { url, format, quality } = req.query;
  
  if (!url) {
    return res.status(400).send("❌ URL manquante");
  }

  console.log(`📥 Téléchargement: ${format} | ${quality} | ${url.substring(0, 50)}...`);

  try {
    // Obtenir le titre pour le nom de fichier
    const info = await getVideoInfo(url);
    const safeTitle = info.title.replace(/[^\w\s-]/g, '').substring(0, 50) || 'download';
    
    let filename, contentType, args = [];
    
    // Configuration spécifique selon le format
    if (format === 'audio') {
      filename = `${safeTitle}.mp3`;
      contentType = 'audio/mpeg';
      
      // Arguments pour AUDIO SEULEMENT
      args = [
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '192K',
        '--no-keep-video',  // Important: ne pas garder la vidéo
        '--output', '-'
      ];
    } else {
      filename = `${safeTitle}.mp4`;
      contentType = 'video/mp4';
      
      // Arguments pour VIDÉO + AUDIO
      let formatSelector;
      switch(quality) {
        case '1080': formatSelector = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]'; break;
        case '720': formatSelector = 'bestvideo[height<=720]+bestaudio/best[height<=720]'; break;
        case '480': formatSelector = 'bestvideo[height<=480]+bestaudio/best[height<=480]'; break;
        default: formatSelector = 'bestvideo+bestaudio/best';
      }
      
      args = [
        '--format', formatSelector,
        '--merge-output-format', 'mp4',
        '--output', '-'
      ];
    }
    
    // Ajout des cookies si disponibles
    if (hasCookies) {
      args.unshift('--cookies', cookiesPath);
    }
    
    args.push(url);
    
    console.log(`🔧 Commande: yt-dlp ${args.join(' ')}`);
    
    // Headers de réponse CORRECTS
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    
    // Lancement du processus
    const ytProcess = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let hasData = false;
    let errorOutput = '';
    
    ytProcess.stdout.on('data', (chunk) => {
      hasData = true;
      res.write(chunk);
    });
    
    ytProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
      // Ne pas logger tous les messages de progression
      if (data.toString().includes('ERROR')) {
        console.error('❌ yt-dlp error:', data.toString());
      }
    });
    
    ytProcess.on('close', (code) => {
      if (code === 0 && hasData) {
        console.log(`✅ Téléchargement réussi: ${filename}`);
      } else {
        console.error(`❌ Échec (code ${code}):`, errorOutput);
        if (!hasData) {
          res.status(500).send(`❌ Erreur: ${errorOutput.split('\n')[0] || 'Téléchargement échoué'}`);
          return;
        }
      }
      res.end();
    });
    
    ytProcess.on('error', (err) => {
      console.error('💥 Erreur processus:', err.message);
      if (!hasData) {
        res.status(500).send('❌ Erreur serveur - yt-dlp non trouvé?');
      } else {
        res.end();
      }
    });
    
    // Timeout de 15 minutes
    setTimeout(() => {
      if (!ytProcess.killed) {
        ytProcess.kill('SIGKILL');
        console.log('⏰ Timeout - processus forcé');
      }
    }, 900000);
    
  } catch (error) {
    console.error('💀 Erreur globale:', error.message);
    res.status(500).send('❌ ' + error.message);
  }
});

// Démarrage serveur
app.listen(PORT, () => {
  console.log(`🚀 Serveur sur le port ${PORT}`);
  console.log(`📂 Cookies: ${hasCookies ? '✅' : '❌'}`);
});
