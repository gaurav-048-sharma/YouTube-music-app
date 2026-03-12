/**
 * Cache Seed Script — Run locally to pre-cache songs to Cloudinary+MongoDB
 *
 * Usage:
 *   node scripts/cache-seed.mjs                         # cache default popular songs
 *   node scripts/cache-seed.mjs dQw4w9WgXcQ kJQP7kiw5Fk  # cache specific video IDs
 *
 * This calls your LOCAL dev server's /api/download endpoint for each video,
 * which triggers yt-dlp download + Cloudinary upload + MongoDB save.
 * Once cached, Vercel can serve these songs from Cloudinary.
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

// Popular songs to pre-cache if no args provided
const DEFAULT_VIDEO_IDS = [
  "dQw4w9WgXcQ",  // Rick Astley - Never Gonna Give You Up
  "kJQP7kiw5Fk",  // Luis Fonsi - Despacito
  "fJ9rUzIMcZQ",  // Queen - Bohemian Rhapsody
  "JGwWNGJdvx8",  // Ed Sheeran - Shape of You
  "RgKAFK5djSk",  // Wiz Khalifa - See You Again
  "OPf0YbXqDm0",  // Mark Ronson - Uptown Funk
  "60ItHLz5WEA",  // Alan Walker - Faded
  "YCuhzjK11iA",  // Throttled test video
];

const videoIds = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : DEFAULT_VIDEO_IDS;

console.log(`\n🎵 Cache Seed — caching ${videoIds.length} songs via ${BASE_URL}\n`);

for (const videoId of videoIds) {
  process.stdout.write(`  ${videoId} ... `);
  const start = Date.now();

  try {
    const res = await fetch(`${BASE_URL}/api/download?videoId=${videoId}`);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (res.ok) {
      const bytes = (await res.arrayBuffer()).byteLength;
      const mb = (bytes / 1024 / 1024).toFixed(1);
      console.log(`✅ cached (${mb}MB, ${elapsed}s)`);
    } else {
      const err = await res.json().catch(() => ({}));
      console.log(`❌ failed: ${err.error || res.status} (${elapsed}s)`);
    }
  } catch (err) {
    console.log(`❌ error: ${err.message}`);
  }
}

console.log("\n✨ Done! Cached songs are now available on Vercel.\n");
