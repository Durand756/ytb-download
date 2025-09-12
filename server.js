const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { promisify } = require('util');

const app = express();
const PORT = process.env.PORT || 3000;
const cookiesPath = path.join(__dirname, "cookies.txt");
const hasCookies = fs.existsSync(cookiesPath);

// ===============================
// CONFIGURATION & OPTIMISATIONS
// ===============================

// Limites pour serveur gratuit Render
const MAX_CONCURRENT_DOWNLOADS = 6;
const MAX_CONCURRENT_INFO_REQUESTS = 10;
const MEMORY_THRESHOLD_MB = 400; // Limite mémoire avant refus
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const INFO_TIMEOUT_MS = 30 * 10000; // 300 secondes pour les infos
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Compteurs de requêtes actives
let activeDownloads = 0;
let activeInfoRequests = 0;
let totalRequests = 0;
let errorCount = 0;
let lastCleanup = Date.now();

// Cache pour les informations de vidéo (TTL: 1 heure)
const videoInfoCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

// Queue pour les requêtes en attente
const downloadQueue = [];
const infoQueue = [];

// Middleware essentiels
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// Middleware de monitoring de la mémoire
app.use((req, res, next) => {
  const memUsage = process.memoryUsage();
  const memUsageMB = Math.round(memUsage.rss / 1024 / 1024);
  
  if (memUsageMB > MEMORY_THRESHOLD_MB) {
    console.warn(`⚠️ Mémoire élevée: ${memUsageMB}MB - Refus de la requête`);
    return res.status(503).json({ 
      error: 'Serveur surchargé', 
      retry_after: 60,
      memory_usage: `${memUsageMB}MB`
    });
  }
  
  totalRequests++;
  next();
});

// Middleware de limitation de débit
app.use((req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const userAgent = req.get('User-Agent') || 'unknown';
  
  // Headers de réponse pour monitoring
  res.setHeader('X-Server-Load', `${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`);
  res.setHeader('X-Memory-Usage', `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
  
  console.log(`📊 Requête: ${req.method} ${req.path} | IP: ${clientIP.substring(0, 20)} | UA: ${userAgent.substring(0, 30)}`);
  next();
});

if (!hasCookies) {
  console.warn("⚠️ Aucun fichier cookies.txt trouvé - Certaines vidéos peuvent être inaccessibles");
}

// ===============================
// UTILITAIRES & HELPERS
// ===============================

function extractVideoId(url) {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|m\.youtube\.com\/watch\?v=)([^&\n?#]+)/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

function isValidYouTubeUrl(url) {
  return url && (url.includes('youtube.com') || url.includes('youtu.be')) && extractVideoId(url);
}

function buildYouTubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function formatFileSize(bytes) {
  if (!bytes) return 'Taille inconnue';
  const sizes = ['o', 'Ko', 'Mo', 'Go'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

function sanitizeFilename(title) {
  return (title || 'video')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 50)
    .trim();
}

// Nettoyage périodique des ressources
function performCleanup() {
  const now = Date.now();
  
  // Nettoyer le cache expiré
  for (const [key, value] of videoInfoCache.entries()) {
    if (now - value.timestamp > CACHE_TTL_MS) {
      videoInfoCache.delete(key);
    }
  }
  
  // Forcer garbage collection si disponible
  if (global.gc) {
    global.gc();
  }
  
  console.log(`🧹 Nettoyage effectué - Cache: ${videoInfoCache.size} entrées`);
  lastCleanup = now;
}

// Nettoyage automatique
setInterval(performCleanup, CLEANUP_INTERVAL_MS);

// ===============================
// GESTION DES QUEUES
// ===============================

function processDownloadQueue() {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS || downloadQueue.length === 0) {
    return;
  }
  
  const task = downloadQueue.shift();
  activeDownloads++;
  
  console.log(`📥 Traitement téléchargement (${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}) - Queue: ${downloadQueue.length}`);
  
  task.execute().finally(() => {
    activeDownloads--;
    setTimeout(processDownloadQueue, 100); // Petit délai pour éviter la surcharge
  });
}

function processInfoQueue() {
  if (activeInfoRequests >= MAX_CONCURRENT_INFO_REQUESTS || infoQueue.length === 0) {
    return;
  }
  
  const task = infoQueue.shift();
  activeInfoRequests++;
  
  console.log(`📋 Traitement info (${activeInfoRequests}/${MAX_CONCURRENT_INFO_REQUESTS}) - Queue: ${infoQueue.length}`);
  
  task.execute().finally(() => {
    activeInfoRequests--;
    setTimeout(processInfoQueue, 50);
  });
}

// ===============================
// FONCTIONS PRINCIPALES
// ===============================

async function getVideoInfoCached(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('ID vidéo invalide');
  
  // Vérifier le cache
  const cacheKey = videoId;
  const cached = videoInfoCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    console.log(`💾 Cache hit pour: ${videoId}`);
    return cached.data;
  }
  
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Timeout lors de la récupération des informations'));
    }, INFO_TIMEOUT_MS);
    
    const infoArgs = ['--dump-json', '--no-playlist', url];
    
    if (hasCookies) {
      infoArgs.unshift('--cookies', cookiesPath);
    }
    
    const infoProcess = spawn('yt-dlp', infoArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let jsonData = '';
    let errorData = '';
    
    infoProcess.stdout.on('data', (data) => {
      jsonData += data.toString();
    });
    
    infoProcess.stderr.on('data', (data) => {
      errorData += data.toString();
    });
    
    infoProcess.on('close', (code) => {
      clearTimeout(timeoutId);
      
      if (code === 0 && jsonData.trim()) {
        try {
          const videoInfo = JSON.parse(jsonData);
          
          // Mettre en cache
          videoInfoCache.set(cacheKey, {
            data: videoInfo,
            timestamp: Date.now()
          });
          
          resolve(videoInfo);
        } catch (e) {
          reject(new Error('Erreur parsing JSON: ' + e.message));
        }
      } else {
        const errorMsg = errorData || `Code de sortie: ${code}`;
        reject(new Error('Erreur obtention infos: ' + errorMsg));
      }
    });
    
    infoProcess.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(new Error('Erreur processus yt-dlp: ' + err.message));
    });
  });
}

function formatVideoInfo(videoInfo) {
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
    formats: formats,
    cached: videoInfoCache.has(videoInfo.id)
  };
}

async function executeDownload(res, url, format, quality) {
  return new Promise(async (resolve, reject) => {
    let hasStarted = false;
    let hasData = false;
    let bytesTransferred = 0;
    
    const timeoutId = setTimeout(() => {
      if (!hasStarted || !hasData) {
        reject(new Error('Timeout de téléchargement'));
      }
    }, REQUEST_TIMEOUT_MS);
    
    try {
      // Obtenir les infos de la vidéo
      const videoInfo = await getVideoInfoCached(url);
      const safeTitle = sanitizeFilename(videoInfo.title);
      const extension = format === 'audio' ? 'mp3' : 'mp4';
      const filename = `${safeTitle}_${Date.now()}.${extension}`;

      // Headers optimisés
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', format === 'audio' ? 'audio/mpeg' : 'video/mp4');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Video-Title', videoInfo.title);
      res.setHeader('X-Video-Duration', videoInfo.duration || '0');

      // Construction des arguments yt-dlp optimisés
      let args = ['--no-playlist', '--no-warnings'];
      
      if (hasCookies) {
        args.push('--cookies', cookiesPath);
      }

      // Configuration spécifique selon le format
      if (format === 'audio') {
        args.push(
          '--extract-audio',
          '--audio-format', 'mp3',
          '--audio-quality', '192K',
          '--prefer-ffmpeg',
          '--format', 'bestaudio[ext=m4a]/bestaudio/best'
        );
      } else {
        let formatSelector;
        switch(quality) {
          case 'best':
            formatSelector = 'best[ext=mp4][height<=1080]/bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[height<=1080]';
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
          '--merge-output-format', 'mp4'
        );
      }

      args.push('-o', '-', url);
      hasStarted = true;

      console.log(`🚀 Démarrage téléchargement: ${filename.substring(0, 30)}...`);

      const ytProcess = spawn('yt-dlp', args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let errorOutput = '';
      let lastProgressTime = Date.now();

      ytProcess.stdout.on('data', (chunk) => {
        if (!hasData) {
          hasData = true;
          console.log(`📊 Premier chunk reçu pour: ${filename.substring(0, 20)}...`);
        }
        
        bytesTransferred += chunk.length;
        
        // Log de progression toutes les 5 secondes
        const now = Date.now();
        if (now - lastProgressTime > 5000) {
          console.log(`📈 Progression: ${Math.round(bytesTransferred / 1024 / 1024)}MB - ${filename.substring(0, 20)}...`);
          lastProgressTime = now;
        }
        
        res.write(chunk);
      });

      ytProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      ytProcess.on('close', (code) => {
        clearTimeout(timeoutId);
        
        if (code === 0) {
          console.log(`✅ Téléchargement terminé: ${Math.round(bytesTransferred / 1024 / 1024)}MB - ${filename.substring(0, 30)}...`);
          res.end();
          resolve();
        } else {
          console.error(`❌ Échec téléchargement (code: ${code}) - ${errorOutput.substring(0, 100)}`);
          if (!hasData) {
            reject(new Error(`Échec du téléchargement: ${errorOutput.substring(0, 200)}`));
          } else {
            res.end();
            resolve();
          }
        }
      });

      ytProcess.on('error', (err) => {
        clearTimeout(timeoutId);
        console.error(`💥 Erreur processus téléchargement:`, err.message);
        if (!hasData) {
          reject(new Error('Erreur serveur: yt-dlp indisponible'));
        } else {
          res.end();
          resolve();
        }
      });

    } catch (error) {
      clearTimeout(timeoutId);
      console.error(`💀 Erreur globale téléchargement:`, error.message);
      reject(error);
    }
  });
}

// ===============================
// ROUTES PRINCIPALES
// ===============================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get("/api-docs", (req, res) => {
  res.json({
    title: "YouTube Downloader API - Render Optimized",
    version: "3.0",
    description: "API haute performance pour télécharger des vidéos YouTube",
    server_info: {
      concurrent_downloads: `${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`,
      concurrent_info_requests: `${activeInfoRequests}/${MAX_CONCURRENT_INFO_REQUESTS}`,
      memory_usage: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
      cache_size: videoInfoCache.size,
      total_requests: totalRequests,
      error_rate: `${Math.round(errorCount / Math.max(totalRequests, 1) * 100)}%`
    },
    endpoints: {
      "GET /info": {
        description: "Récupérer les informations d'une vidéo avec URL complète (mis en cache)",
        parameters: { url: "URL YouTube complète (obligatoire)" },
        example: "/info?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"
      },
      "GET /info/:videoId": {
        description: "Récupérer les informations d'une vidéo avec ID (mis en cache)",
        parameters: { videoId: "ID de la vidéo YouTube (obligatoire)" },
        example: "/info/dQw4w9WgXcQ"
      },
      "GET /download": {
        description: "Télécharger avec URL complète (gestion de queue)",
        parameters: {
          url: "URL YouTube complète (obligatoire)",
          format: "video ou audio (optionnel, défaut: video)",
          quality: "best, 1080, 720, 480 (optionnel, défaut: best)"
        },
        example: "/download?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=audio"
      },
      "GET /download/:videoId": {
        description: "Télécharger avec ID de vidéo (gestion de queue)",
        parameters: {
          videoId: "ID de la vidéo YouTube (obligatoire)",
          format: "video ou audio (optionnel, défaut: video)",
          quality: "best, 1080, 720, 480 (optionnel, défaut: best)"
        },
        example: "/download/dQw4w9WgXcQ?format=video&quality=720"
      }
    },
    limits: {
      max_concurrent_downloads: MAX_CONCURRENT_DOWNLOADS,
      max_concurrent_info_requests: MAX_CONCURRENT_INFO_REQUESTS,
      request_timeout: `${REQUEST_TIMEOUT_MS / 1000}s`,
      info_timeout: `${INFO_TIMEOUT_MS / 1000}s`,
      cache_ttl: `${CACHE_TTL_MS / 1000 / 60}min`
    }
  });
});

// Route info avec gestion de queue
app.get("/info", (req, res) => {
  const { url } = req.query;
  
  if (!url || !isValidYouTubeUrl(url)) {
    errorCount++;
    return res.status(400).json({ 
      success: false, 
      error: 'URL YouTube valide requise' 
    });
  }
  
  if (activeInfoRequests >= MAX_CONCURRENT_INFO_REQUESTS) {
    const task = {
      execute: () => handleInfoRequest(res, url)
    };
    infoQueue.push(task);
    
    res.status(202).json({
      success: false,
      message: 'Requête mise en queue',
      queue_position: infoQueue.length,
      estimated_wait: `${infoQueue.length * 3}s`
    });
    
    return;
  }
  
  handleInfoRequest(res, url);
});

app.get("/info/:videoId", (req, res) => {
  const { videoId } = req.params;
  
  if (!videoId) {
    errorCount++;
    return res.status(400).json({ 
      success: false, 
      error: 'ID de vidéo requis' 
    });
  }
  
  const url = buildYouTubeUrl(videoId);
  
  if (activeInfoRequests >= MAX_CONCURRENT_INFO_REQUESTS) {
    const task = {
      execute: () => handleInfoRequest(res, url)
    };
    infoQueue.push(task);
    
    res.status(202).json({
      success: false,
      message: 'Requête mise en queue',
      queue_position: infoQueue.length,
      estimated_wait: `${infoQueue.length * 3}s`
    });
    
    return;
  }
  
  handleInfoRequest(res, url);
});

async function handleInfoRequest(res, url) {
  try {
    const videoInfo = await getVideoInfoCached(url);
    const formattedInfo = formatVideoInfo(videoInfo);
    res.json(formattedInfo);
  } catch (error) {
    errorCount++;
    console.error('❌ Erreur info vidéo:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message.substring(0, 100) 
    });
  } finally {
    processInfoQueue();
  }
}

// Routes de téléchargement avec gestion de queue
app.get("/download/:videoId", (req, res) => {
  const { videoId } = req.params;
  const { format = 'video', quality = 'best' } = req.query;
  
  if (!videoId) {
    errorCount++;
    return res.status(400).json({ error: 'ID de vidéo requis' });
  }
  
  const url = buildYouTubeUrl(videoId);
  handleDownloadRequest(res, url, format, quality);
});

app.get("/download", (req, res) => {
  const { url, format = 'video', quality = 'best' } = req.query;
  
  if (!url || !isValidYouTubeUrl(url)) {
    errorCount++;
    return res.status(400).json({ error: 'URL YouTube valide requise' });
  }
  
  handleDownloadRequest(res, url, format, quality);
});

function handleDownloadRequest(res, url, format, quality) {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    const queuePosition = downloadQueue.length + 1;
    const estimatedWait = queuePosition * 2; // 2 minutes par téléchargement en moyenne
    
    const task = {
      execute: () => executeDownloadWrapper(res, url, format, quality)
    };
    downloadQueue.push(task);
    
    res.status(202).json({
      error: 'Serveur occupé - Téléchargement mis en queue',
      queue_position: queuePosition,
      estimated_wait: `${estimatedWait}min`,
      active_downloads: activeDownloads,
      max_concurrent: MAX_CONCURRENT_DOWNLOADS
    });
    
    return;
  }
  
  executeDownloadWrapper(res, url, format, quality);
}

async function executeDownloadWrapper(res, url, format, quality) {
  try {
    await executeDownload(res, url, format, quality);
  } catch (error) {
    errorCount++;
    console.error('💀 Erreur téléchargement wrapper:', error.message);
    if (!res.headersSent) {
      if (error.message.includes('unavailable')) {
        res.status(404).json({ error: 'Vidéo indisponible' });
      } else if (error.message.includes('Private')) {
        res.status(403).json({ error: 'Vidéo privée' });
      } else if (error.message.includes('Timeout')) {
        res.status(408).json({ error: 'Timeout de téléchargement' });
      } else {
        res.status(500).json({ error: error.message.substring(0, 100) });
      }
    }
  } finally {
    processDownloadQueue();
  }
}

// Routes utilitaires
app.get("/api/stats", (req, res) => {
  const memUsage = process.memoryUsage();
  
  res.json({
    server: "YouTube Downloader API - Render Optimized",
    version: "3.0",
    uptime: Math.round(process.uptime()),
    performance: {
      active_downloads: activeDownloads,
      max_concurrent_downloads: MAX_CONCURRENT_DOWNLOADS,
      active_info_requests: activeInfoRequests,
      max_concurrent_info_requests: MAX_CONCURRENT_INFO_REQUESTS,
      download_queue_length: downloadQueue.length,
      info_queue_length: infoQueue.length
    },
    memory: {
      rss_mb: Math.round(memUsage.rss / 1024 / 1024),
      heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
      external_mb: Math.round(memUsage.external / 1024 / 1024)
    },
    cache: {
      entries: videoInfoCache.size,
      ttl_minutes: CACHE_TTL_MS / 1000 / 60
    },
    requests: {
      total: totalRequests,
      errors: errorCount,
      error_rate: `${Math.round(errorCount / Math.max(totalRequests, 1) * 100)}%`
    },
    features: {
      cookies_available: hasCookies,
      gc_available: typeof global.gc !== 'undefined',
      last_cleanup: new Date(lastCleanup).toISOString()
    }
  });
});

app.get("/api/health", (req, res) => {
  const memUsageMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const isHealthy = memUsageMB < MEMORY_THRESHOLD_MB && 
                    activeDownloads < MAX_CONCURRENT_DOWNLOADS;
  
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? "OK" : "DEGRADED",
    timestamp: new Date().toISOString(),
    service: "YouTube Downloader - Render Optimized",
    version: "3.0",
    memory_usage_mb: memUsageMB,
    memory_threshold_mb: MEMORY_THRESHOLD_MB,
    active_downloads: activeDownloads,
    server_load: `${Math.round((activeDownloads / MAX_CONCURRENT_DOWNLOADS) * 100)}%`
  });
});

// Middleware 404
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint non trouvé",
    available_endpoints: [
      'GET /', 'GET /api-docs', 'GET /info', 'GET /info/:videoId',
      'GET /download', 'GET /download/:videoId', 'GET /api/stats', 'GET /api/health'
    ]
  });
});

// Middleware d'erreurs globales
app.use((err, req, res, next) => {
  errorCount++;
  console.error('🚨 Erreur Express:', err.message);
  res.status(500).json({ error: 'Erreur serveur interne' });
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`🚀 YouTube Downloader démarré sur le port ${PORT}`);
  console.log(`📊 Limites: ${MAX_CONCURRENT_DOWNLOADS} DL / ${MAX_CONCURRENT_INFO_REQUESTS} INFO`);
  console.log(`💾 Cache TTL: ${CACHE_TTL_MS / 1000 / 60}min`);
  console.log(`🍪 Cookies: ${hasCookies ? '✅' : '❌'}`);
  console.log(`🌐 Prêt à traiter les requêtes simultanées!`);
  
  // Nettoyage initial
  performCleanup();
});

// Gestion propre de l'arrêt
process.on('SIGINT', () => {
  console.log('\n👋 Arrêt du serveur...');
  console.log(`📊 Statistiques finales: ${totalRequests} requêtes, ${errorCount} erreurs`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🔄 Redémarrage serveur (SIGTERM)...');
  console.log(`📊 Statistiques: ${totalRequests} requêtes, ${errorCount} erreurs`);
  process.exit(0);
});

// Gestion des erreurs non capturées
process.on('uncaughtException', (err) => {
  console.error('💥 Exception non capturée:', err.message);
  console.error(err.stack);
  // En production, on peut choisir de continuer ou redémarrer
  if (process.env.NODE_ENV === 'production') {
    console.log('🔄 Redémarrage en cours...');
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Promesse rejetée non gérée:', reason);
  console.error('Promise:', promise);
  errorCount++;
});

// Optimisation pour Render - Garder le serveur actif
if (process.env.RENDER) {
  console.log('🌐 Détection Render - Optimisations appliquées');
  
  // Ping automatique pour éviter l'hibernation (toutes les 10 minutes)
  setInterval(() => {
    const memUsage = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(`💓 Keep-alive - Mem: ${memUsage}MB, DL: ${activeDownloads}, Info: ${activeInfoRequests}`);
  }, 10 * 60 * 1000);
  
  // Nettoyage plus agressif pour Render
  setInterval(() => {
    if (activeDownloads === 0 && activeInfoRequests === 0) {
      performCleanup();
      console.log('🧹 Nettoyage agressif Render effectué');
    }
  }, 2 * 60 * 1000); // Toutes les 2 minutes si inactif
}
