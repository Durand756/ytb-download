const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

const cookiesPath = path.join(__dirname, "cookies.txt");
const hasCookies = fs.existsSync(cookiesPath);
if (!hasCookies) console.warn("⚠️ Aucun fichier cookies.txt trouvé. Certaines vidéos risquent de ne pas être téléchargeables.");

app.get("/", (req, res) => {
  res.send(`
    <h2>✅ Téléchargeur YouTube</h2>
    <form action="/download" method="get">
      <input type="text" name="url" placeholder="Colle ton lien YouTube" style="width:300px"/>
      <button type="submit">Télécharger</button>
    </form>
  `);
});

app.get("/download", (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("❌ Paramètre 'url' manquant !");

  const filename = `video_${Date.now()}.mp4`;
  res.header("Content-Disposition", `attachment; filename="${filename}"`);

  console.log(`⚡ Début du téléchargement : ${url}`);

  const args = ["-o", "-", "-f", "mp4", url];
  if (hasCookies) args.unshift("--cookies", cookiesPath);

  const ytProcess = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });

  ytProcess.stdout.pipe(res);

  ytProcess.stderr.on("data", data => console.error(data.toString()));
  ytProcess.on("close", () => console.log(`✅ Téléchargement terminé : ${filename}`));
  ytProcess.on("error", err => {
    console.error("❌ Erreur yt-dlp:", err.message);
    res.end("Erreur lors du téléchargement.");
  });
});

app.listen(PORT, () => console.log(`🚀 Serveur lancé sur le port ${PORT}`));
