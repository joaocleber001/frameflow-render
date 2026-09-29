const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 200 * 1024 * 1024 } });
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";

// Teto do canvas quando o container não aguenta compor o tamanho pedido.
// 1080x1920 com PNG de moldura por cima estourava a memória do container e o
// FFmpeg morria com SIGKILL; 720x1280 (mesma proporção 9:16) passa de boa.
const FALLBACK_MAX_W = 720;
const FALLBACK_MAX_H = 1280;

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.header("Access-Control-Expose-Headers", "X-Render-Size");
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

/**
 * Monta e roda UMA passada de FFmpeg.
 * `escala` reduz tamanhos absolutos (borda, fonte) quando o canvas é reduzido
 * no fallback — assim o layout percentual continua igual.
 */
function renderOnce({ videoPath, t, W, H, escala = 1, assets = {}, out }) {
  const bg = t.bg_color || "#0F0F13";

  const vw = even((W * (t.video_width ?? 80)) / 100);
  const vh = even((H * (t.video_height ?? 80)) / 100);
  const vx = Math.round((W * (t.video_x ?? 10)) / 100);
  const vy = Math.round((H * (t.video_y ?? 10)) / 100);

  const inputs = ["-i", videoPath];
  const filters = [];
  let idx = 1;

  filters.push(`color=c=${bg}:s=${W}x${H}:r=30[bg]`);
  filters.push(`[0:v]scale=${vw}:${vh}:force_original_aspect_ratio=decrease,pad=${vw}:${vh}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1[vid]`);
  let last = "base";
  filters.push(`[bg][vid]overlay=${vx}:${vy}:shortest=1[base]`);

  // Borda ao redor do vídeo
  if (t.border_width > 0) {
    const bwid = Math.max(1, Math.round(t.border_width * escala));
    filters.push(`[${last}]drawbox=x=${Math.max(0, vx - bwid)}:y=${Math.max(0, vy - bwid)}:w=${vw + bwid * 2}:h=${vh + bwid * 2}:color=${t.border_color || "#7C3AED"}:t=${bwid}[bord]`);
    last = "bord";
  }

  // Moldura (PNG por cima de tudo)
  if (assets.frame) {
    inputs.push("-loop", "1", "-framerate", "30", "-i", assets.frame);
    filters.push(`[${idx}:v]scale=${W}:${H},format=rgba[fr]`);
    filters.push(`[${last}][fr]overlay=0:0[frm]`);
    last = "frm"; idx++;
  }

  // Logo
  if (assets.logo) {
    const lw = even((W * (t.logo_width ?? 15)) / 100);
    const lh = even((H * (t.logo_height ?? 10)) / 100);
    const lx = Math.round((W * (t.logo_x ?? 80)) / 100);
    const ly = Math.round((H * (t.logo_y ?? 85)) / 100);
    inputs.push("-loop", "1", "-framerate", "30", "-i", assets.logo);
    filters.push(`[${idx}:v]scale=${lw}:${lh}:force_original_aspect_ratio=decrease[lg]`);
    filters.push(`[${last}][lg]overlay=${lx}:${ly}[lgo]`);
    last = "lgo"; idx++;
  }

  // Textos
  const color = t.text_color || "#FFFFFF";
  if (t.title_text) {
    const fs1 = Math.max(8, Math.round((t.title_font_size || 24) * escala));
    filters.push(`[${last}]drawtext=fontfile=${FONT}:text='${esc(t.title_text)}':fontcolor=${color}:fontsize=${fs1}:x=${Math.round(W * (t.title_x ?? 5) / 100)}:y=${Math.round(H * (t.title_y ?? 85) / 100)}[ttl]`);
    last = "ttl";
  }
  if (t.subtitle_text) {
    const fs2 = Math.max(8, Math.round((t.subtitle_font_size || 16) * escala));
    filters.push(`[${last}]drawtext=fontfile=${FONT}:text='${esc(t.subtitle_text)}':fontcolor=${color}:fontsize=${fs2}:x=${Math.round(W * (t.subtitle_x ?? 5) / 100)}:y=${Math.round(H * (t.subtitle_y ?? 92) / 100)}[sub]`);
    last = "sub";
  }

  const args = [
    "-y", "-hide_banner", "-nostdin", ...inputs,
    "-filter_complex", filters.join(";"),
    "-filter_complex_threads", "1",
    "-map", `[${last}]`, "-map", "0:a?",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
    "-threads", "1", "-x264-params", "threads=1:sliced-threads=0",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-max_muxing_queue_size", "1024",
    "-c:a", "aac", "-b:a", "128k", "-shortest",
    out,
  ];

  console.log(`FFMPEG ${W}x${H} (escala ${escala}):`, args.join(" "));

  return new Promise((resolve) => {
    const ff = spawn(FFMPEG, args);
    let log = "";
    ff.stderr.on("data", (d) => { log += d.toString(); if (log.length > 20000) log = log.slice(-20000); });
    ff.on("close", (code, signal) => {
      const ok = code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0;
      resolve({ ok, code, signal, log });
    });
  });
}

app.post("/processar-video", upload.single("video"), async (req, res) => {
  const tmp = [];
  const cleanup = () => tmp.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });

  try {
    if (!req.file) return res.status(400).json({ error: "Vídeo não enviado" });
    tmp.push(req.file.path);

    const t = JSON.parse(req.body.template || "{}");
    const W = even(t.canvas_width || 1920);
    const H = even(t.canvas_height || 1080);

    // Assets baixados UMA vez (reaproveitados no fallback).
    const assets = {};
    if (t.frame_image_url) {
      const f = path.join(os.tmpdir(), `frame_${Date.now()}.png`);
      await download(t.frame_image_url, f);
      tmp.push(f); assets.frame = f;
    }
    if (t.logo_url) {
      const l = path.join(os.tmpdir(), `logo_${Date.now()}.png`);
      await download(t.logo_url, l);
      tmp.push(l); assets.logo = l;
    }

    // Passada 1: tamanho pedido.
    const out1 = path.join(os.tmpdir(), `out_${Date.now()}.mp4`);
    tmp.push(out1);
    let r = await renderOnce({ videoPath: req.file.path, t, W, H, escala: 1, assets, out: out1 });

    if (r.ok) {
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("X-Render-Size", `${W}x${H}`);
      const s1 = fs.createReadStream(out1);
      s1.pipe(res);
      s1.on("close", cleanup);
      return;
    }

    console.error("FFMPEG FALHOU (1a passada)", W + "x" + H, "code=", r.code, "signal=", r.signal);
    console.error(r.log);

    // Passada 2 (fallback): reduz o canvas para caber em 720x1280 (mesma proporção).
    // Sem isso, um vídeo com moldura PNG em 1080x1920 morria com SIGKILL (memória)
    // e o post nunca entrava na fila.
    const escala = Math.min(1, FALLBACK_MAX_W / W, FALLBACK_MAX_H / H);
    const W2 = even(W * escala);
    const H2 = even(H * escala);
    const out2 = path.join(os.tmpdir(), `out_fb_${Date.now()}.mp4`);
    tmp.push(out2);
    const r2 = await renderOnce({ videoPath: req.file.path, t, W: W2, H: H2, escala, assets, out: out2 });

    if (r2.ok) {
      console.warn(`FFMPEG ok no fallback ${W2}x${H2} (pedido era ${W}x${H})`);
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("X-Render-Size", `${W2}x${H2}`);
      const s2 = fs.createReadStream(out2);
      s2.pipe(res);
      s2.on("close", cleanup);
      return;
    }

    console.error("FFMPEG FALHOU (fallback)", W2 + "x" + H2, "code=", r2.code, "signal=", r2.signal);
    console.error(r2.log);
    cleanup();
    return res.status(500).json({
      error: "FFmpeg falhou",
      code: r2.code,
      signal: r2.signal,
      tentativas: [
        { size: `${W}x${H}`, code: r.code, signal: r.signal },
        { size: `${W2}x${H2}`, code: r2.code, signal: r2.signal },
      ],
      log: r2.log.slice(-4000),
    });
  } catch (err) {
    console.error(err);
    cleanup();
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Render worker rodando"));
