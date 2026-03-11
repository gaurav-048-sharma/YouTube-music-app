import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import os from "os";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

export async function GET(request: NextRequest) {
  const videoId = request.nextUrl.searchParams.get("videoId");

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return NextResponse.json(
      { error: "Valid 'videoId' parameter is required" },
      { status: 400 }
    );
  }

  const tmpDir = os.tmpdir();
  const filename = `yt-${crypto.randomBytes(8).toString("hex")}`;
  const outputPath = path.join(tmpDir, `${filename}.mp3`);
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    // Use yt-dlp to extract audio as mp3
    await execFileAsync("yt-dlp", [
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "-o",
      outputPath.replace(".mp3", ".%(ext)s"),
      "--no-playlist",
      videoUrl,
    ]);

    // yt-dlp may produce the file with the extension applied
    const mp3Path = outputPath;

    // Verify the file exists
    await fs.access(mp3Path);
    const fileBuffer = await fs.readFile(mp3Path);

    // Clean up temp file
    await fs.unlink(mp3Path).catch(() => {});

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": `attachment; filename="${videoId}.mp3"`,
        "Content-Length": String(fileBuffer.length),
      },
    });
  } catch (error) {
    console.error("Download error:", error);
    // Clean up on error
    await fs.unlink(outputPath).catch(() => {});

    return NextResponse.json(
      {
        error:
          "Failed to download song. Make sure yt-dlp is installed on the server.",
      },
      { status: 500 }
    );
  }
}
