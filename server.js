const express = require('express');
const cors = require('cors');
const ytDlpExec = require('yt-dlp-exec');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Vérification de la présence du fichier cookies.txt au démarrage
const cookiesPath = path.join(__dirname, 'cookies.txt');
const hasCookies = fs.existsSync(cookiesPath);

if (!hasCookies) {
    console.log('⚠️  ATTENTION: Aucun fichier cookies.txt trouvé.');
    console.log('   Certaines vidéos risquent de ne pas être téléchargeables (erreur 403 ou demande de connexion).');
    console.log('   Consultez le README pour savoir comment exporter vos cookies YouTube.');
} else {
    console.log('✅ Fichier cookies.txt détecté - Authentification disponible');
}

// Route principale
app.get('/', (req, res) => {
    res.json({
        message: 'YouTube Downloader API',
        usage: 'GET /download?url=<youtube_url>',
        status: 'online',
        cookies: hasCookies ? 'présents' : 'absents'
    });
});

// Route de téléchargement
app.get('/download', async (req, res) => {
    const { url } = req.query;

    // Validation de l'URL
    if (!url) {
        return res.status(400).json({
            error: 'URL manquante',
            message: 'Veuillez fournir une URL YouTube via le paramètre ?url='
        });
    }

    // Vérification basique du format YouTube
    const youtubeRegex = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)/;
    if (!youtubeRegex.test(url)) {
        return res.status(400).json({
            error: 'URL invalide',
            message: 'L\'URL fournie ne semble pas être une URL YouTube valide'
        });
    }

    console.log(`📥 Début du téléchargement: ${url}`);

    try {
        // Configuration yt-dlp
        const options = {
            format: 'best[height<=720][ext=mp4]/best[ext=mp4]/best',
            output: '-', // Stream vers stdout
            noWarnings: false,
            extractFlat: false,
            writeInfoJson: false,
            writeThumbnail: false
        };

        // Ajouter les cookies si disponibles
        if (hasCookies) {
            options.cookies = cookiesPath;
            console.log('🍪 Utilisation des cookies pour l\'authentification');
        }

        // Obtenir les métadonnées de la vidéo d'abord
        console.log('📋 Récupération des métadonnées...');
        const metadata = await ytDlpExec(url, {
            dumpSingleJson: true,
            noWarnings: true,
            cookies: hasCookies ? cookiesPath : undefined
        });

        const videoTitle = metadata.title || 'video';
        const sanitizedTitle = videoTitle.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').substring(0, 50);
        const filename = `${sanitizedTitle}.mp4`;

        console.log(`📹 Titre: ${videoTitle}`);
        console.log(`📤 Streaming vers le client...`);

        // Headers pour le téléchargement
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

        // Stream la vidéo
        const ytDlpStream = ytDlpExec.raw(url, options);

        // Gestion des erreurs du stream
        ytDlpStream.on('error', (error) => {
            console.error('❌ Erreur lors du streaming yt-dlp:', error.message);
            if (!res.headersSent) {
                res.status(500).json({
                    error: 'Erreur de téléchargement',
                    message: error.message,
                    suggestion: !hasCookies ? 'Essayez d\'ajouter un fichier cookies.txt' : 'Vérifiez que l\'URL est accessible'
                });
            }
        });

        // Pipe le stream vers la réponse
        ytDlpStream.stdout.pipe(res);

        // Gestion de la fin du stream
        ytDlpStream.stdout.on('end', () => {
            console.log('✅ Téléchargement terminé avec succès');
        });

        // Gestion de la fermeture de connexion côté client
        req.on('close', () => {
            console.log('🔌 Client déconnecté - Arrêt du téléchargement');
            if (ytDlpStream && ytDlpStream.kill) {
                ytDlpStream.kill('SIGTERM');
            }
        });

    } catch (error) {
        console.error('❌ Erreur lors du téléchargement:', error.message);
        
        if (!res.headersSent) {
            // Analyse de l'erreur pour donner des conseils spécifiques
            let suggestion = 'Vérifiez que l\'URL est correcte et accessible';
            
            if (error.message.includes('403') || error.message.includes('Forbidden')) {
                suggestion = 'Erreur 403: Ajoutez un fichier cookies.txt ou vérifiez que la vidéo est publique';
            } else if (error.message.includes('404') || error.message.includes('Not Found')) {
                suggestion = 'Vidéo non trouvée: L\'URL semble incorrecte ou la vidéo a été supprimée';
            } else if (error.message.includes('private') || error.message.includes('unavailable')) {
                suggestion = 'Vidéo privée ou indisponible: Vérifiez les permissions d\'accès';
            }

            res.status(500).json({
                error: 'Erreur de téléchargement',
                message: error.message,
                suggestion: suggestion,
                cookiesStatus: hasCookies ? 'présents' : 'absents - ajoutez cookies.txt pour plus de compatibilité'
            });
        }
    }
});

// Route de santé pour Railway
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        cookies: hasCookies
    });
});

// Gestion des erreurs globales
app.use((err, req, res, next) => {
    console.error('💥 Erreur serveur non gérée:', err);
    res.status(500).json({
        error: 'Erreur interne du serveur',
        message: 'Une erreur inattendue s\'est produite'
    });
});

// Démarrage du serveur
app.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    console.log(`🌐 URL locale: http://localhost:${PORT}`);
    console.log(`📋 API Health: http://localhost:${PORT}/health`);
    console.log(`⬇️  Exemple: http://localhost:${PORT}/download?url=https://youtube.com/watch?v=VIDEO_ID`);
});
