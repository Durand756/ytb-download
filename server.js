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
    const infoArgs = [
      '--dump-json',
      '--no-playlist',
      url
    ];
    
    if (hasCookies) {
      infoArgs.unshift('--cookies', cookiesPath);
    }
    
    const infoProcess = spawn('yt-dlp', infoArgs);
    let jsonData = '';
    let errorData = '';
    
    infoProcess.stdout.on('data', (data) => {
      jsonData += data.toString();
    });
    
    infoProcess.stderr.on('data', (data) => {
      errorData += data.toString();
    });
    
    infoProcess.on('close', (code) => {
      if (code === 0 && jsonData.trim()) {
        try {
          const videoInfo = JSON.parse(jsonData);
          resolve(videoInfo);
        } catch (e) {
          reject(new Error('Erreur parsing JSON: ' + e.message));
        }
      } else {
        reject(new Error('Erreur obtention infos: ' + errorData));
      }
    });
  });
}

// Fonction pour formater la taille en octets
function formatFileSize(bytes) {
  if (!bytes) return 'Taille inconnue';
  const sizes = ['o', 'Ko', 'Mo', 'Go'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

// Fonction commune de téléchargement
async function downloadVideo(res, url, format, quality) {
  // Validation
  if (!url) {
    return res.status(400).send("❌ URL manquante");
  }
  
  if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
    return res.status(400).send("❌ URL YouTube invalide");
  }

  console.log(`📥 Demande: ${format || 'video'} | ${quality || 'best'} | ${url.substring(0, 50)}...`);

  try {
    // Obtenir les infos de la vidéo
    const videoInfo = await getVideoInfo(url);
    const safeTitle = (videoInfo.title || 'video')
      .replace(/[^\w\s.-]/g, '')
      .substring(0, 50)
      .trim();
    
    const extension = format === 'audio' ? 'mp3' : 'mp4';
    const filename = `${safeTitle}_${Date.now()}.${extension}`;

    // Headers de réponse
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', format === 'audio' ? 'audio/mpeg' : 'video/mp4');

    // Construction des arguments yt-dlp
    let args = [];
    
    if (hasCookies) {
      args.push('--cookies', cookiesPath);
    }

    // Configuration spécifique selon le format
    if (format === 'audio') {
      // Pour l'audio: extraction MP3 de haute qualité
      args.push(
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '192K',
        '--prefer-ffmpeg',
        '--format', 'bestaudio/best'
      );
    } else {
      // Pour la vidéo: format vidéo + audio combinés
      let formatSelector;
      switch(quality) {
        case 'best':
          formatSelector = 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';
          break;
        case '1080':
          formatSelector = 'best[height<=1080][ext=mp4]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]';
          break;
        case '720':
          formatSelector = 'best[height<=720][ext=mp4]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]';
          break;
        case '480':
          formatSelector = 'best[height<=480][ext=mp4]/bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]';
          break;
        default:
          formatSelector = 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';
      }
      
      args.push(
        '--format', formatSelector,
        '--merge-output-format', 'mp4',
        '--prefer-ffmpeg'
      );
    }

    // Sortie vers stdout
    args.push('-o', '-', url);

    console.log(`🔧 Commande: yt-dlp ${args.join(' ')}`);

    // Lancement du processus yt-dlp
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
      const errorMsg = data.toString();
      errorOutput += errorMsg;
      console.error('📛 yt-dlp stderr:', errorMsg);
    });

    ytProcess.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ Téléchargement réussi: ${filename}`);
      } else {
        console.error(`❌ Échec du téléchargement (code: ${code})`);
        console.error('Erreur complète:', errorOutput);
        if (!hasData) {
          if (errorOutput.includes('Video unavailable')) {
            res.status(404).send('❌ Vidéo indisponible');
          } else if (errorOutput.includes('Private video')) {
            res.status(403).send('❌ Vidéo privée');
          } else {
            res.status(500).send('❌ Erreur de téléchargement: ' + errorOutput.substring(0, 200));
          }
        }
      }
      res.end();
    });

    ytProcess.on('error', (err) => {
      console.error('💥 Erreur processus:', err.message);
      if (!hasData) {
        res.status(500).send('❌ Erreur serveur: yt-dlp non trouvé');
      }
      res.end();
    });

    // Timeout de sécurité (15 minutes)
    setTimeout(() => {
      if (!ytProcess.killed) {
        ytProcess.kill('SIGTERM');
        console.log('⏰ Timeout - processus arrêté');
        if (!hasData) {
          res.status(408).send('❌ Timeout de téléchargement');
        }
      }
    }, 900000);

  } catch (error) {
    console.error('💀 Erreur globale:', error.message);
    res.status(500).send('❌ Erreur interne: ' + error.message);
  }
}

// Page d'accueil avec informations de la vidéo
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Téléchargeur YouTube</title>
      <style>
        body { 
          font-family: Arial; 
          margin: 50px; 
          background-color: #f5f5f5;
        }
        .container {
          max-width: 800px;
          margin: 0 auto;
          background: white;
          padding: 30px;
          border-radius: 10px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        input, select, button { 
          padding: 10px; 
          margin: 5px; 
          border: 1px solid #ddd;
          border-radius: 5px;
        }
        input[type="text"] { 
          width: 400px; 
        }
        button {
          background-color: #007bff;
          color: white;
          border: none;
          cursor: pointer;
          font-weight: bold;
        }
        button:hover {
          background-color: #0056b3;
        }
        .info-section {
          margin-top: 20px;
          padding: 15px;
          background-color: #f8f9fa;
          border-radius: 5px;
          display: none;
        }
        .method-section {
          margin-bottom: 30px;
          padding: 20px;
          border: 1px solid #ddd;
          border-radius: 8px;
          background-color: #fafafa;
        }
        .direct-download {
          margin-top: 15px;
        }
        .examples {
          margin: 15px 0;
          padding: 10px;
          background-color: white;
          border-radius: 5px;
          border-left: 4px solid #28a745;
        }
        .example-links code {
          background-color: #f8f9fa;
          padding: 2px 5px;
          border-radius: 3px;
          font-family: monospace;
          font-size: 12px;
        }
        .quick-generator {
          margin-top: 15px;
          padding: 15px;
          background-color: white;
          border-radius: 5px;
          border: 1px solid #ddd;
        }
        .format-info {
          margin-top: 10px;
          padding: 10px;
          background-color: white;
          border-radius: 5px;
          border-left: 4px solid #007bff;
        }
        .loading {
          display: none;
          color: #666;
        }
      </style>
      <script>
        async function checkVideo() {
          const url = document.getElementById('videoUrl').value;
          const infoSection = document.getElementById('videoInfo');
          const loading = document.getElementById('loading');
          
          if (!url) {
            infoSection.style.display = 'none';
            return;
          }
          
          loading.style.display = 'block';
          infoSection.style.display = 'none';
          
          try {
            const response = await fetch('/info?url=' + encodeURIComponent(url));
            const data = await response.json();
            
            if (data.success) {
              document.getElementById('videoTitle').textContent = data.title;
              document.getElementById('videoDuration').textContent = data.duration;
              document.getElementById('videoFormats').innerHTML = data.formats.map(f => 
                '<div class="format-info"><strong>' + f.type + ':</strong> ' + f.quality + ' - ' + f.size + '</div>'
              ).join('');
              infoSection.style.display = 'block';
            } else {
              alert('Erreur: ' + data.error);
            }
          } catch (error) {
            alert('Erreur de connexion: ' + error.message);
          }
          
          loading.style.display = 'none';
        }
        
        function generateDirectLink() {
          const videoId = document.getElementById('videoId').value.trim();
          const format = document.getElementById('directFormat').value;
          const quality = document.getElementById('directQuality').value;
          
          if (!videoId) {
            alert('Veuillez entrer un ID de vidéo');
            return;
          }
          
          // Extraire l'ID si c'est une URL complète
          let cleanId = videoId;
          if (videoId.includes('youtube.com/watch?v=')) {
            cleanId = videoId.split('v=')[1].split('&')[0];
          } else if (videoId.includes('youtu.be/')) {
            cleanId = videoId.split('youtu.be/')[1].split('?')[0];
          }
          
          const baseUrl = window.location.origin;
          const link = baseUrl + '/download/' + cleanId + '?format=' + format + '&quality=' + quality;
          
          document.getElementById('generatedLink').value = link;
          const downloadBtn = document.getElementById('directDownload');
          downloadBtn.href = link;
          downloadBtn.style.display = 'inline';
        }
        
        function copyToClipboard() {
          const linkField = document.getElementById('generatedLink');
          if (!linkField.value) {
            alert('Générez d\'abord un lien');
            return;
          }
          
          linkField.select();
          linkField.setSelectionRange(0, 99999);
          document.execCommand('copy');
          alert('Lien copié dans le presse-papier!');
        }
        
        // Auto-génération quand on tape l'ID
        document.addEventListener('DOMContentLoaded', function() {
          document.getElementById('videoId').addEventListener('input', function() {
            if (this.value.trim()) {
              generateDirectLink();
            }
          });
        });
      </script>
    </head>
    <body>
      <div class="container">
        <h2>🎬 Téléchargeur YouTube</h2>
        
        <!-- Méthode 1: Téléchargement avec URL complète -->
        <div class="method-section">
          <h3>📋 Méthode 1: Avec URL complète</h3>
          <form action="/download" method="get">
            <input type="text" id="videoUrl" name="url" placeholder="Collez le lien YouTube ici..." 
                   required onchange="checkVideo()" onpaste="setTimeout(checkVideo, 100)"/><br/>
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
        </div>

        <!-- Méthode 2: Téléchargement direct avec ID -->
        <div class="method-section">
          <h3>⚡ Méthode 2: Téléchargement direct avec ID vidéo</h3>
          <div class="direct-download">
            <p><strong>Format:</strong> <code>http://votre-serveur:3000/download/ID_VIDEO?format=FORMAT&quality=QUALITE</code></p>
            <div class="examples">
              <h4>Exemples:</h4>
              <div class="example-links">
                <p><strong>Vidéo HD:</strong> <code>/download/dQw4w9WgXcQ?format=video&quality=720</code></p>
                <p><strong>Audio MP3:</strong> <code>/download/dQw4w9WgXcQ?format=audio</code></p>
                <p><strong>Meilleure qualité:</strong> <code>/download/dQw4w9WgXcQ?format=video&quality=best</code></p>
              </div>
            </div>
            
            <div class="quick-generator">
              <h4>🛠️ Générateur de lien:</h4>
              <input type="text" id="videoId" placeholder="ID de la vidéo (ex: dQw4w9WgXcQ)" style="width: 200px;"/>
              <select id="directFormat">
                <option value="video">Vidéo MP4</option>
                <option value="audio">Audio MP3</option>
              </select>
              <select id="directQuality">
                <option value="best">Meilleure qualité</option>
                <option value="1080">1080p</option>
                <option value="720">720p</option>
                <option value="480">480p</option>
              </select>
              <button type="button" onclick="generateDirectLink()">Générer le lien</button><br/>
              <input type="text" id="generatedLink" readonly style="width: 100%; margin-top: 10px;" placeholder="Le lien généré apparaîtra ici..."/>
              <button type="button" onclick="copyToClipboard()" style="margin-top: 5px;">📋 Copier</button>
              <a id="directDownload" href="#" style="margin-left: 10px; display: none;" target="_blank">⬇️ Télécharger maintenant</a>
            </div>
          </div>
        </div>
        
        <div id="loading" class="loading">🔍 Récupération des informations...</div>
        
        <div id="videoInfo" class="info-section">
          <h3>📺 Informations de la vidéo</h3>
          <p><strong>Titre:</strong> <span id="videoTitle"></span></p>
          <p><strong>Durée:</strong> <span id="videoDuration"></span></p>
          <div id="videoFormats"></div>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Route pour obtenir les informations de la vidéo
app.get("/info", async (req, res) => {
  const { url } = req.query;
  
  if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
    return res.json({ success: false, error: 'URL YouTube invalide' });
  }
  
  try {
    const videoInfo = await getVideoInfo(url);
    
    // Analyser les formats disponibles
    const formats = [];
    
    // Format audio MP3
    const audioFormats = videoInfo.formats?.filter(f => f.acodec && f.acodec !== 'none') || [];
    if (audioFormats.length > 0) {
      const bestAudio = audioFormats.reduce((best, current) => 
        (current.abr || 0) > (best.abr || 0) ? current : best
      );
      formats.push({
        type: 'Audio MP3',
        quality: `${bestAudio.abr || 128} kbps`,
        size: formatFileSize(bestAudio.filesize || bestAudio.filesize_approx)
      });
    }
    
    // Formats vidéo
    const videoFormats = videoInfo.formats?.filter(f => f.vcodec && f.vcodec !== 'none') || [];
    const qualityLevels = [1080, 720, 480];
    
    qualityLevels.forEach(quality => {
      const format = videoFormats.find(f => f.height === quality);
      if (format) {
        formats.push({
          type: `Vidéo MP4 ${quality}p`,
          quality: `${quality}p - ${Math.round(format.fps || 30)} fps`,
          size: formatFileSize(format.filesize || format.filesize_approx)
        });
      }
    });
    
    // Format meilleure qualité
    const bestVideo = videoFormats.reduce((best, current) => 
      (current.height || 0) > (best.height || 0) ? current : best, {}
    );
    if (bestVideo.height) {
      formats.unshift({
        type: 'Vidéo MP4 (Meilleure)',
        quality: `${bestVideo.height}p - ${Math.round(bestVideo.fps || 30)} fps`,
        size: formatFileSize(bestVideo.filesize || bestVideo.filesize_approx)
      });
    }
    
    const duration = videoInfo.duration ? 
      `${Math.floor(videoInfo.duration / 60)}:${String(videoInfo.duration % 60).padStart(2, '0')}` : 
      'Inconnue';
    
    res.json({
      success: true,
      title: videoInfo.title || 'Titre indisponible',
      duration: duration,
      formats: formats
    });
    
  } catch (error) {
    console.error('Erreur info vidéo:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// Route de téléchargement direct avec ID vidéo
app.get("/download/:videoId", async (req, res) => {
  const { videoId } = req.params;
  const { format = 'video', quality = 'best' } = req.query;
  
  // Construire l'URL YouTube à partir de l'ID
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  
  console.log(`📥 Téléchargement direct: ${videoId} | ${format} | ${quality}`);
  
  await downloadVideo(res, url, format, quality);
});

// Route de téléchargement classique
app.get("/download", async (req, res) => {
  const { url, format = 'video', quality = 'best' } = req.query;
  
  await downloadVideo(res, url, format, quality);
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
