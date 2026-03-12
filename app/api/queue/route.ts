import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { DownloadQueue } from "@/lib/models/DownloadQueue";
import { Song } from "@/lib/models/Song";

// Queue a song for download (or check its status)
export async function POST(request: NextRequest) {
  try {
    const { videoId, title, thumbnail } = await request.json();

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return NextResponse.json(
        { error: "Valid 'videoId' is required" },
        { status: 400 }
      );
    }

    await connectDB();

    // Check if already cached
    const cached = await Song.findOne({ videoId }).lean();
    if (cached) {
      return NextResponse.json({ status: "cached", videoId });
    }

    // Check if already in queue
    const existing = await DownloadQueue.findOne({ videoId }).lean();
    if (existing) {
      return NextResponse.json({
        status: existing.status,
        videoId,
        requestedAt: existing.requestedAt,
      });
    }

    // Add to queue
    await DownloadQueue.create({
      videoId,
      title: title || videoId,
      thumbnail: thumbnail || "",
      status: "pending",
      requestedAt: new Date(),
    });

    return NextResponse.json({ status: "pending", videoId });
  } catch (error) {
    console.error("Queue error:", error);
    return NextResponse.json(
      { error: "Failed to queue download" },
      { status: 500 }
    );
  }
}

// Check queue status for a video
export async function GET(request: NextRequest) {
  const videoId = request.nextUrl.searchParams.get("videoId");

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return NextResponse.json(
      { error: "Valid 'videoId' is required" },
      { status: 400 }
    );
  }

  try {
    await connectDB();

    // Check if cached
    const cached = await Song.findOne({ videoId }).lean();
    if (cached) {
      return NextResponse.json({ status: "cached", videoId });
    }

    // Check queue
    const queued = await DownloadQueue.findOne({ videoId }).lean();
    if (queued) {
      return NextResponse.json({
        status: queued.status,
        videoId,
        error: queued.error,
        requestedAt: queued.requestedAt,
      });
    }

    return NextResponse.json({ status: "not_found", videoId });
  } catch (error) {
    console.error("Queue status error:", error);
    return NextResponse.json(
      { error: "Failed to check queue status" },
      { status: 500 }
    );
  }
}
