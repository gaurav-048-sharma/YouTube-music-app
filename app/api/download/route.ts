import { NextRequest, NextResponse } from "next/server";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import path from "path";
import { Innertube } from "youtubei.js";

const execFileAsync = promisify(execFile);

// Allow up to 60s for the download on Vercel (hobby plan max)
export const maxDuration = 60;

function getYtDlpPath(): string {
  // 1. Explicit env var (local dev)
  if (process.env.YT_DLP_PATH) return process.env.YT_DLP_PATH;
  // 2. Bundled binary (Vercel)
  const bundled = path.join(process.cwd(), "bin", "yt-dlp");
  if (existsSync(bundled)) return bundled;
  // 3. System PATH
  return "yt-dlp";
}

/**
 * Download audio via yt-dlp to a buffer.
 * yt-dlp handles N-token transform internally → no throttle.
 * Also returns the title.
 */
function downloadWithYtDlp(
  videoId: string
): Promise<{ buffer: Buffer; title: string; ext: string } | null> {
  return new Promise((resolve) => {
    const ytDlpPath = getYtDlpPath();
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    // Get title and format info in parallel
    const titlePromise = execFileAsync(ytDlpPath, ["--get-title", url], {
      timeout: 15000,
    })
      .then((r) => r.stdout.trim())
      .catch(() => videoId);

    const child = spawn(ytDlpPath, [
      "-f", "bestaudio",
      "-o", "-",
      url,
    ]);

    const chunks: Buffer[] = [];
    let detectedExt = "m4a";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (data: Buffer) => {
      const msg = data.toString();
      // Detect format from yt-dlp's info output
      const fmtMatch = msg.match(/Downloading 1 format\(s\): (\d+)/);
      if (fmtMatch) {
        // itag 251/249/250 = webm/opus, 140/139 = m4a/aac
        const itag = parseInt(fmtMatch[1]);
        detectedExt = [249, 250, 251].includes(itag) ? "webm" : "m4a";
      }
      if (msg.includes("ERROR")) {
        console.error(`[yt-dlp] ${msg.trim()}`);
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

    // Timeout: kill after 60s
    setTimeout(() => {
      child.kill("SIGTERM");
    }, 60000);
  });
}

// User-Agents matching the Innertube client types
const CLIENT_USER_AGENTS: Record<string, string> = {
  IOS: "com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)",
  ANDROID: "com.google.android.youtube/19.29.34 (Linux; U; Android 14) gzip",
  WEB: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

/**
 * Fallback: use youtubei.js to get audio stream URLs.
 * Mobile clients (IOS/ANDROID) provide pre-signed URLs without needing
 * player JS for signature deciphering.
 */
async function resolveWithInnertube(videoId: string): Promise<{
  streamUrl: string;
  title: string;
  contentLength: number;
  mimeType: string;
  clientUsed: string;
} | null> {
  // Mobile clients give pre-signed URLs — no player JS needed
  const mobileClients = ["IOS", "ANDROID"] as const;

  const yt = await Innertube.create({
    retrieve_player: false,
    generate_session_locally: true,
  });

  for (const client of mobileClients) {
    try {
      console.log(`[innertube] trying ${client} client for ${videoId}`);
      const info = await yt.getBasicInfo(videoId, { client });

      const audioFormats = (info.streaming_data?.adaptive_formats ?? [])
        .filter((f) => f.mime_type?.startsWith("audio/") && f.url)
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

      if (audioFormats.length === 0) {
        console.log(`[innertube] ${client}: no audio formats with URLs`);
        continue;
      }

      const fmt = audioFormats[0];
      console.log(`[innertube] ${client}: found itag=${fmt.itag} bitrate=${fmt.bitrate}`);
      return {
        streamUrl: fmt.url!,
        title: info.basic_info.title ?? videoId,
        contentLength: fmt.content_length ?? 0,
        mimeType: fmt.mime_type ?? "audio/mp4",
        clientUsed: client,
      };
    } catch (err) {
      console.error(`[innertube] ${client} failed:`, err);
      continue;
    }
  }

  // Last resort: try WEB client with player retrieval (may fail on decipher)
  try {
    console.log(`[innertube] trying WEB client for ${videoId}`);
    const webYt = await Innertube.create({ generate_session_locally: true });
    const info = await webYt.getBasicInfo(videoId, { client: "WEB" });

    const audioFormats = (info.streaming_data?.adaptive_formats ?? [])
      .filter((f) => f.mime_type?.startsWith("audio/") && f.url)
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

    if (audioFormats.length > 0) {
      const fmt = audioFormats[0];
      console.log(`[innertube] WEB: found itag=${fmt.itag} bitrate=${fmt.bitrate}`);
      return {
        streamUrl: fmt.url!,
        title: info.basic_info.title ?? videoId,
        contentLength: fmt.content_length ?? 0,
        mimeType: fmt.mime_type ?? "audio/mp4",
        clientUsed: "WEB",
      };
    }
  } catch (err) {
    console.error(`[innertube] WEB failed:`, err);
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
    // Strategy 1: Download via yt-dlp (handles N-token, full speed)
    let ytDlpAvailable = false;
    try {
      await execFileAsync(getYtDlpPath(), ["--version"], { timeout: 5000 });
      ytDlpAvailable = true;
    } catch {
      // yt-dlp not installed
    }

    if (ytDlpAvailable) {
      const result = await downloadWithYtDlp(videoId);
      if (result) {
        const title = result.title
          .replace(/[^a-zA-Z0-9 _-]/g, "")
          .trim() || videoId;
        const contentType = result.ext === "webm" ? "audio/webm" : "audio/mp4";

        return new NextResponse(new Uint8Array(result.buffer), {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Content-Disposition": `attachment; filename="${title}.${result.ext}"`,
            "Content-Length": String(result.buffer.length),
          },
        });
      }
    }

    // Strategy 2: Fallback to youtubei.js (multiple clients)
    const innertubeResult = await resolveWithInnertube(videoId);

    if (!innertubeResult) {
      return NextResponse.json(
        { error: "No downloadable audio format found for this video" },
        { status: 404 }
      );
    }

    const title = innertubeResult.title
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .trim() || videoId;

    const mimeType = innertubeResult.mimeType;
    const isM4A = mimeType.includes("mp4");
    const ext = isM4A ? "m4a" : "webm";
    const contentType = isM4A ? "audio/mp4" : "audio/webm";

    // Must send User-Agent matching the client that requested the URL
    const streamHeaders: Record<string, string> = {
      "User-Agent": CLIENT_USER_AGENTS[innertubeResult.clientUsed] || CLIENT_USER_AGENTS.WEB,
    };

    // Try plain fetch first
    const directResponse = await fetch(innertubeResult.streamUrl, {
      headers: streamHeaders,
    });
    if (directResponse.ok && directResponse.body) {
      return new NextResponse(directResponse.body, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${title}.${ext}"`,
          ...(innertubeResult.contentLength
            ? { "Content-Length": String(innertubeResult.contentLength) }
            : {}),
        },
      });
    }

    // If plain fetch failed (403/throttled), download in chunks
    console.log(`[download] direct fetch got ${directResponse.status}, trying chunked download`);
    const totalSize = innertubeResult.contentLength;
    if (totalSize > 0) {
      const chunkSize = 1024 * 1024; // 1MB chunks
      const chunks: Uint8Array[] = [];
      let downloaded = 0;

      while (downloaded < totalSize) {
        const end = Math.min(downloaded + chunkSize - 1, totalSize - 1);
        const chunkRes = await fetch(innertubeResult.streamUrl, {
          headers: { ...streamHeaders, Range: `bytes=${downloaded}-${end}` },
        });
        if (!chunkRes.ok && chunkRes.status !== 206) {
          console.error(`[download] chunk fetch failed: ${chunkRes.status}`);
          break;
        }
        const buf = new Uint8Array(await chunkRes.arrayBuffer());
        chunks.push(buf);
        downloaded += buf.length;
      }

      if (downloaded >= totalSize) {
        const fullBuffer = new Uint8Array(downloaded);
        let offset = 0;
        for (const chunk of chunks) {
          fullBuffer.set(chunk, offset);
          offset += chunk.length;
        }
        return new NextResponse(fullBuffer, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Content-Disposition": `attachment; filename="${title}.${ext}"`,
            "Content-Length": String(downloaded),
          },
        });
      }
    }

    return NextResponse.json(
      { error: "Failed to fetch audio stream" },
      { status: 502 }
    );
  } catch (error) {
    console.error("Download error:", error);
    return NextResponse.json(
      { error: "Failed to download song" },
      { status: 500 }
    );
  }
}
