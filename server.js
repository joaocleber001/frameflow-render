const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 200 * 1024 * 1024 } });
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/", (_req, res) => res.send("FrameFlow render worker online"));

const even = (n) => { const v = Math.round(n); return v % 2 === 0 ? v : v + 1; };
const esc = (t) => String(t).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019");

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Falha ao baixar asset: " + url);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

app.post("/processar-video", upload.single("video"), async (req, res) => {
  const tmp = [];
  const cleanup = () => tmp.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });

  try {
    if (!req.file) return res.status(400).json({ error: "Vídeo não enviado" });
    tmp.push(req.file.path);

    const t = JSON.parse(req.body.template || "{}");
    const W = even(t.canvas_width || 1920);
    const H = even(t.canvas_height || 1080);
    const bg = t.bg_color || "#0F0F13";

    const vw = even((W * (t.video_width ?? 80)) / 100);
    const vh = even((H * (t.video_height ?? 80)) / 100);
    const vx = Math.round((W * (t.video_x ?? 10)) / 100);
    const vy = Math.round((H * (t.video_y ?? 10)) / 100);

    const inputs = ["-i", req.file.path];
    const filters = [];
    let idx = 1;

    filters.push(`color=c=${bg}:s=${W}x${H}:r=30[bg]`);
    filters.push(`[0:v]scale=${vw}:${vh}:force_original_aspect_ratio=decrease,pad=${vw}:${vh}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1[vid]`);
    let last = "base";
    filters.push(`[bg][vid]overlay=${vx}:${vy}:shortest=1[base]`);

    // Borda ao redor do vídeo
    if (t.border_width > 0) {
      const bwid = Math.round(t.border_width);
      filters.push(`[${last}]drawbox=x=${Math.max(0, vx - bwid)}:y=${Math.max(0, vy - bwid)}:w=${vw + bwid * 2}:h=${vh + bwid * 2}:color=${t.border_color || "#7C3AED"}:t=${bwid}[bord]`);
      last = "bord";
    }

    // Moldura (PNG por cima de tudo)
    if (t.frame_image_url) {
      const f = path.join(os.tmpdir(), `frame_${Date.now()}.png`);
      await download(t.frame_image_url, f);
      tmp.push(f);
      inputs.push("-i", f);
      filters.push(`[${idx}:v]scale=${W}:${H}[fr]`);
      filters.push(`[${last}][fr]overlay=0:0[frm]`);
      last = "frm"; idx++;
    }

    // Logo
    if (t.logo_url) {
      const lw = even((W * (t.logo_width ?? 15)) / 100);
      const lh = even((H * (t.logo_height ?? 10)) / 100);
      const lx = Math.round((W * (t.logo_x ?? 80)) / 100);
      const ly = Math.round((H * (t.logo_y ?? 85)) / 100);
      const l = path.join(os.tmpdir(), `logo_${Date.now()}.png`);
      await download(t.logo_url, l);
      tmp.push(l);
      inputs.push("-i", l);
      filters.push(`[${idx}:v]scale=${lw}:${lh}:force_original_aspect_ratio=decrease[lg]`);
      filters.push(`[${last}][lg]overlay=${lx}:${ly}[lgo]`);
      last = "lgo"; idx++;
    }

    // Textos
    const color = t.text_color || "#FFFFFF";
    if (t.title_text) {
      filters.push(`[${last}]drawtext=fontfile=${FONT}:text='${esc(t.title_text)}':fontcolor=${color}:fontsize=${t.title_font_size || 24}:x=${Math.round(W * (t.title_x ?? 5) / 100)}:y=${Math.round(H * (t.title_y ?? 85) / 100)}[ttl]`);
      last = "ttl";
    }
    if (t.subtitle_text) {
      filters.push(`[${last}]drawtext=fontfile=${FONT}:text='${esc(t.subtitle_text)}':fontcolor=${color}:fontsize=${t.subtitle_font_size || 16}:x=${Math.round(W * (t.subtitle_x ?? 5) / 100)}:y=${Math.round(H * (t.subtitle_y ?? 92) / 100)}[sub]`);
      last = "sub";
    }

    const out = path.join(os.tmpdir(), `out_${Date.now()}.mp4`);
    tmp.push(out);

    const args = [
      "-y", ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", `[${last}]`, "-map", "0:a?",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
      "-threads", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-c:a", "aac", "-b:a", "128k", "-shortest",
      out,
    ];

    console.log("FFMPEG ARGS:", args.join(" "));

    const ff = spawn("ffmpeg", args);
    let log = "";
    ff.stderr.on("data", d => { log += d.toString(); if (log.length > 20000) log = log.slice(-20000); });

    ff.on("close", (code, signal) => {
      if (code !== 0 || !fs.existsSync(out)) {
        console.error("FFMPEG FALHOU code=", code, "signal=", signal);
        console.error(log);
        cleanup();
        return res.status(500).json({
          error: "FFmpeg falhou",
          code,
          signal,
          log: log.slice(-4000),
        });
      }
      res.setHeader("Content-Type", "video/mp4");
      const stream = fs.createReadStream(out);
      stream.pipe(res);
      stream.on("close", cleanup);
    });
  } catch (err) {
    console.error(err);
    cleanup();
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Render worker rodando"));
