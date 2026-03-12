import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/cache-seed — Pre-cache songs from a local machine.
 * Calls /api/download for each videoId to trigger download + cache.
 *
 * Body: { "videoIds": ["dQw4w9WgXcQ", "kJQP7kiw5Fk", ...] }
 *
 * This endpoint is meant to be called from a local machine where
 * yt-dlp can download from YouTube without datacenter IP blocks.
 */
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const videoIds: string[] = body.videoIds;

    if (!Array.isArray(videoIds) || videoIds.length === 0) {
      return NextResponse.json(
        { error: "Provide an array of videoIds" },
        { status: 400 }
      );
    }

    // Validate all IDs
    const validIds = videoIds.filter((id) => /^[a-zA-Z0-9_-]{11}$/.test(id));
    if (validIds.length === 0) {
      return NextResponse.json(
        { error: "No valid video IDs provided" },
        { status: 400 }
      );
    }

    const origin = request.nextUrl.origin;
    const results: { videoId: string; status: string; error?: string }[] = [];

    // Process sequentially to avoid overwhelming resources
    for (const videoId of validIds) {
      try {
        const res = await fetch(`${origin}/api/download?videoId=${videoId}`, {
          method: "GET",
        });

        if (res.ok) {
          // Consume the body to ensure the request completes
          await res.arrayBuffer();
          results.push({ videoId, status: "cached" });
        } else {
          const err = await res.json().catch(() => ({ error: "Unknown error" }));
          results.push({ videoId, status: "failed", error: err.error });
        }
      } catch (err) {
        results.push({
          videoId,
          status: "failed",
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    const cached = results.filter((r) => r.status === "cached").length;
    const failed = results.filter((r) => r.status === "failed").length;

    return NextResponse.json({
      message: `Cached ${cached}/${validIds.length} songs (${failed} failed)`,
      results,
    });
  } catch (error) {
    console.error("Cache seed error:", error);
    return NextResponse.json(
      { error: "Failed to process cache seed request" },
      { status: 500 }
    );
  }
}
