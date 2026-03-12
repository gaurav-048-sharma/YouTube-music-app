// Edge function to test YouTube Innertube API with proper session
export const runtime = "edge";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const videoId = url.searchParams.get("videoId") || "dQw4w9WgXcQ";

  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return Response.json({ error: "Invalid videoId" }, { status: 400 });
  }

  const results: Record<string, unknown> = {};

  // Step 1: Get visitorData from YouTube's attestation endpoint
  let visitorData = "";
  try {
    const attRes = await fetch(
      "https://www.youtube.com/youtubei/v1/att/get?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "WEB",
              clientVersion: "2.20241126.01.00",
            },
          },
        }),
      }
    );
    const attData = await attRes.json();
    visitorData = attData.responseContext?.visitorData || "";
    results["visitorData"] = visitorData ? visitorData.substring(0, 30) + "..." : "none";
  } catch (e) {
    results["attestation"] = {
      error: e instanceof Error ? e.message.substring(0, 80) : "unknown",
    };
  }

  // Step 2: Test IOS and ANDROID_VR with visitorData
  const clients = [
    {
      name: "IOS",
      clientName: "IOS",
      clientVersion: "19.29.1",
      ua: "com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)",
      clientNumber: "5",
    },
    {
      name: "ANDROID_VR",
      clientName: "ANDROID_VR",
      clientVersion: "1.60.19",
      ua: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
      clientNumber: "28",
    },
    {
      name: "IOS_CREATOR",
      clientName: "IOS_CREATOR",
      clientVersion: "22.33.101",
      ua: "com.google.ios.ytcreator/22.33.101 (iPhone16,2; U; CPU iOS 16_0 like Mac OS X)",
      clientNumber: "15",
    },
  ];

  for (const client of clients) {
    for (const useVisitor of [false, true]) {
      const key = `${client.name}${useVisitor ? "_WITH_VISITOR" : ""}`;
      try {
        const body: Record<string, unknown> = {
          videoId,
          context: {
            client: {
              clientName: client.clientName,
              clientVersion: client.clientVersion,
              hl: "en",
              gl: "US",
              ...(useVisitor && visitorData ? { visitorData } : {}),
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
              "X-Goog-Visitor-Id": useVisitor && visitorData ? visitorData : "",
            },
            body: JSON.stringify(body),
          }
        );

        const data = await res.json();
        const audioFormats = (data.streamingData?.adaptiveFormats ?? []).filter(
          (f: { mimeType?: string }) => f.mimeType?.startsWith("audio/")
        );
        const withUrl = audioFormats.filter((f: { url?: string }) => !!f.url).length;

        results[key] = {
          status: data.playabilityStatus?.status,
          reason: data.playabilityStatus?.reason?.substring(0, 60),
          audioFormats: audioFormats.length,
          withUrl,
        };
      } catch (e) {
        results[key] = {
          error: e instanceof Error ? e.message.substring(0, 80) : "unknown",
        };
      }
    }
  }

  return Response.json({ videoId, runtime: "edge", results });
}
