import { NextRequest, NextResponse } from "next/server";
import { searchYouTubeMusic } from "@/app/lib/youtube";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q");

  if (!query || query.trim().length === 0) {
    return NextResponse.json(
      { error: "Query parameter 'q' is required" },
      { status: 400 }
    );
  }

  try {
    const songs = await searchYouTubeMusic(query.trim());
    return NextResponse.json({ songs });
  } catch (error) {
    console.error("Search error:", error);
    return NextResponse.json(
      { error: "Failed to search for songs" },
      { status: 500 }
    );
  }
}
