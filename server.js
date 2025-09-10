const express = require("express");
const ytdl = require("ytdl-core");
const { spawn } = require("child_process");

const app = express();

app.get("/", (req, res) => {
  res.send(`
    <h2>Téléchargeur YouTube 🚀</h2>
    <form action="/download" method="get">
      <input type="text" name="url" placeholder="Colle ton lien YouTube" style="width:300px"/>
      <button type="submit">Télécharger</button>
    </form>
  `);
});

app.get("/download", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.send("❌ Lien manquant !");

  const filename = `video_${Date.now()}.mp4`;
  res.header("Content-Disposition", `attachment; filename="${filename}"`);

  try {
    console.log("⚡ Tentative avec ytdl-core...");
    return ytdl(url, { format: "mp4" })
      .on("error", (err) => {
        console.error("❌ ytdl-core a échoué:", err.message);
        essayerYtdlpCli(url, res, filename);
      })
      .pipe(res);
  } catch (err) {
    console.error("Erreur ytdl-core:", err.message);
    return essayerYtdlpCli(url, res, filename);
  }
});

// Méthode 2 : yt-dlp (CLI)
function essayerYtdlpCli(url, res, filename) {
  console.log("⚡ Tentative avec yt-dlp (CLI)...");
  const process = spawn("yt-dlp", ["-o", "-", "-f", "mp4", url]);

  process.stdout.pipe(res);
  process.stderr.on("data", (data) => console.error(data.toString()));
  process.on("error", (err) => {
    console.error("❌ yt-dlp (CLI) a échoué:", err.message);
    res.end("Impossible de télécharger la vidéo 😢");
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Serveur lancé sur le port ${PORT}`));
