const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const cluster = require("cluster");
const os = require("os");
const EventEmitter = require("events");
const crypto = require("crypto");

// Configuration avancée
const CONFIG = {
  MAX_CONCURRENT_DOWNLOADS: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS) || 50,
  MAX_CONCURRENT_INFO_REQUESTS: parseInt(process.env.MAX_CONCURRENT_INFO_REQUESTS) || 100,
  MAX_QUEUE_SIZE: parseInt(process.env.MAX_QUEUE_SIZE) || 1000,
  REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT) || 900000, // 15 minutes
  INFO_REQUEST_TIMEOUT: parseInt(process.env.INFO_REQUEST_TIMEOUT) || 300000, // 5 minutes
  RATE_LIMIT_WINDOW: parseInt(process.env.RATE_LIMIT_WINDOW) || 60000, // 1 minute
  RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  MEMORY_THRESHOLD: 0.85, // 85% de la mémoire disponible
  CPU_THRESHOLD: 0.90, // 90% du CPU
  CLEANUP_INTERVAL: 30000, // 30 secondes
  PROCESS_RESTART_THRESHOLD: 1000 // Redémarrer après 1000 requêtes
};

// Gestionnaire de processus et clustering
class ProcessManager {
  constructor() {
    this.numCPUs = os.cpus().length;
    this.maxWorkers = Math.min(this.numCPUs, parseInt(process.env.MAX_WORKERS) || this.numCPUs);
    this.workers = new Map();
    this.requestCount = 0;
  }

  setupCluster() {
    if (cluster.isMaster) {
      console.log(`🚀 Master ${process.pid} démarrage avec ${this.maxWorkers} workers`);
      
      // Créer les workers
      for (let i = 0; i < this.maxWorkers; i++) {
        this.forkWorker();
      }

      // Gestion de la mort des workers
      cluster.on('exit', (worker, code, signal) => {
        console.log(`💀 Worker ${worker.process.pid} mort (${signal || code})`);
        this.workers.delete(worker.id);
        
        // Redémarrer automatiquement
        setTimeout(() => {
          this.forkWorker();
        }, 1000);
      });

      // Monitoring des ressources
      this.startResourceMonitoring();
      
      return false; // Master ne lance pas l'app
    }
    
    return true; // Worker lance l'app
  }

  forkWorker() {
    const worker = cluster.fork();
    this.workers.set(worker.id, {
      worker,
      requests: 0,
      startTime: Date.now()
    });

    worker.on('message', (msg) => {
      if (msg.type === 'request_count') {
        const workerInfo = this.workers.get(worker.id);
        if (workerInfo) {
          workerInfo.requests = msg.count;
          
          // Redémarrer si trop de requêtes
          if (msg.count > CONFIG.PROCESS_RESTART_THRESHOLD) {
            console.log(`🔄 Redémarrage worker ${worker.process.pid} (${msg.count} requêtes)`);
            worker.kill('SIGTERM');
          }
        }
      }
    });
  }

  startResourceMonitoring() {
    setInterval(() => {
      const memUsage = process.memoryUsage();
      const memPercent = memUsage.rss / (os.totalmem() * CONFIG.MEMORY_THRESHOLD);
      
      if (memPercent > 1) {
        console.log(`⚠️ Mémoire critique: ${Math.round(memPercent * 100)}%`);
        // Redémarrer les workers les plus anciens
        this.restartOldestWorker();
      }

      // Statistiques
      console.log(`📊 Workers actifs: ${this.workers.size}, Mémoire: ${Math.round(memUsage.rss / 1024 / 1024)}MB`);
    }, CONFIG.CLEANUP_INTERVAL);
  }

  restartOldestWorker() {
    let oldest = null;
    let oldestTime = Date.now();

    for (const [id, info] of this.workers) {
      if (info.startTime < oldestTime) {
        oldest = info.worker;
        oldestTime = info.startTime;
      }
    }

    if (oldest) {
      oldest.kill('SIGTERM');
    }
  }
}

// Gestionnaire de file d'attente avancé
class QueueManager extends EventEmitter {
  constructor() {
    super();
    this.downloadQueue = [];
    this.infoQueue = [];
    this.activeDownloads = new Map();
    this.activeInfoRequests = new Map();
    this.stats = {
      totalRequests: 0,
      completedRequests: 0,
      failedRequests: 0,
      queuedRequests: 0
    };
    
    this.startProcessing();
    this.startCleanup();
  }

  addDownloadRequest(req, res, params) {
    const requestId = crypto.randomUUID();
    const request = {
      id: requestId,
      req,
      res,
      params,
      timestamp: Date.now(),
      type: 'download',
      retries: 0
    };

    if (this.downloadQueue.length >= CONFIG.MAX_QUEUE_SIZE) {
      res.status(503).json({ 
        error: 'Serveur surchargé, réessayez plus tard',
        queue_size: this.downloadQueue.length
      });
      return;
    }

    this.downloadQueue.push(request);
    this.stats.totalRequests++;
    this.stats.queuedRequests++;
    
    console.log(`📥 Téléchargement en queue: ${requestId} (Queue: ${this.downloadQueue.length})`);
    return requestId;
  }

  addInfoRequest(req, res, params) {
    const requestId = crypto.randomUUID();
    const request = {
      id: requestId,
      req,
      res,
      params,
      timestamp: Date.now(),
      type: 'info',
      retries: 0
    };

    if (this.infoQueue.length >= CONFIG.MAX_QUEUE_SIZE) {
      res.status(503).json({ 
        error: 'Serveur surchargé, réessayez plus tard',
        queue_size: this.infoQueue.length
      });
      return;
    }

    this.infoQueue.push(request);
    this.stats.totalRequests++;
    this.stats.queuedRequests++;
    
    console.log(`📋 Info en queue: ${requestId} (Queue: ${this.infoQueue.length})`);
    return requestId;
  }

  startProcessing() {
    // Traitement des téléchargements
    setInterval(() => {
      if (this.downloadQueue.length > 0 && this.activeDownloads.size < CONFIG.MAX_CONCURRENT_DOWNLOADS) {
        const request = this.downloadQueue.shift();
        this.processDownloadRequest(request);
      }
    }, 100);

    // Traitement des demandes d'info
    setInterval(() => {
      if (this.infoQueue.length > 0 && this.activeInfoRequests.size < CONFIG.MAX_CONCURRENT_INFO_REQUESTS) {
        const request = this.infoQueue.shift();
        this.processInfoRequest(request);
      }
    }, 50);
  }

  async processDownloadRequest(request) {
    this.activeDownloads.set(request.id, request);
    this.stats.queuedRequests--;
    
    try {
      console.log(`🚀 Traitement téléchargement: ${request.id}`);
      await downloadVideo(request.res, request.params.url, request.params.format, request.params.quality, request.id);
      this.stats.completedRequests++;
    } catch (error) {
      console.error(`❌ Erreur téléchargement ${request.id}:`, error.message);
      this.handleRequestFailure(request, error);
    } finally {
      this.activeDownloads.delete(request.id);
    }
  }

  async processInfoRequest(request) {
    this.activeInfoRequests.set(request.id, request);
    this.stats.queuedRequests--;
    
    try {
      console.log(`🚀 Traitement info: ${request.id}`);
      const videoInfo = await getVideoInfo(request.params.url);
      const formattedInfo = formatVideoInfo(videoInfo);
      request.res.json(formattedInfo);
      this.stats.completedRequests++;
    } catch (error) {
      console.error(`❌ Erreur info ${request.id}:`, error.message);
      this.handleRequestFailure(request, error);
    } finally {
      this.activeInfoRequests.delete(request.id);
    }
  }

  handleRequestFailure(request, error) {
    request.retries++;
    
    if (request.retries < 3 && !request.res.headersSent) {
      // Remettre en queue avec délai
      setTimeout(() => {
        if (request.type === 'download') {
          this.downloadQueue.unshift(request);
        } else {
          this.infoQueue.unshift(request);
        }
        this.stats.queuedRequests++;
      }, 1000 * request.retries);
    } else {
      this.stats.failedRequests++;
      if (!request.res.headersSent) {
        request.res.status(500).json({ 
          error: error.message,
          request_id: request.id,
          retries: request.retries
        });
      }
    }
  }

  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      
      // Nettoyer les requêtes expirées
      this.downloadQueue = this.downloadQueue.filter(req => {
        if (now - req.timestamp > CONFIG.REQUEST_TIMEOUT) {
          if (!req.res.headersSent) {
            req.res.status(408).json({ error: 'Timeout de la requête' });
          }
          this.stats.failedRequests++;
          this.stats.queuedRequests--;
          return false;
        }
        return true;
      });

      this.infoQueue = this.infoQueue.filter(req => {
        if (now - req.timestamp > CONFIG.INFO_REQUEST_TIMEOUT) {
          if (!req.res.headersSent) {
            req.res.status(408).json({ error: 'Timeout de la requête' });
          }
          this.stats.failedRequests++;
          this.stats.queuedRequests--;
          return false;
        }
        return true;
      });

      // Nettoyer les requêtes actives bloquées
      for (const [id, request] of this.activeDownloads) {
        if (now - request.timestamp > CONFIG.REQUEST_TIMEOUT) {
          console.log(`🧹 Nettoyage téléchargement bloqué: ${id}`);
          this.activeDownloads.delete(id);
          this.stats.failedRequests++;
        }
      }

      for (const [id, request] of this.activeInfoRequests) {
        if (now - request.timestamp > CONFIG.INFO_REQUEST_TIMEOUT) {
          console.log(`🧹 Nettoyage info bloquée: ${id}`);
          this.activeInfoRequests.delete(id);
          this.stats.failedRequests++;
        }
      }
    }, CONFIG.CLEANUP_INTERVAL);
  }

  getStats() {
    return {
      ...this.stats,
      activeDownloads: this.activeDownloads.size,
      activeInfoRequests: this.activeInfoRequests.size,
      downloadQueue: this.downloadQueue.length,
      infoQueue: this.infoQueue.length
    };
  }
}

// Système de limitation de taux (Rate Limiting)
class RateLimiter {
  constructor() {
    this.clients = new Map();
    this.cleanup();
  }

  isAllowed(clientIp) {
    const now = Date.now();
    const client = this.clients.get(clientIp) || { requests: [], blocked: false };
    
    // Nettoyer les anciennes requêtes
    client.requests = client.requests.filter(time => now - time < CONFIG.RATE_LIMIT_WINDOW);
    
    if (client.requests.length >= CONFIG.RATE_LIMIT_MAX_REQUESTS) {
      client.blocked = true;
      return false;
    }
    
    client.requests.push(now);
    this.clients.set(clientIp, client);
    return true;
  }

  cleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [ip, client] of this.clients) {
        client.requests = client.requests.filter(time => now - time < CONFIG.RATE_LIMIT_WINDOW);
        if (client.requests.length === 0) {
          this.clients.delete(ip);
        } else {
          client.blocked = false;
        }
      }
    }, CONFIG.RATE_LIMIT_WINDOW);
  }
}

// Cache intelligent pour les informations de vidéos
class VideoInfoCache {
  constructor() {
    this.cache = new Map();
    this.maxSize = 10000;
    this.ttl = 3600000; // 1 heure
    this.startCleanup();
  }

  get(videoId) {
    const entry = this.cache.get(videoId);
    if (!entry) return null;
    
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(videoId);
      return null;
    }
    
    entry.hits++;
    return entry.data;
  }

  set(videoId, data) {
    // Éviter le dépassement de taille
    if (this.cache.size >= this.maxSize) {
      // Supprimer les entrées les moins utilisées
      const entries = Array.from(this.cache.entries());
      entries.sort((a, b) => a[1].hits - b[1].hits);
      const toDelete = entries.slice(0, Math.floor(this.maxSize * 0.1));
      toDelete.forEach(([key]) => this.cache.delete(key));
    }

    this.cache.set(videoId, {
      data,
      timestamp: Date.now(),
      hits: 0
    });
  }

  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (now - entry.timestamp > this.ttl) {
          this.cache.delete(key);
        }
      }
    }, CONFIG.CLEANUP_INTERVAL);
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: this.calculateHitRate()
    };
  }

  calculateHitRate() {
    const entries = Array.from(this.cache.values());
    if (entries.length === 0) return 0;
    const totalHits = entries.reduce((sum, entry) => sum + entry.hits, 0);
    return totalHits / entries.length;
  }
}

// Initialisation des gestionnaires globaux
const processManager = new ProcessManager();
const queueManager = new QueueManager();
const rateLimiter = new RateLimiter();
const videoCache = new VideoInfoCache();

// Vérifier si on doit lancer le clustering
if (!processManager.setupCluster()) {
  process.exit(0); // Master sort, les workers continuent
}

const app = express();
const PORT = process.env.PORT || 3000;
const cookiesPath = path.join(__dirname, "cookies.txt");
const hasCookies = fs.existsSync(cookiesPath);

// Middleware pour compter les requêtes du worker
let workerRequestCount = 0;

// Servir les fichiers statiques depuis le dossier public
app.use(express.static(path.join(__dirname, 'public')));

// Middleware pour parser le JSON avec limite de taille
app.use(express.json({ limit: '1mb' }));

// Middleware de monitoring des performances
app.use((req, res, next) => {
  req.startTime = Date.now();
  req.requestId = crypto.randomUUID();
  
  // Compter les requêtes du worker
  workerRequestCount++;
  if (workerRequestCount % 100 === 0) {
    process.send({ type: 'request_count', count: workerRequestCount });
  }

  res.on('finish', () => {
    const duration = Date.now() - req.startTime;
    console.log(`🔍 ${req.method} ${req.path} - ${res.statusCode} - ${duration}ms - ${req.requestId}`);
  });
  
  next();
});

// Middleware de rate limiting
app.use((req, res, next) => {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  
  if (!rateLimiter.isAllowed(clientIp)) {
    return res.status(429).json({
      error: 'Trop de requêtes',
      message: `Limite de ${CONFIG.RATE_LIMIT_MAX_REQUESTS} requêtes par minute atteinte`,
      retry_after: Math.ceil(CONFIG.RATE_LIMIT_WINDOW / 1000)
    });
  }
  
  next();
});

// Middleware de vérification de santé du serveur
app.use((req, res, next) => {
  const memUsage = process.memoryUsage();
  const memPercent = memUsage.rss / os.totalmem();
  
  if (memPercent > CONFIG.MEMORY_THRESHOLD) {
    return res.status(503).json({
      error: 'Serveur surchargé',
      message: 'Ressources insuffisantes, réessayez plus tard'
    });
  }
  
  next();
});

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

// Fonction pour obtenir les informations de la vidéo avec cache
async function getVideoInfo(url) {
  const videoId = extractVideoId(url);
  
  // Vérifier le cache
  if (videoId) {
    const cached = videoCache.get(videoId);
    if (cached) {
      console.log(`💾 Cache hit pour: ${videoId}`);
      return cached;
    }
  }

  return new Promise((resolve, reject) => {
    const infoArgs = [
      '--dump-json',
      '--no-playlist',
      url
    ];
    
    if (hasCookies) {
      infoArgs.unshift('--cookies', cookiesPath);
    }
    
    const infoProcess = spawn('yt-dlp', infoArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let jsonData = '';
    let errorData = '';
    let isResolved = false;
    
    infoProcess.stdout.on('data', (data) => {
      jsonData += data.toString();
    });
    
    infoProcess.stderr.on('data', (data) => {
      errorData += data.toString();
    });
    
    infoProcess.on('close', (code) => {
      if (isResolved) return;
      isResolved = true;
      
      if (code === 0 && jsonData.trim()) {
        try {
          const videoInfo = JSON.parse(jsonData);
          
          // Mettre en cache
          if (videoId) {
            videoCache.set(videoId, videoInfo);
          }
          
          resolve(videoInfo);
        } catch (e) {
          reject(new Error('Erreur parsing JSON: ' + e.message));
        }
      } else {
        reject(new Error('Erreur obtention infos: ' + errorData));
      }
    });
    
    infoProcess.on('error', (error) => {
      if (isResolved) return;
      isResolved = true;
      reject(new Error('Erreur processus: ' + error.message));
    });
    
    // Timeout de sécurité
    setTimeout(() => {
      if (!isResolved && !infoProcess.killed) {
        isResolved = true;
        infoProcess.kill('SIGTERM');
        reject(new Error('Timeout lors de la récupération des informations'));
      }
    }, CONFIG.INFO_REQUEST_TIMEOUT);
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

// Fonction commune de téléchargement optimisée
async function downloadVideo(res, url, format, quality, requestId) {
  // Validation
  if (!url) {
    return res.status(400).json({ error: "URL manquante", request_id: requestId });
  }
  
  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: "URL YouTube invalide", request_id: requestId });
  }

  console.log(`📥 Traitement: ${format || 'video'} | ${quality || 'best'} | ${url.substring(0, 50)}... | ${requestId}`);

  try {
    // Obtenir les infos de la vidéo (avec cache)
    const videoInfo = await getVideoInfo(url);
    const safeTitle = (videoInfo.title || 'video')
      .replace(/[^\w\s.-]/g, '')
      .substring(0, 50)
      .trim();
    
    const extension = format === 'audio' ? 'mp3' : 'mp4';
    const filename = `${safeTitle}_${Date.now()}.${extension}`;

    // Headers de réponse optimisés
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', format === 'audio' ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Construction des arguments yt-dlp optimisés
    let args = [
      '--no-warnings',
      '--no-playlist',
      '--prefer-ffmpeg',
      '--ffmpeg-location', '/usr/bin/ffmpeg'
    ];
    
    if (hasCookies) {
      args.push('--cookies', cookiesPath);
    }

    // Configuration spécifique selon le format
    if (format === 'audio') {
      args.push(
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '192K',
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

    // Sortie vers stdout
    args.push('-o', '-', url);

    console.log(`🔧 Worker ${process.pid} - Commande: yt-dlp ${args.join(' ')}`);

    // Lancement du processus yt-dlp avec optimisations
    const ytProcess = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    let hasData = false;
    let errorOutput = '';
    let totalBytes = 0;
    let isFinished = false;

    // Gestion optimisée du flux de données
    ytProcess.stdout.on('data', (chunk) => {
      if (isFinished) return;
      
      hasData = true;
      totalBytes += chunk.length;
      
      try {
        res.write(chunk);
      } catch (error) {
        console.error(`📛 Erreur écriture chunk ${requestId}:`, error.message);
        if (!isFinished) {
          isFinished = true;
          ytProcess.kill('SIGTERM');
        }
      }
    });

    ytProcess.stderr.on('data', (data) => {
      const errorMsg = data.toString();
      errorOutput += errorMsg;
      
      // Log seulement les erreurs importantes
      if (errorMsg.includes('ERROR') || errorMsg.includes('WARNING')) {
        console.error(`📛 yt-dlp ${requestId}:`, errorMsg.trim());
      }
    });

    ytProcess.on('close', (code) => {
      if (isFinished) return;
      isFinished = true;
      
      if (code === 0) {
        console.log(`✅ Téléchargement réussi: ${filename} (${totalBytes} bytes) - ${requestId}`);
      } else {
        console.error(`❌ Échec téléchargement ${requestId} (code: ${code})`);
        if (!hasData && !res.headersSent) {
          if (errorOutput.includes('Video unavailable')) {
            res.status(404).json({ error: 'Vidéo indisponible', request_id: requestId });
          } else if (errorOutput.includes('Private video')) {
            res.status(403).json({ error: 'Vidéo privée', request_id: requestId });
          } else {
            res.status(500).json({ 
              error: 'Erreur de téléchargement', 
              details: errorOutput.substring(0, 200),
              request_id: requestId 
            });
          }
          return;
        }
      }
      
      try {
        res.end();
      } catch (error) {
        console.error(`📛 Erreur fin réponse ${requestId}:`, error.message);
      }
    });

    ytProcess.on('error', (err) => {
      if (isFinished) return;
      isFinished = true;
      
      console.error(`💥 Erreur processus ${requestId}:`, err.message);
      if (!hasData && !res.headersSent) {
        res.status(500).json({ 
          error: 'Erreur serveur: yt-dlp non trouvé', 
          request_id: requestId 
        });
      }
      try {
        res.end();
      } catch (error) {
        console.error(`📛 Erreur fin réponse après erreur ${requestId}:`, error.message);
      }
    });

    // Timeout de sécurité optimisé
    const timeout = setTimeout(() => {
      if (!isFinished && !ytProcess.killed) {
        isFinished = true;
        ytProcess.kill('SIGTERM');
        console.log(`⏰ Timeout téléchargement ${requestId}`);
        if (!hasData && !res.headersSent) {
          res.status(408).json({ 
            error: 'Timeout de téléchargement', 
            request_id: requestId 
          });
        }
      }
    }, CONFIG.REQUEST_TIMEOUT);

    // Gestion de la déconnexion client
    res.on('close', () => {
      if (!isFinished) {
        isFinished = true;
        clearTimeout(timeout);
        ytProcess.kill('SIGTERM');
        console.log(`🔌 Client déconnecté ${requestId}`);
      }
    });

    res.on('error', (error) => {
      if (!isFinished) {
        isFinished = true;
        clearTimeout(timeout);
        ytProcess.kill('SIGTERM');
        console.error(`📛 Erreur réponse ${requestId}:`, error.message);
      }
    });

  } catch (error) {
    console.error(`💀 Erreur globale ${requestId}:`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Erreur interne: ' + error.message, 
        request_id: requestId 
      });
    }
  }
}

// ====================
// ROUTES OPTIMISÉES
// ====================

// Route pour la page d'accueil
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route pour la documentation API améliorée
app.get("/api-docs", (req, res) => {
  const docs = {
    title: "YouTube Downloader API Ultra-Puissant",
    version: "3.0",
    description: "API haute performance pour télécharger des vidéos YouTube avec clustering et mise en queue",
    architecture: {
      clustering: `${os.cpus().length} workers`,
      max_concurrent_downloads: CONFIG.MAX_CONCURRENT_DOWNLOADS,
      max_concurrent_info_requests: CONFIG.MAX_CONCURRENT_INFO_REQUESTS,
      max_queue_size: CONFIG.MAX_QUEUE_SIZE,
      rate_limit: `${CONFIG.RATE_LIMIT_MAX_REQUESTS} req/min`,
      cache_enabled: true
    },
    endpoints: {
      "GET /info": {
        description: "Récupérer les informations d'une vidéo avec URL complète (avec cache)",
        parameters: {
          url: "URL YouTube complète (obligatoire)"
        },
        example: "/info?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"
      },
      "GET /info/:videoId": {
        description: "Récupérer les informations d'une vidéo avec ID (avec cache)",
        parameters: {
          videoId: "ID de la vidéo YouTube (obligatoire)"
        },
        example: "/info/dQw4w9WgXcQ"
      },
      "GET /download": {
        description: "Télécharger avec URL complète (mise en queue automatique)",
        parameters: {
          url: "URL YouTube complète (obligatoire)",
          format: "video ou audio (optionnel, défaut: video)",
          quality: "best, 1080, 720, 480 (optionnel, défaut: best)"
        },
        example: "/download?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=audio"
      },
      "GET /download/:videoId": {
        description: "Télécharger avec ID de vidéo (mise en queue automatique)",
        parameters: {
          videoId: "ID de la vidéo YouTube (obligatoire)",
          format: "video ou audio (optionnel, défaut: video)",
          quality: "best, 1080, 720, 480 (optionnel, défaut: best)"
        },
        example: "/download/dQw4w9WgXcQ?format=video&quality=720"
      },
      "GET /api/download-url": {
        description: "Téléchargement direct avec URL (alias avec mise en queue)",
        parameters: {
          url: "URL YouTube complète (obligatoire)",
          format: "video ou audio (optionnel, défaut: video)",
          quality: "best, 1080, 720, 480 (optionnel, défaut: best)"
        },
        example: "/api/download-url?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=audio"
      },
      "GET /api/stats": {
        description: "Statistiques détaillées du serveur et des performances",
        example: "/api/stats"
      },
      "GET /api/health": {
        description: "Vérification de santé du serveur avec métriques",
        example: "/api/health"
      }
    },
    performance_tips: [
      "Les requêtes sont automatiquement mises en queue pour éviter la surcharge",
      "Le cache intelligent réduit les appels répétés pour les mêmes vidéos",
      "Rate limiting automatique pour éviter l'abus",
      "Clustering multi-processus pour la haute disponibilité",
      "Timeout automatique et nettoyage des ressources",
      "Surveillance continue des performances système"
    ]
  };
  
  res.json(docs);
});

// Route pour obtenir les informations de la vidéo avec URL (avec mise en queue)
app.get("/info", async (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ success: false, error: 'Paramètre URL manquant' });
  }
  
  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ success: false, error: 'URL YouTube invalide' });
  }
  
  // Mise en queue de la requête d'information
  const requestId = queueManager.addInfoRequest(req, res, { url });
  
  if (!requestId) {
    return; // Réponse déjà envoyée par le gestionnaire de queue
  }
  
  console.log(`📋 Info en queue: ${url.substring(0, 50)}... - ${requestId}`);
});

// Route pour obtenir les informations de la vidéo avec ID (avec mise en queue)
app.get("/info/:videoId", async (req, res) => {
  const { videoId } = req.params;
  
  if (!videoId) {
    return res.status(400).json({ success: false, error: 'ID de vidéo manquant' });
  }
  
  // Construire l'URL à partir de l'ID
  const url = buildYouTubeUrl(videoId);
  
  // Mise en queue de la requête d'information
  const requestId = queueManager.addInfoRequest(req, res, { url });
  
  if (!requestId) {
    return; // Réponse déjà envoyée par le gestionnaire de queue
  }
  
  console.log(`📋 Info par ID en queue: ${videoId} - ${requestId}`);
});

// Route de téléchargement direct avec ID vidéo (avec mise en queue)
app.get("/download/:videoId", async (req, res) => {
  const { videoId } = req.params;
  const { format = 'video', quality = 'best' } = req.query;
  
  if (!videoId) {
    return res.status(400).json({ error: 'ID de vidéo manquant' });
  }
  
  // Construire l'URL YouTube à partir de l'ID
  const url = buildYouTubeUrl(videoId);
  
  // Mise en queue de la requête de téléchargement
  const requestId = queueManager.addDownloadRequest(req, res, { url, format, quality });
  
  if (!requestId) {
    return; // Réponse déjà envoyée par le gestionnaire de queue
  }
  
  console.log(`📥 Téléchargement direct en queue: ${videoId} | ${format} | ${quality} - ${requestId}`);
});

// Route de téléchargement classique avec URL complète (avec mise en queue)
app.get("/download", async (req, res) => {
  const { url, format = 'video', quality = 'best' } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'URL manquante' });
  }
  
  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'URL YouTube invalide' });
  }
  
  // Mise en queue de la requête de téléchargement
  const requestId = queueManager.addDownloadRequest(req, res, { url, format, quality });
  
  if (!requestId) {
    return; // Réponse déjà envoyée par le gestionnaire de queue
  }
  
  console.log(`📥 Téléchargement classique en queue: ${format} | ${quality} - ${requestId}`);
});

// Route API alternative pour le téléchargement avec URL (avec mise en queue)
app.get("/api/download-url", async (req, res) => {
  const { url, format = 'video', quality = 'best' } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'URL manquante' });
  }
  
  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'URL YouTube invalide' });
  }
  
  // Mise en queue de la requête de téléchargement
  const requestId = queueManager.addDownloadRequest(req, res, { url, format, quality });
  
  if (!requestId) {
    return; // Réponse déjà envoyée par le gestionnaire de queue
  }
  
  console.log(`📥 API téléchargement URL en queue: ${format} | ${quality} - ${requestId}`);
});

// Route pour obtenir des statistiques avancées du serveur
app.get("/api/stats", (req, res) => {
  const memUsage = process.memoryUsage();
  const queueStats = queueManager.getStats();
  const cacheStats = videoCache.getStats();
  
  const stats = {
    server: "YouTube Downloader API Ultra-Puissant",
    version: "3.0",
    worker_pid: process.pid,
    uptime: process.uptime(),
    system: {
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      total_memory: Math.round(os.totalmem() / 1024 / 1024) + 'MB',
      free_memory: Math.round(os.freemem() / 1024 / 1024) + 'MB'
    },
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
      heap_used: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heap_total: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
      external: Math.round(memUsage.external / 1024 / 1024) + 'MB'
    },
    queue: queueStats,
    cache: cacheStats,
    configuration: {
      max_concurrent_downloads: CONFIG.MAX_CONCURRENT_DOWNLOADS,
      max_concurrent_info_requests: CONFIG.MAX_CONCURRENT_INFO_REQUESTS,
      max_queue_size: CONFIG.MAX_QUEUE_SIZE,
      rate_limit_max_requests: CONFIG.RATE_LIMIT_MAX_REQUESTS,
      request_timeout: CONFIG.REQUEST_TIMEOUT,
      info_request_timeout: CONFIG.INFO_REQUEST_TIMEOUT
    },
    worker_stats: {
      request_count: workerRequestCount,
      restart_threshold: CONFIG.PROCESS_RESTART_THRESHOLD
    },
    cookies_available: hasCookies,
    endpoints: [
      'GET /',
      'GET /api-docs',
      'GET /info',
      'GET /info/:videoId',
      'GET /download',
      'GET /download/:videoId',
      'GET /api/download-url',
      'GET /api/stats',
      'GET /api/health',
      'GET /api/queue-status'
    ]
  };
  
  res.json(stats);
});

// Route pour vérifier le statut de la file d'attente
app.get("/api/queue-status", (req, res) => {
  const queueStats = queueManager.getStats();
  const memUsage = process.memoryUsage();
  const memPercent = (memUsage.rss / os.totalmem() * 100).toFixed(2);
  
  const status = {
    timestamp: new Date().toISOString(),
    worker_pid: process.pid,
    queue: queueStats,
    server_load: {
      memory_usage_percent: memPercent + '%',
      is_overloaded: parseFloat(memPercent) > (CONFIG.MEMORY_THRESHOLD * 100)
    },
    estimated_wait_times: {
      download: Math.ceil(queueStats.downloadQueue / CONFIG.MAX_CONCURRENT_DOWNLOADS) + ' minutes',
      info: Math.ceil(queueStats.infoQueue / CONFIG.MAX_CONCURRENT_INFO_REQUESTS) + ' secondes'
    }
  };
  
  res.json(status);
});

// Route pour tester la connectivité optimisée
app.get("/api/health", (req, res) => {
  const memUsage = process.memoryUsage();
  const memPercent = memUsage.rss / os.totalmem();
  const queueStats = queueManager.getStats();
  
  let status = "OK";
  let issues = [];
  
  if (memPercent > CONFIG.MEMORY_THRESHOLD) {
    status = "WARNING";
    issues.push("High memory usage");
  }
  
  if (queueStats.downloadQueue > CONFIG.MAX_QUEUE_SIZE * 0.8) {
    status = "WARNING";
    issues.push("Download queue near capacity");
  }
  
  if (queueStats.infoQueue > CONFIG.MAX_QUEUE_SIZE * 0.8) {
    status = "WARNING";
    issues.push("Info queue near capacity");
  }
  
  res.json({
    status: status,
    timestamp: new Date().toISOString(),
    service: "YouTube Downloader Ultra-Puissant",
    version: "3.0",
    worker_pid: process.pid,
    uptime_seconds: Math.floor(process.uptime()),
    memory_usage_mb: Math.round(memUsage.rss / 1024 / 1024),
    memory_percentage: (memPercent * 100).toFixed(2) + '%',
    queue_stats: queueStats,
    issues: issues,
    performance: {
      requests_processed: workerRequestCount,
      cache_hit_rate: videoCache.calculateHitRate().toFixed(2)
    }
  });
});

// Middleware de gestion d'erreurs 404 optimisé
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint non trouvé",
    method: req.method,
    path: req.path,
    timestamp: new Date().toISOString(),
    worker_pid: process.pid,
    available_endpoints: [
      'GET /',
      'GET /api-docs',
      'GET /info?url=...',
      'GET /info/:videoId',
      'GET /download?url=...&format=...&quality=...',
      'GET /download/:videoId?format=...&quality=...',
      'GET /api/download-url?url=...&format=...&quality=...',
      'GET /api/stats',
      'GET /api/health',
      'GET /api/queue-status'
    ],
    tip: "Consultez /api-docs pour la documentation complète"
  });
});

// Gestion des erreurs globales améliorée
app.use((err, req, res, next) => {
  console.error(`🚨 Erreur Express Worker ${process.pid}:`, err.message, err.stack);
  
  if (!res.headersSent) {
    res.status(500).json({ 
      error: 'Erreur serveur interne',
      worker_pid: process.pid,
      timestamp: new Date().toISOString(),
      request_id: req.requestId || 'unknown'
    });
  }
});

// Gestion des erreurs non capturées avec comportement adapté
process.on('uncaughtException', (error) => {
  console.error(`💥 Erreur non capturée ${processManager.useCluster ? 'Worker' : 'Process'} ${process.pid}:`, error);
  
  // En production, éviter les redémarrages agressifs
  if (process.env.NODE_ENV === 'production') {
    console.error('⚠️ Mode production - processus continue malgré l\'erreur');
  } else {
    // Redémarrage gracieux seulement en développement
    setTimeout(() => process.exit(1), 1000);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`💥 Promise rejetée ${processManager.useCluster ? 'Worker' : 'Process'} ${process.pid}:`, reason);
  
  // En production, log seulement sans crash
  if (process.env.NODE_ENV !== 'production') {
    console.error('Stack:', reason?.stack);
  }
});

// Démarrage du serveur avec gestion d'erreurs
const server = app.listen(PORT, '0.0.0.0', (error) => {
  if (error) {
    console.error('❌ Erreur démarrage serveur:', error);
    process.exit(1);
  }
  
  const mode = processManager.useCluster ? 'Worker' : 'Process';
  console.log(`🚀 ${mode} ${process.pid} démarré sur le port ${PORT}`);
  console.log(`📂 Cookies: ${hasCookies ? '✅ Trouvés' : '❌ Absents'}`);
  console.log(`🌐 Interface disponible sur: http://0.0.0.0:${PORT}`);
  console.log(`📖 Documentation API: http://0.0.0.0:${PORT}/api-docs`);
  console.log(`❤️ Health check: http://0.0.0.0:${PORT}/api/health`);
  console.log(`📊 Queue status: http://0.0.0.0:${PORT}/api/queue-status`);
  console.log(`⚙️ Configuration (${process.env.NODE_ENV || 'development'}):
    • Max downloads simultanés: ${CONFIG.MAX_CONCURRENT_DOWNLOADS}
    • Max info requests simultanées: ${CONFIG.MAX_CONCURRENT_INFO_REQUESTS}  
    • Taille max queue: ${CONFIG.MAX_QUEUE_SIZE}
    • Rate limit: ${CONFIG.RATE_LIMIT_MAX_REQUESTS} req/min
    • Timeout téléchargement: ${CONFIG.REQUEST_TIMEOUT / 1000}s
    • Cache activé: ✅
    • Clustering: ${processManager.useCluster ? '✅' : '❌ (Cloud Mode)'}`);
});

// Gestion des erreurs du serveur
server.on('error', (error) => {
  console.error('❌ Erreur serveur:', error);
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} déjà utilisé`);
    process.exit(1);
  }
});

// Gestion propre de l'arrêt avec nettoyage des ressources
process.on('SIGINT', () => {
  console.log(`\n👋 Arrêt ${processManager.useCluster ? 'Worker' : 'Process'} ${process.pid}...`);
  gracefulShutdown();
});

process.on('SIGTERM', () => {
  console.log(`\n👋 Arrêt ${processManager.useCluster ? 'Worker' : 'Process'} ${process.pid} (SIGTERM)...`);
  gracefulShutdown();
});

function gracefulShutdown() {
  console.log('🛑 Arrêt des nouvelles connexions...');
  
  // Fermer le serveur proprement
  server.close((err) => {
    if (err) {
      console.error('❌ Erreur fermeture serveur:', err);
    } else {
      console.log('✅ Serveur fermé proprement');
    }
    
    // Attendre que les requêtes en cours se terminent
    const activeRequests = queueManager.getStats().activeDownloads + queueManager.getStats().activeInfoRequests;
    if (activeRequests > 0) {
      console.log(`⏳ Attente de ${activeRequests} requêtes actives...`);
      setTimeout(() => {
        console.log('⏰ Timeout atteint, arrêt forcé');
        process.exit(0);
      }, 10000); // Max 10 secondes d'attente en cloud
    } else {
      process.exit(0);
    }
  });
}
