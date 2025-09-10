const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const cookiesPath = path.join(__dirname, "cookies.txt");
const hasCookies = fs.existsSync(cookiesPath);

// Servir les fichiers statiques depuis le dossier public
app.use(express.static(path.join(__dirname, 'public')));

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

// Route pour la page d'accueil - servir le fichier HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
  console.log(`🌐 Interface disponible sur: http://localhost:${PORT}`);
});

// Gestion propre de l'arrêt
process.on('SIGINT', () => {
  console.log('\n👋 Arrêt du serveur...');
  process.exit(0);
});
