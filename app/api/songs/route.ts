import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { Song } from "@/lib/models/Song";

/**
 * GET /api/songs — list all cached songs in MongoDB
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const page = parseInt(request.nextUrl.searchParams.get("page") ?? "1");
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "50"), 100);
    const skip = (page - 1) * limit;

    const [songs, total] = await Promise.all([
      Song.find({})
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("videoId title ext fileSize cloudinaryUrl createdAt")
        .lean(),
      Song.countDocuments(),
    ]);

    return NextResponse.json({
      songs,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Songs list error:", error);
    return NextResponse.json(
      { error: "Failed to fetch songs" },
      { status: 500 }
    );
  }
}
