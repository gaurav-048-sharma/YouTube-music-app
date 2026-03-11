import { NextRequest, NextResponse } from "next/server";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { Innertube } from "youtubei.js";

const execFileAsync = promisify(execFile);

function getYtDlpPath(): string {
  return process.env.YT_DLP_PATH || "yt-dlp";
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

/**
 * Fallback: use youtubei.js IOS client for pre-signed URLs.
 * Works on Vercel but subject to YouTube's ~1MB throttle for some videos.
 */
async function resolveWithInnertube(videoId: string): Promise<{
  streamUrl: string;
  title: string;
  contentLength: number;
  mimeType: string;
} | null> {
  const yt = await Innertube.create({
    retrieve_player: false,
    generate_session_locally: true,
  });

  const info = await yt.getBasicInfo(videoId, { client: "IOS" });

  const audioFormats = (info.streaming_data?.adaptive_formats ?? [])
    .filter((f) => f.mime_type?.startsWith("audio/") && f.url)
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

  if (audioFormats.length === 0) return null;

  const fmt = audioFormats[0];
  return {
    streamUrl: fmt.url!,
    title: info.basic_info.title ?? videoId,
    contentLength: fmt.content_length ?? 0,
    mimeType: fmt.mime_type ?? "audio/mp4",
  };
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

    // Strategy 2: Fallback to youtubei.js IOS client
    console.log(`[innertube] trying IOS fallback for ${videoId}`);
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

    // Try plain fetch first
    const directResponse = await fetch(innertubeResult.streamUrl);
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

    // If plain fetch got 403, try with Range header
    const rangeResponse = await fetch(innertubeResult.streamUrl, {
      headers: { Range: `bytes=0-${innertubeResult.contentLength - 1}` },
    });

    if ((rangeResponse.ok || rangeResponse.status === 206) && rangeResponse.body) {
      return new NextResponse(rangeResponse.body, {
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
