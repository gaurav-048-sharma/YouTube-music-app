import { NextRequest, NextResponse } from "next/server";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { existsSync, chmodSync } from "fs";
import { Innertube } from "youtubei.js";
import { connectDB } from "@/lib/mongodb";
import { Song } from "@/lib/models/Song";
import { uploadAudio } from "@/lib/cloudinary";

const execFileAsync = promisify(execFile);
type AudioData = { buffer: Buffer; title: string; ext: string };

export const maxDuration = 60;

const YT_DLP_BUNDLED = process.cwd() + "/bin/yt-dlp";

const CLIENT_USER_AGENTS: Record<string, string> = {
  IOS: "com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)",
  ANDROID: "com.google.android.youtube/19.29.34 (Linux; U; Android 14) gzip",
  WEB: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  ANDROID_VR: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L)",
  ANDROID_MUSIC: "com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 14)",
  ANDROID_TESTSUITE: "com.google.android.youtube/19.29.34 (Linux; U; Android 14)",
  TVHTML5_SIMPLY_EMBEDDED_PLAYER: "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0)",
};

function randomIPv4(): string {
  const a = Math.floor(Math.random() * 223) + 1;
  const b = Math.floor(Math.random() * 255);
  const c = Math.floor(Math.random() * 255);
  const d = Math.floor(Math.random() * 255);
  return `${a}.${b}.${c}.${d}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 12000
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
): Promise<AudioData | null> {
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
): Promise<AudioData | null> {
  const clients: Array<"IOS" | "ANDROID" | "WEB"> = ["IOS", "ANDROID", "WEB"];

  try {
    const yt = await withTimeout(
      Innertube.create({
        retrieve_player: false,
        generate_session_locally: true,
      }),
      8000
    );

    for (const client of clients) {
      try {
        const info = await withTimeout(yt.getBasicInfo(videoId, { client }), 9000);
        const audioFormats = (info.streaming_data?.adaptive_formats ?? [])
          .filter((f) => f.mime_type?.startsWith("audio/") && f.url)
          .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

        if (audioFormats.length === 0) continue;

        const fmt = audioFormats[0];
        const title = info.basic_info.title ?? videoId;
        const ext = fmt.mime_type?.includes("mp4") ? "m4a" : "webm";
        const spoofedIp = randomIPv4();
        const requestHeaders = {
          "User-Agent": CLIENT_USER_AGENTS[client] || CLIENT_USER_AGENTS.WEB,
          Referer: `https://www.youtube.com/watch?v=${videoId}`,
          Origin: "https://www.youtube.com",
          "Accept-Language": "en-US,en;q=0.9",
          "X-Forwarded-For": spoofedIp,
          "X-Real-IP": spoofedIp,
        };

        const directRes = await fetchWithTimeout(
          fmt.url!,
          { headers: requestHeaders },
          12000
        );
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
            const res = await fetchWithTimeout(
              fmt.url!,
              {
                headers: {
                  ...requestHeaders,
                  Range: `bytes=${downloaded}-${end}`,
                },
              },
              12000
            );
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

async function downloadWithDirectPlayerAPI(videoId: string): Promise<AudioData | null> {
  const clients = [
    {
      clientName: "ANDROID_VR",
      clientVersion: "1.60.19",
      apiKey: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      ua: CLIENT_USER_AGENTS.ANDROID_VR,
      xClientName: "28",
    },
    {
      clientName: "ANDROID_MUSIC",
      clientVersion: "7.27.52",
      apiKey: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      ua: CLIENT_USER_AGENTS.ANDROID_MUSIC,
      xClientName: "21",
    },
    {
      clientName: "ANDROID_TESTSUITE",
      clientVersion: "1.9",
      apiKey: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      ua: CLIENT_USER_AGENTS.ANDROID_TESTSUITE,
      xClientName: "30",
    },
    {
      clientName: "ANDROID",
      clientVersion: "19.29.34",
      apiKey: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      ua: CLIENT_USER_AGENTS.ANDROID,
      xClientName: "3",
    },
    {
      clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
      clientVersion: "2.0",
      apiKey: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      ua: CLIENT_USER_AGENTS.TVHTML5_SIMPLY_EMBEDDED_PLAYER,
      xClientName: "85",
    },
  ];

  for (const client of clients) {
    try {
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

      if (client.clientName === "TVHTML5_SIMPLY_EMBEDDED_PLAYER") {
        (body.context as Record<string, unknown>).thirdParty = {
          embedUrl: "https://www.youtube.com",
        };
      }

      const spoofedIp = randomIPv4();

      const res = await fetchWithTimeout(
        `https://www.youtube.com/youtubei/v1/player?key=${client.apiKey}&prettyPrint=false`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": client.ua,
            "X-YouTube-Client-Name": client.xClientName,
            "X-YouTube-Client-Version": client.clientVersion,
            Referer: `https://www.youtube.com/watch?v=${videoId}`,
            Origin: "https://www.youtube.com",
            "Accept-Language": "en-US,en;q=0.9",
            "X-Forwarded-For": spoofedIp,
            "X-Real-IP": spoofedIp,
            "Client-IP": spoofedIp,
            "X-Originating-IP": spoofedIp,
          },
          body: JSON.stringify(body),
        },
        9000
      );

      if (!res.ok) continue;
      const data = await res.json();
      if (data.playabilityStatus?.status !== "OK") continue;

      const title = data.videoDetails?.title ?? videoId;
      const formats = [
        ...(data.streamingData?.adaptiveFormats ?? []),
        ...(data.streamingData?.formats ?? []),
      ];

      const audioFormats = formats
        .filter((f: { mimeType?: string; url?: string }) => f.mimeType?.startsWith("audio/") && f.url)
        .sort((a: { bitrate?: number }, b: { bitrate?: number }) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

      if (!audioFormats.length) continue;

      const fmt = audioFormats[0];
      const ext = fmt.mimeType?.includes("mp4") ? "m4a" : "webm";
      const audioRes = await fetchWithTimeout(
        fmt.url,
        {
          headers: {
            "User-Agent": client.ua,
            Referer: `https://www.youtube.com/watch?v=${videoId}`,
            Origin: "https://www.youtube.com",
            "Accept-Language": "en-US,en;q=0.9",
            "X-Forwarded-For": spoofedIp,
            "X-Real-IP": spoofedIp,
          },
        },
        12000
      );
      if (!audioRes.ok) {
        const cl = fmt.contentLength ? parseInt(fmt.contentLength, 10) : 0;
        if (cl <= 0) continue;

        const chunkSize = 1024 * 1024;
        const chunks: Buffer[] = [];
        let downloaded = 0;

        while (downloaded < cl) {
          const end = Math.min(downloaded + chunkSize - 1, cl - 1);
          const chunkRes = await fetchWithTimeout(
            fmt.url,
            {
              headers: {
                "User-Agent": client.ua,
                Referer: `https://www.youtube.com/watch?v=${videoId}`,
                Origin: "https://www.youtube.com",
                Range: `bytes=${downloaded}-${end}`,
                "X-Forwarded-For": spoofedIp,
                "X-Real-IP": spoofedIp,
              },
            },
            12000
          );
          if (!chunkRes.ok && chunkRes.status !== 206) break;
          const buf = Buffer.from(await chunkRes.arrayBuffer());
          if (!buf.length) break;
          chunks.push(buf);
          downloaded += buf.length;
        }

        if (downloaded >= cl && chunks.length) {
          const title = data.videoDetails?.title ?? videoId;
          return { buffer: Buffer.concat(chunks), title, ext };
        }

        continue;
      }

      const buf = Buffer.from(await audioRes.arrayBuffer());
      if (buf.length > 100000) {
        return { buffer: buf, title, ext };
      }
    } catch {
      // try next client
    }
  }

  return null;
}

async function downloadWithCobalt(videoId: string): Promise<AudioData | null> {
  const jwt = process.env.COBALT_JWT;
  if (!jwt) return null;

  const base = (process.env.COBALT_API_URL || "https://api.cobalt.tools").replace(/\/+$/, "");

  try {
    const res = await fetchWithTimeout(
      `${base}/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          url: `https://www.youtube.com/watch?v=${videoId}`,
          downloadMode: "audio",
          audioFormat: "mp3",
        }),
      },
      10000
    );

    if (!res.ok) return null;
    const data = await res.json();

    let mediaUrl: string | undefined;
    if (data.status === "tunnel" || data.status === "redirect") {
      mediaUrl = data.url;
    } else if (data.status === "picker" && Array.isArray(data.picker)) {
      const audioOption = data.picker.find((p: { type?: string }) => p.type === "audio");
      mediaUrl = audioOption?.url;
    }

    if (!mediaUrl) return null;

    const audioRes = await fetchWithTimeout(mediaUrl, {}, 15000);
    if (!audioRes.ok) return null;

    const buf = Buffer.from(await audioRes.arrayBuffer());
    if (buf.length < 100000) return null;

    const cd = audioRes.headers.get("content-disposition") || "";
    const match = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    const title = match ? decodeURIComponent(match[1]).replace(/\.\w+$/, "") : videoId;
    return { buffer: buf, title, ext: "mp3" };
  } catch {
    return null;
  }
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
    let audioData: AudioData | null = null;

    if (isVercel) {
      // Try no-queue server extraction paths on public host.
      audioData = await downloadWithInnertube(videoId);

      if (!audioData) {
        audioData = await downloadWithDirectPlayerAPI(videoId);
      }

      if (!audioData) {
        audioData = await downloadWithCobalt(videoId);
      }

      if (!audioData) {
        return NextResponse.json(
          {
            error:
              "This song is not available for direct public download right now.",
            code: "NOT_CACHED",
          },
          { status: 200 }
        );
      }
    } else {
      const ytDlpPath = await findYtDlp();
      if (ytDlpPath) {
        audioData = await downloadWithYtDlp(videoId, ytDlpPath);
      }

      if (!audioData) {
        audioData = await downloadWithInnertube(videoId);
      }
    }

    if (!audioData) {
      return NextResponse.json(
        {
          error: "Unable to fetch this song source right now.",
          code: "SOURCE_UNAVAILABLE",
        },
        { status: 200 }
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
