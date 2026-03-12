import { NextRequest, NextResponse } from "next/server";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { existsSync, writeFileSync, chmodSync } from "fs";
import { Innertube } from "youtubei.js";
import { connectDB } from "@/lib/mongodb";
import { Song } from "@/lib/models/Song";
import { DownloadQueue } from "@/lib/models/DownloadQueue";
import { uploadAudio } from "@/lib/cloudinary";

const execFileAsync = promisify(execFile);

export const maxDuration = 60;

// ─── yt-dlp helpers ───────────────────────────────────────────────

const YT_DLP_TMP = "/tmp/yt-dlp";
const YT_DLP_BUNDLED = process.cwd() + "/bin/yt-dlp";
let ytDlpDownloadPromise: Promise<string | null> | null = null;

async function findYtDlp(): Promise<string | null> {
  if (process.env.YT_DLP_PATH) {
    try {
      await execFileAsync(process.env.YT_DLP_PATH, ["--version"], { timeout: 5000 });
      return process.env.YT_DLP_PATH;
    } catch { /* skip */ }
  }
  if (existsSync(YT_DLP_BUNDLED)) {
    try {
      chmodSync(YT_DLP_BUNDLED, 0o755);
      await execFileAsync(YT_DLP_BUNDLED, ["--version"], { timeout: 10000 });
      return YT_DLP_BUNDLED;
    } catch { /* skip */ }
  }
  if (existsSync(YT_DLP_TMP)) {
    try {
      await execFileAsync(YT_DLP_TMP, ["--version"], { timeout: 10000 });
      return YT_DLP_TMP;
    } catch { /* skip */ }
  }
  try {
    await execFileAsync("yt-dlp", ["--version"], { timeout: 5000 });
    return "yt-dlp";
  } catch { /* skip */ }
  return null;
}

async function downloadYtDlpBinary(): Promise<string | null> {
  const url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
  try {
    console.log("[yt-dlp] downloading standalone binary...");
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(YT_DLP_TMP, buf);
    chmodSync(YT_DLP_TMP, 0o755);
    await execFileAsync(YT_DLP_TMP, ["--version"], { timeout: 30000 });
    return YT_DLP_TMP;
  } catch {
    return null;
  }
}

async function ensureYtDlp(): Promise<string | null> {
  const existing = await findYtDlp();
  if (existing) return existing;
  if (!ytDlpDownloadPromise) {
    ytDlpDownloadPromise = downloadYtDlpBinary().finally(() => {
      ytDlpDownloadPromise = null;
    });
  }
  return ytDlpDownloadPromise;
}

function downloadWithYtDlp(
  videoId: string,
  ytDlpPath: string
): Promise<{ buffer: Buffer; title: string; ext: string } | null> {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const args = [
      "-f", "bestaudio",
      "-o", "-",
      "--no-cache-dir",
      "--js-runtimes", "node",
    ];

    const titlePromise = execFileAsync(ytDlpPath, [
      "--js-runtimes", "node", "--no-cache-dir", "--get-title", url,
    ], { timeout: 15000 })
      .then((r) => r.stdout.trim())
      .catch(() => videoId);

    const child = spawn(ytDlpPath, [...args, url]);

    const chunks: Buffer[] = [];
    let detectedExt = "m4a";

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (data: Buffer) => {
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
    setTimeout(() => child.kill("SIGTERM"), 50000);
  });
}

// ─── Innertube helpers ────────────────────────────────────────────

const CLIENT_USER_AGENTS: Record<string, string> = {
  IOS: "com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)",
  ANDROID: "com.google.android.youtube/19.29.34 (Linux; U; Android 14) gzip",
  WEB: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

async function downloadWithInnertube(
  videoId: string
): Promise<{ buffer: Buffer; title: string; ext: string } | null> {
  // Try multiple Innertube configurations
  const configs = [
    { retrievePlayer: false, clients: ["IOS", "ANDROID"] as const },
    { retrievePlayer: true, clients: ["WEB"] as const },
  ];

  for (const config of configs) {
    try {
      const yt = await Innertube.create({
        retrieve_player: config.retrievePlayer,
        generate_session_locally: true,
      });

      for (const client of config.clients) {
        try {
          console.log(`[innertube] trying ${client} (player=${config.retrievePlayer})`);
          const info = await yt.getBasicInfo(videoId, { client });
          const audioFormats = (info.streaming_data?.adaptive_formats ?? [])
            .filter((f) => f.mime_type?.startsWith("audio/") && f.url)
            .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

          if (audioFormats.length === 0) {
            console.log(`[innertube] ${client}: no audio formats`);
            continue;
          }

          const fmt = audioFormats[0];
          const title = info.basic_info.title ?? videoId;
          const isM4A = fmt.mime_type?.includes("mp4");
          const ext = isM4A ? "m4a" : "webm";
          const ua = CLIENT_USER_AGENTS[client] || CLIENT_USER_AGENTS.WEB;
          const contentLength = fmt.content_length ?? 0;

          // Try direct fetch
          const directRes = await fetch(fmt.url!, {
            headers: { "User-Agent": ua },
          });
          if (directRes.ok) {
            const buf = Buffer.from(await directRes.arrayBuffer());
            if (buf.length > 100000) {
              return { buffer: buf, title, ext };
            }
          }

          // Try chunked download
          if (contentLength > 0) {
            const chunkSize = 1024 * 1024;
            const chunks: Buffer[] = [];
            let downloaded = 0;

            while (downloaded < contentLength) {
              const end = Math.min(downloaded + chunkSize - 1, contentLength - 1);
              const res = await fetch(fmt.url!, {
                headers: { "User-Agent": ua, Range: `bytes=${downloaded}-${end}` },
              });
              if (!res.ok && res.status !== 206) break;
              const buf = Buffer.from(await res.arrayBuffer());
              chunks.push(buf);
              downloaded += buf.length;
            }

            if (downloaded >= contentLength) {
              return { buffer: Buffer.concat(chunks), title, ext };
            }
          }
        } catch (err) {
          console.log(`[innertube] ${client} failed:`, err instanceof Error ? err.message : err);
          continue;
        }
      }
    } catch (err) {
      console.log(`[innertube] config failed:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}

// ─── Direct YouTube Player API (embedded clients for datacenter IPs) ──

async function downloadWithDirectPlayerAPI(
  videoId: string
): Promise<{ buffer: Buffer; title: string; ext: string } | null> {
  // These embedded/TV clients are less likely to be blocked on datacenter IPs
  const clients = [
    {
      clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
      clientVersion: "2.0",
      apiKey: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      ua: "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 NativeBrowser/2.0 TV Safari/538.1",
      thirdParty: { embedUrl: "https://www.youtube.com" },
    },
    {
      clientName: "ANDROID_MUSIC",
      clientVersion: "7.27.52",
      apiKey: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      ua: "com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 14) gzip",
    },
    {
      clientName: "ANDROID_VR",
      clientVersion: "1.60.19",
      apiKey: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      ua: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
    },
    {
      clientName: "ANDROID_TESTSUITE",
      clientVersion: "1.9",
      apiKey: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      ua: "com.google.android.youtube/19.29.34 (Linux; U; Android 14) gzip",
    },
  ];

  for (const client of clients) {
    try {
      console.log(`[player-api] trying ${client.clientName}`);
      const body: Record<string, unknown> = {
        videoId,
        context: {
          client: {
            clientName: client.clientName,
            clientVersion: client.clientVersion,
            hl: "en",
            gl: "US",
          },
        },
        contentCheckOk: true,
        racyCheckOk: true,
      };

      if ("thirdParty" in client) {
        (body.context as Record<string, unknown>).thirdParty = client.thirdParty;
      }

      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${client.apiKey}&prettyPrint=false`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": client.ua,
            "X-YouTube-Client-Name": "85",
            "X-YouTube-Client-Version": client.clientVersion,
          },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        console.log(`[player-api] ${client.clientName}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const title = data.videoDetails?.title ?? videoId;

      if (data.playabilityStatus?.status !== "OK") {
        console.log(`[player-api] ${client.clientName}: ${data.playabilityStatus?.status} - ${data.playabilityStatus?.reason || "unknown"}`);
        continue;
      }

      const formats = [
        ...(data.streamingData?.adaptiveFormats ?? []),
        ...(data.streamingData?.formats ?? []),
      ];

      const audioFormats = formats
        .filter((f: { mimeType?: string; url?: string }) => f.mimeType?.startsWith("audio/") && f.url)
        .sort((a: { bitrate?: number }, b: { bitrate?: number }) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

      if (audioFormats.length === 0) {
        console.log(`[player-api] ${client.clientName}: no audio formats (${formats.length} total formats)`);
        continue;
      }

      console.log(`[player-api] ${client.clientName}: found ${audioFormats.length} audio formats`);
      const fmt = audioFormats[0];
      const ext = fmt.mimeType?.includes("mp4") ? "m4a" : "webm";

      // Download the audio
      const audioRes = await fetch(fmt.url, {
        headers: { "User-Agent": client.ua },
      });

      if (!audioRes.ok) {
        console.log(`[player-api] ${client.clientName}: audio download HTTP ${audioRes.status}`);
        // Try chunked if content-length known
        const cl = fmt.contentLength ? parseInt(fmt.contentLength) : 0;
        if (cl > 0) {
          const chunkSize = 1024 * 1024;
          const chunks: Buffer[] = [];
          let downloaded = 0;
          while (downloaded < cl) {
            const end = Math.min(downloaded + chunkSize - 1, cl - 1);
            const chunkRes = await fetch(fmt.url, {
              headers: { "User-Agent": client.ua, Range: `bytes=${downloaded}-${end}` },
            });
            if (!chunkRes.ok && chunkRes.status !== 206) break;
            const buf = Buffer.from(await chunkRes.arrayBuffer());
            chunks.push(buf);
            downloaded += buf.length;
          }
          if (downloaded >= cl) {
            return { buffer: Buffer.concat(chunks), title, ext };
          }
        }
        continue;
      }

      const buf = Buffer.from(await audioRes.arrayBuffer());
      if (buf.length > 100000) {
        return { buffer: buf, title, ext };
      }
      console.log(`[player-api] ${client.clientName}: audio too small (${buf.length} bytes)`);
    } catch (err) {
      console.log(`[player-api] ${client.clientName} error:`, err instanceof Error ? err.message : err);
      continue;
    }
  }
  return null;
}

// ─── Cobalt API helper (works from datacenter IPs) ────────────────

const COBALT_INSTANCES = [
  "https://api.cobalt.tools",
];

async function downloadWithCobalt(
  videoId: string
): Promise<{ buffer: Buffer; title: string; ext: string } | null> {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

  for (const instance of COBALT_INSTANCES) {
    try {
      console.log(`[cobalt] trying ${instance} for ${videoId}`);
      const res = await fetch(`${instance}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          url: ytUrl,
          downloadMode: "audio",
          audioFormat: "mp3",
        }),
      });

      if (!res.ok) {
        console.log(`[cobalt] ${instance} returned ${res.status}`);
        continue;
      }

      const data = await res.json();
      console.log(`[cobalt] response status: ${data.status}`);

      if (data.status === "tunnel" || data.status === "redirect") {
        const audioRes = await fetch(data.url);
        if (!audioRes.ok) {
          console.log(`[cobalt] audio fetch failed: ${audioRes.status}`);
          continue;
        }
        const buf = Buffer.from(await audioRes.arrayBuffer());
        if (buf.length < 50000) {
          console.log(`[cobalt] audio too small: ${buf.length} bytes`);
          continue;
        }
        // Try to get title from filename header or use videoId
        const cd = audioRes.headers.get("content-disposition");
        const fnMatch = cd?.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
        const title = fnMatch
          ? decodeURIComponent(fnMatch[1]).replace(/\.\w+$/, "")
          : videoId;
        return { buffer: buf, title, ext: "mp3" };
      }

      if (data.status === "picker" && Array.isArray(data.picker)) {
        // Some responses return a picker with audio option
        const audioOption = data.picker.find(
          (p: { type?: string }) => p.type === "audio"
        );
        if (audioOption?.url) {
          const audioRes = await fetch(audioOption.url);
          if (audioRes.ok) {
            const buf = Buffer.from(await audioRes.arrayBuffer());
            if (buf.length > 50000) {
              return { buffer: buf, title: videoId, ext: "mp3" };
            }
          }
        }
      }
    } catch (err) {
      console.log(`[cobalt] ${instance} error:`, err instanceof Error ? err.message : err);
      continue;
    }
  }
  return null;
}

// ─── Main GET handler ─────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const videoId = request.nextUrl.searchParams.get("videoId");

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return NextResponse.json(
      { error: "Valid 'videoId' parameter is required" },
      { status: 400 }
    );
  }

  try {
    // 1. Check MongoDB cache — if found, redirect to Cloudinary
    await connectDB();
    const cached = await Song.findOne({ videoId }).lean();

    if (cached) {
      console.log(`[download] cache hit for ${videoId}, redirecting to Cloudinary`);
      const title = cached.title.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || videoId;

      // Fetch from Cloudinary and serve with proper headers
      const cloudRes = await fetch(cached.cloudinaryUrl);
      if (cloudRes.ok && cloudRes.body) {
        return new NextResponse(cloudRes.body, {
          status: 200,
          headers: {
            "Content-Type": cached.ext === "webm" ? "audio/webm" : "audio/mp4",
            "Content-Disposition": `attachment; filename="${title}.${cached.ext}"`,
            ...(cached.fileSize ? { "Content-Length": String(cached.fileSize) } : {}),
          },
        });
      }
      // Cloudinary URL expired/broken — delete stale record and re-download
      console.log(`[download] Cloudinary URL broken for ${videoId}, re-downloading`);
      await Song.deleteOne({ videoId });
    }

    // 2. Download audio from YouTube
    let audioData: { buffer: Buffer; title: string; ext: string } | null = null;

    // Try yt-dlp first (handles all videos when not on datacenter IP)
    const ytDlpPath = await findYtDlp();
    if (ytDlpPath) {
      console.log(`[download] trying yt-dlp at ${ytDlpPath}`);
      audioData = await downloadWithYtDlp(videoId, ytDlpPath);
    }

    // Fallback: Innertube IOS client (works for non-throttled videos)
    if (!audioData) {
      console.log(`[download] trying Innertube for ${videoId}`);
      audioData = await downloadWithInnertube(videoId);
    }

    // Fallback: Cobalt API (works from datacenter IPs like Vercel)
    if (!audioData) {
      console.log(`[download] trying Cobalt API for ${videoId}`);
      audioData = await downloadWithCobalt(videoId);
    }

    // Fallback: Direct YouTube Player API with embedded/TV clients
    if (!audioData) {
      console.log(`[download] trying Direct Player API for ${videoId}`);
      audioData = await downloadWithDirectPlayerAPI(videoId);
    }

    // Last resort on Vercel: download yt-dlp binary to /tmp
    if (!audioData && !ytDlpPath) {
      const downloadedPath = await ensureYtDlp();
      if (downloadedPath) {
        console.log(`[download] trying downloaded yt-dlp at ${downloadedPath}`);
        audioData = await downloadWithYtDlp(videoId, downloadedPath);
      }
    }

    if (!audioData) {
      // Auto-queue for background caching
      const songTitle = request.nextUrl.searchParams.get("title") || videoId;
      try {
        const existing = await DownloadQueue.findOne({ videoId }).lean();
        if (!existing) {
          await DownloadQueue.create({
            videoId,
            title: songTitle,
            status: "pending",
            requestedAt: new Date(),
          });
          console.log(`[download] queued ${videoId} for background caching`);
        }
      } catch {
        // Queue insert may fail on duplicate — that's fine
      }

      const queueItem = await DownloadQueue.findOne({ videoId }).lean();
      return NextResponse.json(
        {
          error: "This song is being prepared for download. Please try again in a minute.",
          code: "QUEUED",
          status: queueItem?.status || "pending",
        },
        { status: 202 }
      );
    }

    // 3. Upload to Cloudinary + save to MongoDB before responding
    //    This ensures the cache is populated for future requests (especially on Vercel)
    const title = audioData.title.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || videoId;
    const contentType = audioData.ext === "webm" ? "audio/webm" : "audio/mp4";
    const responseBuffer = new Uint8Array(audioData.buffer);

    try {
      const { url, publicId } = await uploadAudio(
        Buffer.from(audioData.buffer),
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
      console.log(`[cache] saved ${videoId} to Cloudinary+MongoDB (${(audioData.buffer.length / 1024 / 1024).toFixed(1)}MB)`);
    } catch (err) {
      console.error(`[cache] upload failed for ${videoId}, serving without caching:`, err);
    }

    // 4. Return audio
    return new NextResponse(responseBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${title}.${audioData.ext}"`,
        "Content-Length": String(responseBuffer.length),
      },
    });
  } catch (error) {
    console.error("Download error:", error);
    return NextResponse.json(
      { error: "Failed to download song" },
      { status: 500 }
    );
  }
}
