// Edge function to test if Vercel edge network can reach YouTube Innertube API
export const runtime = "edge";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const videoId = url.searchParams.get("videoId") || "dQw4w9WgXcQ";

  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return Response.json({ error: "Invalid videoId" }, { status: 400 });
  }

  const results: Record<string, unknown> = {};

  // Test IOS client (no signature decipher needed)
  const clients = [
    {
      name: "IOS",
      clientName: "IOS",
      clientVersion: "19.29.1",
      ua: "com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)",
    },
    {
      name: "ANDROID_VR",
      clientName: "ANDROID_VR",
      clientVersion: "1.60.19",
      ua: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
    },
    {
      name: "TVHTML5",
      clientName: "TVHTML5",
      clientVersion: "7.20240813.07.00",
      ua: "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 NativeBrowser/2.0 TV Safari/538.1",
    },
    {
      name: "MEDIA_CONNECT",
      clientName: "MEDIA_CONNECT_FRONTEND",
      clientVersion: "0.1",
      ua: "Mozilla/5.0",
    },
  ];

  for (const client of clients) {
    try {
      const body = {
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

      const res = await fetch(
        "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": client.ua,
          },
          body: JSON.stringify(body),
        }
      );

      const data = await res.json();
      const audioFormats = (data.streamingData?.adaptiveFormats ?? [])
        .filter(
          (f: { mimeType?: string; url?: string }) =>
            f.mimeType?.startsWith("audio/")
        );
      const withUrl = audioFormats.filter(
        (f: { url?: string }) => !!f.url
      ).length;

      results[client.name] = {
        status: data.playabilityStatus?.status,
        reason: data.playabilityStatus?.reason?.substring(0, 80),
        audioFormats: audioFormats.length,
        withUrl,
      };
    } catch (e) {
      results[client.name] = {
        error: e instanceof Error ? e.message.substring(0, 100) : "unknown",
      };
    }
  }

  return Response.json({ videoId, runtime: "edge", results });
}
