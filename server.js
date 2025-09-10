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
      <input type="text" name="url" placeholder="Lien YouTube" style="width:300px"/><br/><br/>
      <select name="format">
        <option value="mp4">Vidéo MP4</option>
        <option value="mp3">Audio MP3</option>
      </select><br/><br/>
      <select name="quality">
        <option value="best">Meilleure qualité</option>
        <option value="1080">1080p</option>
        <option value="720">720p</option>
        <option value="480">480p</option>
        <option value="360">360p</option>
      </select><br/><br/>
      <button type="submit">Télécharger</button>
    </form>
  `);
});

app.get("/download", (req, res) => {
  const url = req.query.url;
  const format = req.query.format || "mp4";
  const quality = req.query.quality || "best";

  if (!url) return res.status(400).send("❌ Paramètre 'url' manquant !");

  const filename = `video_${Date.now()}.${format}`;
  res.header("Content-Disposition", `attachment; filename="${filename}"`);

  console.log(`⚡ Téléchargement : ${url} | Format : ${format} | Qualité : ${quality}`);

  let args = ["-o", "-", url];

  if (hasCookies) args.unshift("--cookies", cookiesPath);

  if (format === "mp3") {
    args.unshift("-x", "--audio-format", "mp3"); // conversion audio
    args.push("--ffmpeg-location", "/usr/bin/ffmpeg"); // indique ffmpeg
  } else if (format === "mp4") {
    args.unshift("--merge-output-format", "mp4"); // merge audio+vidéo
    if (quality !== "best") {
      args.unshift("-f", `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`);
    } else {
      args.unshift("-f", "bestvideo+bestaudio/best");
    }
  }

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
