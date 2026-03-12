import { NextRequest, NextResponse } from "next/server";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { existsSync, writeFileSync, chmodSync } from "fs";
import { Innertube } from "youtubei.js";

const execFileAsync = promisify(execFile);

export const maxDuration = 60;

const YT_DLP_TMP = "/tmp/yt-dlp";
const YT_DLP_BUNDLED = process.cwd() + "/bin/yt-dlp";
const YT_DLP_URLS = [
  // Python zipapp (~3.5MB, needs python3 on system)
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp",
  // Standalone Linux binary (~22MB, no dependencies)
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux",
];

// Singleton promise to prevent concurrent downloads
let ytDlpResolvePromise: Promise<string | null> | null = null;

/** Find an already-available yt-dlp (no download). */
async function findYtDlp(): Promise<string | null> {
  // 1. Explicit env var (local dev)
  if (process.env.YT_DLP_PATH) {
    try {
      await execFileAsync(process.env.YT_DLP_PATH, ["--version"], { timeout: 5000 });
      return process.env.YT_DLP_PATH;
    } catch { /* not available */ }
  }
  // 2. Bundled binary (Vercel build-time install)
  if (existsSync(YT_DLP_BUNDLED)) {
    try {
      chmodSync(YT_DLP_BUNDLED, 0o755);
      await execFileAsync(YT_DLP_BUNDLED, ["--version"], { timeout: 10000 });
      return YT_DLP_BUNDLED;
    } catch (e) {
      console.error(`[yt-dlp] bundled binary failed:`, e);
    }
  }
  // 3. Previously downloaded to /tmp
  if (existsSync(YT_DLP_TMP)) {
    try {
      await execFileAsync(YT_DLP_TMP, ["--version"], { timeout: 10000 });
      return YT_DLP_TMP;
    } catch { /* corrupt or wrong platform */ }
  }
  // 4. System PATH
  try {
    await execFileAsync("yt-dlp", ["--version"], { timeout: 5000 });
    return "yt-dlp";
  } catch { /* not on PATH */ }
  return null;
}

/** Download yt-dlp binary to /tmp for Vercel serverless. */
async function downloadYtDlp(): Promise<string | null> {
  for (const url of YT_DLP_URLS) {
    try {
      console.log(`[yt-dlp] downloading from ${url}...`);
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) {
        console.error(`[yt-dlp] HTTP ${res.status} from ${url}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(YT_DLP_TMP, buf);
      chmodSync(YT_DLP_TMP, 0o755);
      console.log(`[yt-dlp] wrote ${(buf.length / 1024 / 1024).toFixed(1)}MB to ${YT_DLP_TMP}`);

      const { stdout } = await execFileAsync(YT_DLP_TMP, ["--version"], { timeout: 30000 });
      console.log(`[yt-dlp] version: ${stdout.trim()}`);
      return YT_DLP_TMP;
    } catch (err) {
      console.error(`[yt-dlp] failed with ${url}:`, err);
    }
  }
  return null;
}

/** Ensure yt-dlp is available, downloading if necessary. Singleton. */
async function ensureYtDlp(): Promise<string | null> {
  const existing = await findYtDlp();
  if (existing) return existing;

  // Deduplicate concurrent download attempts
  if (!ytDlpResolvePromise) {
    ytDlpResolvePromise = downloadYtDlp().finally(() => {
      ytDlpResolvePromise = null;
    });
  }
  return ytDlpResolvePromise;
}

/**
 * Download audio via yt-dlp to a buffer.
 * yt-dlp handles signature decipher + N-token → no throttle.
 */
function downloadWithYtDlp(
  videoId: string,
  ytDlpPath: string
): Promise<{ buffer: Buffer; title: string; ext: string } | null> {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    const titlePromise = execFileAsync(ytDlpPath, ["--get-title", url], {
      timeout: 15000,
    })
      .then((r) => r.stdout.trim())
      .catch(() => videoId);

    const child = spawn(ytDlpPath, ["-f", "bestaudio", "-o", "-", url]);

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
      if (msg.includes("ERROR")) console.error(`[yt-dlp] ${msg.trim()}`);
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

const CLIENT_USER_AGENTS: Record<string, string> = {
  IOS: "com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)",
  ANDROID: "com.google.android.youtube/19.29.34 (Linux; U; Android 14) gzip",
  WEB: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

/**
 * Try youtubei.js IOS client to get a pre-signed audio URL.
 * Works for non-throttled videos without needing player JS.
 */
async function resolveWithInnertube(videoId: string): Promise<{
  streamUrl: string;
  title: string;
  contentLength: number;
  mimeType: string;
  clientUsed: string;
} | null> {
  const yt = await Innertube.create({
    retrieve_player: false,
    generate_session_locally: true,
  });

  for (const client of ["IOS", "ANDROID"] as const) {
    try {
      console.log(`[innertube] trying ${client} for ${videoId}`);
      const info = await yt.getBasicInfo(videoId, { client });

      const audioFormats = (info.streaming_data?.adaptive_formats ?? [])
        .filter((f) => f.mime_type?.startsWith("audio/") && f.url)
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

      if (audioFormats.length === 0) continue;

      const fmt = audioFormats[0];
      console.log(`[innertube] ${client}: itag=${fmt.itag} bitrate=${fmt.bitrate}`);
      return {
        streamUrl: fmt.url!,
        title: info.basic_info.title ?? videoId,
        contentLength: fmt.content_length ?? 0,
        mimeType: fmt.mime_type ?? "audio/mp4",
        clientUsed: client,
      };
    } catch (err) {
      console.error(`[innertube] ${client} failed:`, err);
    }
  }
  return null;
}

/** Try to stream audio from an Innertube URL. Returns Response or null. */
async function tryStreamDownload(info: {
  streamUrl: string;
  title: string;
  contentLength: number;
  mimeType: string;
  clientUsed: string;
}): Promise<NextResponse | null> {
  const title = info.title.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || "audio";
  const isM4A = info.mimeType.includes("mp4");
  const ext = isM4A ? "m4a" : "webm";
  const contentType = isM4A ? "audio/mp4" : "audio/webm";
  const ua = CLIENT_USER_AGENTS[info.clientUsed] || CLIENT_USER_AGENTS.WEB;

  // Try direct fetch
  const directRes = await fetch(info.streamUrl, {
    headers: { "User-Agent": ua },
  });
  if (directRes.ok && directRes.body) {
    return new NextResponse(directRes.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${title}.${ext}"`,
        ...(info.contentLength ? { "Content-Length": String(info.contentLength) } : {}),
      },
    });
  }

  // Try chunked download (handles 403 on direct but 206 on Range)
  console.log(`[download] direct fetch ${directRes.status}, trying chunked`);
  if (info.contentLength > 0) {
    const chunkSize = 1024 * 1024;
    const chunks: Uint8Array[] = [];
    let downloaded = 0;

    while (downloaded < info.contentLength) {
      const end = Math.min(downloaded + chunkSize - 1, info.contentLength - 1);
      const res = await fetch(info.streamUrl, {
        headers: { "User-Agent": ua, Range: `bytes=${downloaded}-${end}` },
      });
      if (!res.ok && res.status !== 206) {
        console.error(`[download] chunk at ${downloaded} failed: ${res.status}`);
        break;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      chunks.push(buf);
      downloaded += buf.length;
    }

    if (downloaded >= info.contentLength) {
      const full = new Uint8Array(downloaded);
      let off = 0;
      for (const c of chunks) { full.set(c, off); off += c.length; }
      return new NextResponse(full, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${title}.${ext}"`,
          "Content-Length": String(downloaded),
        },
      });
    }
  }

  return null;
}

export async function GET(request: NextRequest) {
  const videoId = request.nextUrl.searchParams.get("videoId");

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return NextResponse.json(
      { error: "Valid 'videoId' parameter is required" },
      { status: 400 }
    );
  }

  try {
    // Check if yt-dlp is already available (local dev or warm Vercel function)
    const quickYtDlp = await findYtDlp();

    if (quickYtDlp) {
      // yt-dlp available immediately — use it (handles all videos)
      console.log(`[download] using yt-dlp at ${quickYtDlp}`);
      const result = await downloadWithYtDlp(videoId, quickYtDlp);
      if (result) {
        const title = result.title.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || videoId;
        return new NextResponse(new Uint8Array(result.buffer), {
          status: 200,
          headers: {
            "Content-Type": result.ext === "webm" ? "audio/webm" : "audio/mp4",
            "Content-Disposition": `attachment; filename="${title}.${result.ext}"`,
            "Content-Length": String(result.buffer.length),
          },
        });
      }
    }

    // Try IOS client (fast for non-throttled videos)
    const innertubeResult = await resolveWithInnertube(videoId);
    if (innertubeResult) {
      const streamResponse = await tryStreamDownload(innertubeResult);
      if (streamResponse) return streamResponse;
      console.log("[download] IOS stream throttled/failed, falling back to yt-dlp");
    }

    // Last resort: download yt-dlp to /tmp and use it
    const ytDlpPath = await ensureYtDlp();
    if (ytDlpPath) {
      console.log(`[download] using yt-dlp at ${ytDlpPath} (downloaded)`);
      const result = await downloadWithYtDlp(videoId, ytDlpPath);
      if (result) {
        const title = result.title.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || videoId;
        return new NextResponse(new Uint8Array(result.buffer), {
          status: 200,
          headers: {
            "Content-Type": result.ext === "webm" ? "audio/webm" : "audio/mp4",
            "Content-Disposition": `attachment; filename="${title}.${result.ext}"`,
            "Content-Length": String(result.buffer.length),
          },
        });
      }
    }

    return NextResponse.json(
      { error: "No downloadable audio format found for this video" },
      { status: 404 }
    );
  } catch (error) {
    console.error("Download error:", error);
    return NextResponse.json(
      { error: "Failed to download song" },
      { status: 500 }
    );
  }
}
