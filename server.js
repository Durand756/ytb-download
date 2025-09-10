const express = require("express");
const fs = require("fs");
const path = require("path");
const ytdlp = require("yt-dlp-exec");

const app = express();
const PORT = process.env.PORT || 3000;

// Vérification du fichier cookies
const cookiesPath = path.join(__dirname, "cookies.txt");
const hasCookies = fs.existsSync(cookiesPath);
if (!hasCookies) {
  console.warn("⚠️ Aucun fichier cookies.txt trouvé. Certaines vidéos risquent de ne pas être téléchargeables (erreur 403 ou demande de connexion).");
}

// Page d'accueil
app.get("/", (req, res) => {
  res.send(`
    <h2>✅ Téléchargeur YouTube</h2>
    <form action="/download" method="get">
      <input type="text" name="url" placeholder="Colle ton lien YouTube" style="width:300px"/>
      <button type="submit">Télécharger</button>
    </form>
  `);
});

// Route téléchargement
app.get("/download", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("❌ Paramètre 'url' manquant !");

  const filename = `video_${Date.now()}.mp4`;
  res.header("Content-Disposition", `attachment; filename="${filename}"`);

  console.log(`⚡ Début du téléchargement : ${url}`);

  try {
    const options = {
      output: "-",      // Stream direct vers le client
      format: "mp4",
      quiet: true
    };
    if (hasCookies) options.cookies = cookiesPath;

    const stream = ytdlp(url, options, { stdio: ["ignore", "pipe", "pipe"] });

    stream.stdout.pipe(res);

    stream.stderr.on("data", data => console.error(data.toString()));
    stream.on("close", () => console.log(`✅ Téléchargement terminé : ${filename}`));
    stream.on("error", err => {
      console.error("❌ Erreur yt-dlp:", err.message);
      res.end("Erreur lors du téléchargement.");
    });

  } catch (err) {
    console.error("❌ Exception:", err.message);
    res.status(500).send("Erreur serveur lors du téléchargement.");
  }
});

app.listen(PORT, () => console.log(`🚀 Serveur lancé sur le port ${PORT}`));
