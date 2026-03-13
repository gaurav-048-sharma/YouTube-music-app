import { NextRequest, NextResponse } from "next/server";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { existsSync, chmodSync } from "fs";
import { Innertube } from "youtubei.js";
import { connectDB } from "@/lib/mongodb";
import { Song } from "@/lib/models/Song";
import { uploadAudio } from "@/lib/cloudinary";

const execFileAsync = promisify(execFile);

export const maxDuration = 60;

const YT_DLP_BUNDLED = process.cwd() + "/bin/yt-dlp";

async function findYtDlp(): Promise<string | null> {
  if (process.env.YT_DLP_PATH) {
    try {
      await execFileAsync(process.env.YT_DLP_PATH, ["--version"], {
        timeout: 5000,
      });
      return process.env.YT_DLP_PATH;
    } catch {
      // ignore
    }
  }

  if (existsSync(YT_DLP_BUNDLED)) {
    try {
      chmodSync(YT_DLP_BUNDLED, 0o755);
      await execFileAsync(YT_DLP_BUNDLED, ["--version"], { timeout: 10000 });
      return YT_DLP_BUNDLED;
    } catch {
      // ignore
    }
  }

  try {
    await execFileAsync("yt-dlp", ["--version"], { timeout: 5000 });
    return "yt-dlp";
  } catch {
    return null;
  }
}

function downloadWithYtDlp(
  videoId: string,
  ytDlpPath: string
): Promise<{ buffer: Buffer; title: string; ext: string } | null> {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const args = [
      "-f",
      "bestaudio",
      "-o",
      "-",
      "--no-cache-dir",
      "--js-runtimes",
      "node",
    ];

    const titlePromise = execFileAsync(
      ytDlpPath,
      ["--js-runtimes", "node", "--no-cache-dir", "--get-title", url],
      { timeout: 15000 }
    )
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
        const itag = parseInt(fmtMatch[1], 10);
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

async function downloadWithInnertube(
  videoId: string
): Promise<{ buffer: Buffer; title: string; ext: string } | null> {
  const clients: Array<"IOS" | "ANDROID" | "WEB"> = ["IOS", "ANDROID", "WEB"];

  try {
    const yt = await Innertube.create({
      retrieve_player: false,
      generate_session_locally: true,
    });

    for (const client of clients) {
      try {
        const info = await yt.getBasicInfo(videoId, { client });
        const audioFormats = (info.streaming_data?.adaptive_formats ?? [])
          .filter((f) => f.mime_type?.startsWith("audio/") && f.url)
          .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

        if (audioFormats.length === 0) continue;

        const fmt = audioFormats[0];
        const title = info.basic_info.title ?? videoId;
        const ext = fmt.mime_type?.includes("mp4") ? "m4a" : "webm";

        const directRes = await fetch(fmt.url!);
        if (directRes.ok) {
          const buf = Buffer.from(await directRes.arrayBuffer());
          if (buf.length > 100000) {
            return { buffer: buf, title, ext };
          }
        }

        const contentLength = Number(fmt.content_length ?? 0);
        if (contentLength > 0) {
          const chunkSize = 1024 * 1024;
          const chunks: Buffer[] = [];
          let downloaded = 0;

          while (downloaded < contentLength) {
            const end = Math.min(downloaded + chunkSize - 1, contentLength - 1);
            const res = await fetch(fmt.url!, {
              headers: { Range: `bytes=${downloaded}-${end}` },
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
      } catch {
        // try next client
      }
    }
  } catch {
    // no-op
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
    await connectDB();

    const cached = await Song.findOne({ videoId }).lean();
    if (cached) {
      const title = cached.title.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || videoId;

      try {
        const headRes = await fetch(cached.cloudinaryUrl, { method: "HEAD" });
        if (headRes.ok) {
          const dlUrl = cached.cloudinaryUrl.replace(
            "/upload/",
            `/upload/fl_attachment:${encodeURIComponent(title)}/`
          );
          return NextResponse.redirect(dlUrl, 302);
        }
      } catch {
        // stale URL, clear cache record and continue
      }

      await Song.deleteOne({ videoId });
    }

    const isVercel = !!process.env.VERCEL;
    if (isVercel) {
      return NextResponse.json(
        {
          error:
            "This song is not cached on the public server yet. Try another song.",
          code: "NOT_CACHED",
        },
        { status: 404 }
      );
    }

    let audioData: { buffer: Buffer; title: string; ext: string } | null = null;

    const ytDlpPath = await findYtDlp();
    if (ytDlpPath) {
      audioData = await downloadWithYtDlp(videoId, ytDlpPath);
    }

    if (!audioData) {
      audioData = await downloadWithInnertube(videoId);
    }

    if (!audioData) {
      return NextResponse.json(
        {
          error: "Unable to fetch this song source right now.",
          code: "SOURCE_UNAVAILABLE",
        },
        { status: 502 }
      );
    }

    const safeTitle =
      audioData.title.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || videoId;
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
    } catch {
      // Serve response even if cache upload fails.
    }

    return new NextResponse(responseBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename=\"${safeTitle}.${audioData.ext}\"`,
        "Content-Length": String(responseBuffer.length),
      },
    });
  } catch (error) {
    console.error("Download error:", error);
    return NextResponse.json({ error: "Failed to download song" }, { status: 500 });
  }
}
