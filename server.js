const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const cookiesPath = path.join(__dirname, "cookies.txt");
const hasCookies = fs.existsSync(cookiesPath);

// ===============================
// CONFIGURATION OPTIMISÉE KOYEB
// ===============================

// Limites adaptées à Koyeb (512MB RAM, 0.1 vCPU)
const MAX_CONCURRENT_DOWNLOADS = 2;  // Réduit pour économiser la mémoire
const MAX_CONCURRENT_INFO_REQUESTS = 5; // Maintenu car moins coûteux
const MEMORY_THRESHOLD_MB = 400;
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes au lieu de 10
const INFO_TIMEOUT_MS = 15 * 1000; // 15 secondes au lieu de 300
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes au lieu de 1 heure

// Compteurs globaux
let activeDownloads = 0;
let activeInfoRequests = 0;
let totalRequests = 0;
let errorCount = 0;
let lastCleanup = Date.now();

// Cache optimisé avec limite de taille
const MAX_CACHE_SIZE = 100; // Maximum 100 entrées en cache
const videoInfoCache = new Map();

// Queues simplifiées
const downloadQueue = [];
const infoQueue = [];

// Middleware ultra-légers
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '100kb' })); // Réduit de 1mb à 100kb

// Middleware de monitoring mémoire optimisé
app.use((req, res, next) => {
  totalRequests++;
  
  // Vérification mémoire seulement toutes les 10 requêtes pour économiser les ressources
  if (totalRequests % 10 === 0) {
    const memUsageMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (memUsageMB > MEMORY_THRESHOLD_MB) {
      console.warn(`⚠️ Mémoire critique: ${memUsageMB}MB`);
      // Nettoyage d'urgence
      performEmergencyCleanup();
      return res.status(503).json({ 
        error: 'Serveur surchargé - Réessayez dans 30s', 
        retry_after: 30
      });
    }
  }
  
  // Headers simplifiés
  res.setHeader('X-Server-Load', `${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`);
  next();
});

if (!hasCookies) {
  console.warn("⚠️ Cookies non disponibles - Vidéos privées inaccessibles");
}

// ===============================
// UTILITAIRES OPTIMISÉS
// ===============================

function extractVideoId(url) {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/);
  return match ? match[1] : null;
}

function isValidYouTubeUrl(url) {
  return url && extractVideoId(url) !== null;
}

function buildYouTubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function formatFileSize(bytes) {
  if (!bytes) return 'N/A';
  const mb = Math.round(bytes / 1024 / 1024);
  return mb > 0 ? `${mb} MB` : `${Math.round(bytes / 1024)} KB`;
}

function sanitizeFilename(title) {
  return (title || 'video')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 40) // Réduit à 40 caractères
    .trim();
}

// Nettoyage optimisé pour serveur limité
function performCleanup() {
  const now = Date.now();
  let cleaned = 0;
  
  // Nettoyer le cache expiré
  for (const [key, value] of videoInfoCache.entries()) {
    if (now - value.timestamp > CACHE_TTL_MS) {
      videoInfoCache.delete(key);
      cleaned++;
    }
  }
  
  // Si le cache est trop grand, supprimer les plus anciens
  if (videoInfoCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(videoInfoCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    const toDelete = videoInfoCache.size - MAX_CACHE_SIZE;
    for (let i = 0; i < toDelete; i++) {
      videoInfoCache.delete(entries[i][0]);
      cleaned++;
    }
  }
  
  if (global.gc) global.gc();
  
  console.log(`🧹 Nettoyage: ${cleaned} entrées supprimées, cache: ${videoInfoCache.size}`);
  lastCleanup = now;
}

function performEmergencyCleanup() {
  // Vider complètement le cache en cas d'urgence
  videoInfoCache.clear();
  if (global.gc) global.gc();
  console.log('🚨 Nettoyage d\'urgence effectué');
}

// Nettoyage automatique
setInterval(performCleanup, CLEANUP_INTERVAL_MS);

// ===============================
// GESTION DES QUEUES OPTIMISÉE
// ===============================

function processDownloadQueue() {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS || downloadQueue.length === 0) {
    return;
  }
  
  const task = downloadQueue.shift();
  activeDownloads++;
  
  console.log(`📥 Traitement téléchargement (${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS})`);
  
  task.execute().finally(() => {
    activeDownloads--;
    // Traitement immédiat de la queue suivante
    setImmediate(processDownloadQueue);
  });
}

function processInfoQueue() {
  if (activeInfoRequests >= MAX_CONCURRENT_INFO_REQUESTS || infoQueue.length === 0) {
    return;
  }
  
  const task = infoQueue.shift();
  activeInfoRequests++;
  
  console.log(`📋 Traitement info (${activeInfoRequests}/${MAX_CONCURRENT_INFO_REQUESTS})`);
  
  task.execute().finally(() => {
    activeInfoRequests--;
    setImmediate(processInfoQueue);
  });
}

// ===============================
// FONCTIONS PRINCIPALES OPTIMISÉES
// ===============================

async function getVideoInfoCached(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('ID vidéo invalide');
  
  // Vérification cache en premier
  const cached = videoInfoCache.get(videoId);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    console.log(`💾 Cache hit: ${videoId}`);
    return cached.data;
  }
  
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Timeout lors de la récupération'));
      }
    }, INFO_TIMEOUT_MS);
    
    // Arguments optimisés pour serveur limité
    const args = [
      '--dump-json', 
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      url
    ];
    
    if (hasCookies) {
      args.splice(-1, 0, '--cookies', cookiesPath);
    }
    
    console.log(`🔍 Récupération info: ${videoId}`);
    const process = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let jsonData = '';
    let errorData = '';
    
    process.stdout.on('data', (data) => {
      jsonData += data.toString();
    });
    
    process.stderr.on('data', (data) => {
      errorData += data.toString();
    });
    
    process.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      
      if (code === 0 && jsonData.trim()) {
        try {
          const videoInfo = JSON.parse(jsonData);
          
          // Mise en cache réussie
          videoInfoCache.set(videoId, {
            data: videoInfo,
            timestamp: Date.now()
          });
          
          console.log(`✅ Info récupérée et mise en cache: ${videoId}`);
          resolve(videoInfo);
        } catch (e) {
          console.error(`❌ Erreur parsing JSON: ${e.message}`);
          reject(new Error('Données corrompues'));
        }
      } else {
        const error = errorData.includes('unavailable') ? 'Vidéo indisponible' :
                     errorData.includes('private') ? 'Vidéo privée' :
                     `Erreur récupération (code: ${code})`;
        console.error(`❌ ${error} - ${videoId}`);
        reject(new Error(error));
      }
    });
    
    process.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      console.error(`💥 Erreur processus: ${err.message}`);
      reject(new Error('Service temporairement indisponible'));
    });
  });
}

function formatVideoInfo(videoInfo) {
  const formats = [];
  
  // Audio simplifié
  const audioFormats = videoInfo.formats?.filter(f => f.acodec && f.acodec !== 'none') || [];
  if (audioFormats.length > 0) {
    const bestAudio = audioFormats.reduce((best, current) => 
      (current.abr || 0) > (best.abr || 0) ? current : best
    );
    formats.push({
      type: 'MP3 Audio',
      quality: `${bestAudio.abr || 128}kbps`,
      size: formatFileSize(bestAudio.filesize)
    });
  }
  
  // Vidéo optimisée - seulement les qualités essentielles
  const videoFormats = videoInfo.formats?.filter(f => f.vcodec && f.vcodec !== 'none' && f.height) || [];
  
  // Tri par qualité et sélection des meilleures options
  const qualities = [1080, 720, 480].map(height => {
    const format = videoFormats.find(f => f.height === height);
    return format ? {
      type: `MP4 ${height}p`,
      quality: `${height}p`,
      size: formatFileSize(format.filesize)
    } : null;
  }).filter(Boolean);
  
  formats.push(...qualities);
  
  // Durée formatée
  const duration = videoInfo.duration ? 
    `${Math.floor(videoInfo.duration / 60)}:${String(videoInfo.duration % 60).padStart(2, '0')}` : 
    'N/A';
  
  return {
    success: true,
    id: videoInfo.id,
    title: videoInfo.title || 'Titre indisponible',
    duration,
    thumbnail: videoInfo.thumbnail,
    uploader: videoInfo.uploader,
    view_count: videoInfo.view_count,
    formats,
    cached: true // Toujours true car on vient de le mettre en cache
  };
}

async function executeDownload(res, url, format, quality) {
  let hasStarted = false;
  let bytesTransferred = 0;
  
  const timeoutId = setTimeout(() => {
    if (!hasStarted) {
      throw new Error('Timeout de téléchargement');
    }
  }, REQUEST_TIMEOUT_MS);
  
  try {
    // Récupération rapide des infos (peut être depuis le cache)
    const videoInfo = await getVideoInfoCached(url);
    const safeTitle = sanitizeFilename(videoInfo.title);
    const extension = format === 'audio' ? 'mp3' : 'mp4';
    const filename = `${safeTitle}.${extension}`;

    // Headers optimisés
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', format === 'audio' ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');

    // Arguments yt-dlp ultra-optimisés pour serveur faible
    let args = ['--no-warnings', '--quiet', '--no-playlist'];
    
    if (hasCookies) {
      args.push('--cookies', cookiesPath);
    }

    if (format === 'audio') {
      args.push(
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '128K', // Réduit de 192K à 128K
        '--format', 'bestaudio[ext=m4a]/bestaudio'
      );
    } else {
      let formatSelector = 'best[height<=720][ext=mp4]/best[height<=720]'; // Par défaut 720p max
      
      switch(quality) {
        case '1080':
          formatSelector = 'best[height<=1080][ext=mp4]/best[height<=1080]';
          break;
        case '480':
          formatSelector = 'best[height<=480][ext=mp4]/best[height<=480]';
          break;
      }
      
      args.push('--format', formatSelector);
    }

    args.push('-o', '-', url);

    console.log(`🚀 Début téléchargement: ${filename.substring(0, 20)}...`);
    hasStarted = true;

    const ytProcess = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let errorOutput = '';

    ytProcess.stdout.on('data', (chunk) => {
      bytesTransferred += chunk.length;
      res.write(chunk);
    });

    ytProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    return new Promise((resolve, reject) => {
      ytProcess.on('close', (code) => {
        clearTimeout(timeoutId);
        
        if (code === 0) {
          console.log(`✅ Téléchargement terminé: ${Math.round(bytesTransferred / 1024 / 1024)}MB`);
          res.end();
          resolve();
        } else {
          console.error(`❌ Échec téléchargement (${code}): ${errorOutput.substring(0, 50)}`);
          if (bytesTransferred === 0) {
            reject(new Error('Échec du téléchargement'));
          } else {
            res.end();
            resolve();
          }
        }
      });

      ytProcess.on('error', (err) => {
        clearTimeout(timeoutId);
        console.error(`💥 Erreur processus: ${err.message}`);
        if (bytesTransferred === 0) {
          reject(new Error('Service indisponible'));
        } else {
          res.end();
          resolve();
        }
      });
    });

  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// ===============================
// ROUTES OPTIMISÉES
// ===============================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Documentation simplifiée
app.get("/api-docs", (req, res) => {
  res.json({
    title: "YouTube Downloader API - Koyeb Optimized",
    version: "4.0",
    server_info: {
      downloads: `${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`,
      info_requests: `${activeInfoRequests}/${MAX_CONCURRENT_INFO_REQUESTS}`,
      memory: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
      cache: videoInfoCache.size
    },
    endpoints: {
      "GET /info?url=URL": "Informations vidéo",
      "GET /info/:videoId": "Informations par ID",
      "GET /download?url=URL&format=audio/video&quality=480/720/1080": "Téléchargement",
      "GET /download/:videoId?format=audio/video&quality=480/720/1080": "Téléchargement par ID"
    }
  });
});

// Routes info optimisées
app.get("/info", (req, res) => {
  const { url } = req.query;
  
  if (!url || !isValidYouTubeUrl(url)) {
    errorCount++;
    return res.status(400).json({ 
      success: false, 
      error: 'URL YouTube requise' 
    });
  }
  
  handleInfoRequest(res, url);
});

app.get("/info/:videoId", (req, res) => {
  const { videoId } = req.params;
  
  if (!videoId) {
    errorCount++;
    return res.status(400).json({ 
      success: false, 
      error: 'ID vidéo requis' 
    });
  }
  
  const url = buildYouTubeUrl(videoId);
  handleInfoRequest(res, url);
});

async function handleInfoRequest(res, url) {
  if (activeInfoRequests >= MAX_CONCURRENT_INFO_REQUESTS) {
    infoQueue.push({
      execute: () => handleInfoRequest(res, url)
    });
    
    return res.status(202).json({
      success: false,
      message: 'Requête en attente',
      queue_position: infoQueue.length
    });
  }
  
  activeInfoRequests++;
  
  try {
    const videoInfo = await getVideoInfoCached(url);
    const formattedInfo = formatVideoInfo(videoInfo);
    res.json(formattedInfo);
  } catch (error) {
    errorCount++;
    console.error('❌ Erreur info:', error.message);
    res.status(error.message.includes('indisponible') ? 404 : 
               error.message.includes('privée') ? 403 : 500).json({ 
      success: false, 
      error: error.message
    });
  } finally {
    activeInfoRequests--;
    processInfoQueue();
  }
}

// Routes téléchargement optimisées
app.get("/download/:videoId", (req, res) => {
  const { videoId } = req.params;
  const { format = 'video', quality = '720' } = req.query; // Par défaut 720p
  
  if (!videoId) {
    errorCount++;
    return res.status(400).json({ error: 'ID vidéo requis' });
  }
  
  const url = buildYouTubeUrl(videoId);
  handleDownloadRequest(res, url, format, quality);
});

app.get("/download", (req, res) => {
  const { url, format = 'video', quality = '720' } = req.query;
  
  if (!url || !isValidYouTubeUrl(url)) {
    errorCount++;
    return res.status(400).json({ error: 'URL YouTube requise' });
  }
  
  handleDownloadRequest(res, url, format, quality);
});

function handleDownloadRequest(res, url, format, quality) {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    downloadQueue.push({
      execute: () => executeDownloadWrapper(res, url, format, quality)
    });
    
    return res.status(202).json({
      error: 'Téléchargement en attente',
      queue_position: downloadQueue.length,
      estimated_wait: `${downloadQueue.length * 90}s`
    });
  }
  
  executeDownloadWrapper(res, url, format, quality);
}

async function executeDownloadWrapper(res, url, format, quality) {
  activeDownloads++;
  
  try {
    await executeDownload(res, url, format, quality);
  } catch (error) {
    errorCount++;
    console.error('💀 Erreur téléchargement:', error.message);
    if (!res.headersSent) {
      res.status(error.message.includes('indisponible') ? 404 :
                 error.message.includes('privée') ? 403 :
                 error.message.includes('Timeout') ? 408 : 500)
         .json({ error: error.message });
    }
  } finally {
    activeDownloads--;
    processDownloadQueue();
  }
}

// Stats simplifiées
app.get("/api/stats", (req, res) => {
  const mem = process.memoryUsage();
  
  res.json({
    version: "4.0-koyeb",
    uptime: Math.round(process.uptime()),
    performance: {
      downloads: `${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`,
      info: `${activeInfoRequests}/${MAX_CONCURRENT_INFO_REQUESTS}`,
      queues: `DL:${downloadQueue.length} INFO:${infoQueue.length}`
    },
    memory: `${Math.round(mem.rss / 1024 / 1024)}MB`,
    cache: videoInfoCache.size,
    requests: totalRequests,
    errors: errorCount
  });
});

// Health check ultra-simple
app.get("/health", (req, res) => {
  const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  res.status(memMB < MEMORY_THRESHOLD_MB ? 200 : 503).json({
    status: memMB < MEMORY_THRESHOLD_MB ? "OK" : "OVERLOAD",
    memory: `${memMB}MB`
  });
});

// 404 simplifié
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint introuvable" });
});

// Gestion d'erreur globale
app.use((err, req, res, next) => {
  errorCount++;
  console.error('🚨 Erreur:', err.message);
  res.status(500).json({ error: 'Erreur serveur' });
});

// Démarrage optimisé
app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`📊 Limits: ${MAX_CONCURRENT_DOWNLOADS} DL / ${MAX_CONCURRENT_INFO_REQUESTS} INFO`);
  console.log(`💾 Cache: ${MAX_CACHE_SIZE} entries, TTL: ${CACHE_TTL_MS / 60000}min`);
  console.log(`🍪 Cookies: ${hasCookies ? '✅' : '❌'}`);
  console.log(`⚡ Optimized for Koyeb (512MB RAM)`);
  
  performCleanup();
});

// Gestion des arrêts
process.on('SIGINT', () => {
  console.log('\n👋 Arrêt serveur...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🔄 Redémarrage...');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('💥 Exception:', err.message);
  if (process.env.NODE_ENV === 'production') {
    console.log('🔄 Restart...');
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Promise rejected:', reason);
  errorCount++;
});

// Optimisations spécifiques Koyeb
if (process.env.KOYEB || process.env.NODE_ENV === 'production') {
  console.log('🌐 Koyeb optimizations enabled');
  
  // Keep-alive moins fréquent pour économiser les ressources
  setInterval(() => {
    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(`💓 Keep-alive - ${memMB}MB, DL:${activeDownloads}, INFO:${activeInfoRequests}`);
  }, 15 * 60 * 1000); // 15 minutes
  
  // Nettoyage plus fréquent si inactif
  setInterval(() => {
    if (activeDownloads === 0 && activeInfoRequests === 0) {
      performCleanup();
    }
  }, 60 * 1000); // 1 minute
}
