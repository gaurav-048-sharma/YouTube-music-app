/**
 * Cache Worker — Run locally to auto-download queued songs
 *
 * This script monitors the download queue in MongoDB and automatically
 * downloads + caches songs via yt-dlp → Cloudinary → MongoDB.
 *
 * Usage:
 *   node scripts/cache-worker.mjs
 *
 * Keep this running in a terminal while using the website.
 * When you click "Download" on an uncached song, it gets queued here
 * and automatically cached within seconds.
 *
 * Environment: Uses .env.local for MONGODB_URI, CLOUDINARY_*, etc.
 */

import { config } from "dotenv";
import mongoose from "mongoose";
import { v2 as cloudinary } from "cloudinary";
import { execFile, spawn } from "child_process";
import { promisify } from "util";

// Load .env.local
config({ path: ".env.local" });
config({ path: ".env" });

const execFileAsync = promisify(execFile);

const MONGODB_URI = process.env.MONGODB_URI;
const POLL_INTERVAL = 3_000; // 3 seconds

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI not set. Create .env.local with your MongoDB URI.");
  process.exit(1);
}

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  timeout: 120000,
});

// ─── Mongoose Models ──────────────────────────────────────────────

const SongSchema = new mongoose.Schema(
  {
    videoId: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    cloudinaryUrl: { type: String, required: true },
    cloudinaryPublicId: { type: String, required: true },
    ext: { type: String, required: true },
    fileSize: { type: Number, required: true },
  },
  { timestamps: true }
);

const QueueSchema = new mongoose.Schema(
  {
    videoId: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    thumbnail: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      index: true,
    },
    error: { type: String },
    requestedAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

const Song = mongoose.models.Song || mongoose.model("Song", SongSchema);
const DownloadQueue =
  mongoose.models.DownloadQueue ||
  mongoose.model("DownloadQueue", QueueSchema);

// ─── yt-dlp helpers ───────────────────────────────────────────────

async function findYtDlp() {
  for (const cmd of ["yt-dlp", "./bin/yt-dlp"]) {
    try {
      await execFileAsync(cmd, ["--version"], { timeout: 5000 });
      return cmd;
    } catch {
      /* skip */
    }
  }
  return null;
}

function downloadWithYtDlp(videoId, ytDlpPath) {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const args = ["-f", "bestaudio", "-o", "-", "--no-cache-dir"];

    // Add --js-runtimes node on Windows/Linux
    args.push("--js-runtimes", "node");

    const titlePromise = execFileAsync(
      ytDlpPath,
      ["--js-runtimes", "node", "--no-cache-dir", "--get-title", url],
      { timeout: 15000 }
    )
      .then((r) => r.stdout.trim())
      .catch(() => videoId);

    const child = spawn(ytDlpPath, [...args, url]);
    const chunks = [];
    let detectedExt = "m4a";

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (data) => {
      const msg = data.toString();
      const fmtMatch = msg.match(/Downloading 1 format\(s\): (\d+)/);
      if (fmtMatch) {
        const itag = parseInt(fmtMatch[1]);
        detectedExt = [249, 250, 251].includes(itag) ? "webm" : "m4a";
      }
    });

    child.on("close", async (code) => {
      if (code === 0 && chunks.length > 0) {
        const title = await titlePromise;
        resolve({ buffer: Buffer.concat(chunks), title, ext: detectedExt });
      } else {
        resolve(null);
      }
    });

    child.on("error", () => resolve(null));
    setTimeout(() => child.kill("SIGTERM"), 120000);
  });
}

// ─── Cloudinary upload ────────────────────────────────────────────

function uploadAudio(buffer, videoId, ext) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "video",
        folder: "yt-music",
        public_id: videoId,
        format: ext,
        overwrite: true,
      },
      (error, result) => {
        if (error) return reject(error);
        if (!result) return reject(new Error("No result from Cloudinary"));
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

// ─── Main worker loop ─────────────────────────────────────────────

async function processQueue() {
  const ytDlpPath = await findYtDlp();
  if (!ytDlpPath) {
    console.error("❌ yt-dlp not found. Install it: https://github.com/yt-dlp/yt-dlp#installation");
    process.exit(1);
  }
  console.log(`✅ yt-dlp found at: ${ytDlpPath}`);

  // Connect to MongoDB
  await mongoose.connect(MONGODB_URI);
  console.log("✅ Connected to MongoDB");
  console.log(`🔄 Polling for new songs every ${POLL_INTERVAL / 1000}s...\n`);

  while (true) {
    try {
      // Find pending items
      const pending = await DownloadQueue.find({ status: "pending" })
        .sort({ requestedAt: 1 })
        .limit(5)
        .lean();

      if (pending.length > 0) {
        console.log(`📋 Found ${pending.length} pending song(s)`);
      }

      for (const item of pending) {
        const { videoId, title } = item;

        // Check if already cached (another worker might have done it)
        const existing = await Song.findOne({ videoId }).lean();
        if (existing) {
          await DownloadQueue.updateOne(
            { videoId },
            { status: "completed", completedAt: new Date() }
          );
          console.log(`  ⏭️  ${videoId} (${title}) - already cached`);
          continue;
        }

        // Mark as processing
        await DownloadQueue.updateOne({ videoId }, { status: "processing" });
        console.log(`  ⬇️  Downloading: ${title} (${videoId})...`);

        try {
          const audioData = await downloadWithYtDlp(videoId, ytDlpPath);
          if (!audioData) {
            throw new Error("yt-dlp returned no audio");
          }

          const mb = (audioData.buffer.length / 1024 / 1024).toFixed(1);
          console.log(`  ☁️  Uploading to Cloudinary (${mb}MB)...`);

          const { url, publicId } = await uploadAudio(
            audioData.buffer,
            videoId,
            audioData.ext
          );

          await Song.findOneAndUpdate(
            { videoId },
            {
              videoId,
              title: audioData.title,
              cloudinaryUrl: url,
              cloudinaryPublicId: publicId,
              ext: audioData.ext,
              fileSize: audioData.buffer.length,
            },
            { upsert: true, returnDocument: "after" }
          );

          await DownloadQueue.updateOne(
            { videoId },
            { status: "completed", completedAt: new Date() }
          );

          console.log(`  ✅ Cached: ${audioData.title} (${mb}MB)`);
        } catch (err) {
          const errMsg = err.message || "Unknown error";
          await DownloadQueue.updateOne(
            { videoId },
            { status: "failed", error: errMsg }
          );
          console.log(`  ❌ Failed: ${title} - ${errMsg}`);
        }
      }
    } catch (err) {
      console.error("Worker error:", err.message);
    }

    // Wait before next poll
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

// ─── Start ────────────────────────────────────────────────────────

console.log("🎵 Cache Worker starting...\n");
processQueue().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
