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

// Middleware pour parser le JSON
app.use(express.json());

if (!hasCookies) {
  console.warn("⚠️ Aucun fichier cookies.txt trouvé.");
}

// Fonction pour extraire l'ID d'une URL YouTube
function extractVideoId(url) {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// Fonction pour valider une URL YouTube
function isValidYouTubeUrl(url) {
  return url && (url.includes('youtube.com') || url.includes('youtu.be'));
}

// Fonction pour construire l'URL YouTube à partir d'un ID
function buildYouTubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
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
    
    // Timeout de sécurité pour les requêtes d'info (30 secondes)
    setTimeout(() => {
      if (!infoProcess.killed) {
        infoProcess.kill('SIGTERM');
        reject(new Error('Timeout lors de la récupération des informations'));
      }
    }, 30000);
  });
}

// Fonction pour formater la taille en octets
function formatFileSize(bytes) {
  if (!bytes) return 'Taille inconnue';
  const sizes = ['o', 'Ko', 'Mo', 'Go'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

// Fonction pour formater les informations de la vidéo
function formatVideoInfo(videoInfo) {
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
  
  return {
    success: true,
    id: videoInfo.id,
    title: videoInfo.title || 'Titre indisponible',
    duration: duration,
    thumbnail: videoInfo.thumbnail,
    uploader: videoInfo.uploader,
    view_count: videoInfo.view_count,
    upload_date: videoInfo.upload_date,
    formats: formats
  };
}

// Fonction commune de téléchargement
async function downloadVideo(res, url, format, quality) {
  // Validation
  if (!url) {
    return res.status(400).json({ error: "URL manquante" });
  }
  
  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: "URL YouTube invalide" });
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
            res.status(404).json({ error: 'Vidéo indisponible' });
          } else if (errorOutput.includes('Private video')) {
            res.status(403).json({ error: 'Vidéo privée' });
          } else {
            res.status(500).json({ error: 'Erreur de téléchargement: ' + errorOutput.substring(0, 200) });
          }
          return;
        }
      }
      res.end();
    });

    ytProcess.on('error', (err) => {
      console.error('💥 Erreur processus:', err.message);
      if (!hasData) {
        res.status(500).json({ error: 'Erreur serveur: yt-dlp non trouvé' });
      }
      res.end();
    });

    // Timeout de sécurité (15 minutes)
    setTimeout(() => {
      if (!ytProcess.killed) {
        ytProcess.kill('SIGTERM');
        console.log('⏰ Timeout - processus arrêté');
        if (!hasData) {
          res.status(408).json({ error: 'Timeout de téléchargement' });
        }
      }
    }, 900000);

  } catch (error) {
    console.error('💀 Erreur globale:', error.message);
    res.status(500).json({ error: 'Erreur interne: ' + error.message });
  }
}

// ====================
// ROUTES
// ====================

// Route pour la page d'accueil - servir le fichier HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route pour la documentation API
app.get("/api-docs", (req, res) => {
  const docs = {
    title: "YouTube Downloader API",
    version: "2.0",
    description: "API complète pour télécharger des vidéos YouTube",
    endpoints: {
      "GET /info": {
        description: "Récupérer les informations d'une vidéo avec URL complète",
        parameters: {
          url: "URL YouTube complète (obligatoire)"
        },
        example: "/info?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"
      },
      "GET /info/:videoId": {
        description: "Récupérer les informations d'une vidéo avec ID",
        parameters: {
          videoId: "ID de la vidéo YouTube (obligatoire)"
        },
        example: "/info/dQw4w9WgXcQ"
      },
      "GET /download": {
        description: "Télécharger avec URL complète",
        parameters: {
          url: "URL YouTube complète (obligatoire)",
          format: "video ou audio (optionnel, défaut: video)",
          quality: "best, 1080, 720, 480 (optionnel, défaut: best)"
        },
        example: "/download?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=audio"
      },
      "GET /download/:videoId": {
        description: "Télécharger avec ID de vidéo",
        parameters: {
          videoId: "ID de la vidéo YouTube (obligatoire)",
          format: "video ou audio (optionnel, défaut: video)",
          quality: "best, 1080, 720, 480 (optionnel, défaut: best)"
        },
        example: "/download/dQw4w9WgXcQ?format=video&quality=720"
      },
      "GET /api/download-url": {
        description: "Téléchargement direct avec URL (alias)",
        parameters: {
          url: "URL YouTube complète (obligatoire)",
          format: "video ou audio (optionnel, défaut: video)",
          quality: "best, 1080, 720, 480 (optionnel, défaut: best)"
        },
        example: "/api/download-url?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=audio"
      }
    }
  };
  
  res.json(docs);
});

// Route pour obtenir les informations de la vidéo avec URL
app.get("/info", async (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ success: false, error: 'Paramètre URL manquant' });
  }
  
  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ success: false, error: 'URL YouTube invalide' });
  }
  
  try {
    console.log(`📋 Récupération infos: ${url.substring(0, 50)}...`);
    const videoInfo = await getVideoInfo(url);
    const formattedInfo = formatVideoInfo(videoInfo);
    
    res.json(formattedInfo);
    console.log(`✅ Infos récupérées: ${formattedInfo.title}`);
    
  } catch (error) {
    console.error('❌ Erreur info vidéo:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Route pour obtenir les informations de la vidéo avec ID
app.get("/info/:videoId", async (req, res) => {
  const { videoId } = req.params;
  
  if (!videoId) {
    return res.status(400).json({ success: false, error: 'ID de vidéo manquant' });
  }
  
  // Construire l'URL à partir de l'ID
  const url = buildYouTubeUrl(videoId);
  
  try {
    console.log(`📋 Récupération infos par ID: ${videoId}`);
    const videoInfo = await getVideoInfo(url);
    const formattedInfo = formatVideoInfo(videoInfo);
    
    res.json(formattedInfo);
    console.log(`✅ Infos récupérées: ${formattedInfo.title}`);
    
  } catch (error) {
    console.error('❌ Erreur info vidéo par ID:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Route de téléchargement direct avec ID vidéo
app.get("/download/:videoId", async (req, res) => {
  const { videoId } = req.params;
  const { format = 'video', quality = 'best' } = req.query;
  
  if (!videoId) {
    return res.status(400).json({ error: 'ID de vidéo manquant' });
  }
  
  // Construire l'URL YouTube à partir de l'ID
  const url = buildYouTubeUrl(videoId);
  
  console.log(`📥 Téléchargement direct: ${videoId} | ${format} | ${quality}`);
  
  await downloadVideo(res, url, format, quality);
});

// Route de téléchargement classique avec URL complète
app.get("/download", async (req, res) => {
  const { url, format = 'video', quality = 'best' } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'URL manquante' });
  }
  
  console.log(`📥 Téléchargement classique: ${format} | ${quality}`);
  
  await downloadVideo(res, url, format, quality);
});

// Route API alternative pour le téléchargement avec URL
app.get("/api/download-url", async (req, res) => {
  const { url, format = 'video', quality = 'best' } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'URL manquante' });
  }
  
  console.log(`📥 API téléchargement URL: ${format} | ${quality}`);
  
  await downloadVideo(res, url, format, quality);
});

// Route pour obtenir des statistiques du serveur
app.get("/api/stats", (req, res) => {
  const stats = {
    server: "YouTube Downloader API",
    version: "2.0",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cookies_available: hasCookies,
    endpoints: [
      'GET /',
      'GET /api-docs',
      'GET /info',
      'GET /info/:videoId',
      'GET /download',
      'GET /download/:videoId',
      'GET /api/download-url',
      'GET /api/stats'
    ]
  };
  
  res.json(stats);
});

// Route pour tester la connectivité
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    service: "YouTube Downloader",
    version: "2.0"
  });
});

// Middleware de gestion d'erreurs 404
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint non trouvé",
    available_endpoints: [
      'GET /',
      'GET /api-docs',
      'GET /info',
      'GET /info/:videoId',
      'GET /download',
      'GET /download/:videoId',
      'GET /api/download-url',
      'GET /api/stats',
      'GET /api/health'
    ]
  });
});

// Gestion des erreurs globales
app.use((err, req, res, next) => {
  console.error('🚨 Erreur Express:', err.message);
  res.status(500).json({ error: 'Erreur serveur interne' });
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`🚀 Serveur YouTube Downloader démarré sur le port ${PORT}`);
  console.log(`📂 Cookies: ${hasCookies ? '✅ Trouvés' : '❌ Absents'}`);
  console.log(`🌐 Interface disponible sur: http://localhost:${PORT}`);
  console.log(`📖 Documentation API: http://localhost:${PORT}/api-docs`);
  console.log(`❤️ Health check: http://localhost:${PORT}/api/health`);
});

// Gestion propre de l'arrêt
process.on('SIGINT', () => {
  console.log('\n👋 Arrêt du serveur...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Arrêt du serveur (SIGTERM)...');
  process.exit(0);
});
