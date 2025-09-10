const express = require("express");
const ytdl = require("ytdl-core");
const { exec } = require("child_process");
const ytdlp = require("yt-dlp-exec");
const youtubeDl = require("youtube-dl-exec");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("✅ YouTube Downloader API en ligne !");
});

// 1️⃣ Méthode avec ytdl-core
app.get("/download1", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Manque ?url");

  try {
    res.header("Content-Disposition", 'attachment; filename="video.mp4"');
    ytdl(url, { quality: "highestvideo" }).pipe(res);
  } catch (err) {
    res.status(500).send("Erreur YTDL-Core: " + err.message);
  }
});

// 2️⃣ Méthode avec yt-dlp-exec
app.get("/download2", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Manque ?url");

  try {
    const stream = ytdlp(url, { output: "-" }, { stdio: ["ignore", "pipe", "ignore"] });
    res.header("Content-Disposition", 'attachment; filename="video.mp4"');
    stream.stdout.pipe(res);
  } catch (err) {
    res.status(500).send("Erreur yt-dlp-exec: " + err.message);
  }
});

// 3️⃣ Méthode avec youtube-dl-exec
app.get("/download3", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Manque ?url");

  try {
    const stream = youtubeDl(url, { output: "-" }, { stdio: ["ignore", "pipe", "ignore"] });
    res.header("Content-Disposition", 'attachment; filename="video.mp4"');
    stream.stdout.pipe(res);
  } catch (err) {
    res.status(500).send("Erreur youtube-dl-exec: " + err.message);
  }
});

app.listen(PORT, () => console.log(`🚀 Serveur lancé sur http://localhost:${PORT}`));
