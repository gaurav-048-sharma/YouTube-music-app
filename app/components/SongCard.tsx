"use client";

import { useState, useCallback } from "react";
import Image from "next/image";
import { Song } from "@/app/types/song";
import { usePlayer } from "./PlayerProvider";

interface SongCardProps {
  song: Song;
  queue: Song[];
}

type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string | number;
  execute: (id?: string | number) => void;
  remove: (id?: string | number) => void;
};

const TURNSTILE_SITEKEY = "0x4AAAAAAAhUvTuTxLs2HYH4";
let turnstileScriptPromise: Promise<void> | null = null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const w = window as Window & { turnstile?: TurnstileApi };
  if (w.turnstile) return Promise.resolve();

  if (!turnstileScriptPromise) {
    turnstileScriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        'script[src*="challenges.cloudflare.com/turnstile/v0/api.js"]'
      );

      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Turnstile failed to load")), {
          once: true,
        });
        return;
      }

      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Turnstile failed to load"));
      document.head.appendChild(script);
    });
  }

  return turnstileScriptPromise;
}

export default function SongCard({ song, queue }: SongCardProps) {
  const { playSong, currentSong, isPlaying } = usePlayer();
  const isActive = currentSong?.videoId === song.videoId;
  const [downloading, setDownloading] = useState(false);
  const [downloadMsg, setDownloadMsg] = useState("");

  const handlePlay = () => {
    playSong(song, queue);
  };

  const downloadFile = useCallback(
    (downloadUrl: string) => {
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = `${song.title.replace(/[^a-zA-Z0-9 ]/g, "")}.mp3`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    [song.title]
  );

  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, []);

  const getTurnstileToken = useCallback(async (): Promise<string | null> => {
    try {
      await ensureTurnstileScript();
      const w = window as Window & { turnstile?: TurnstileApi };
      const turnstile = w.turnstile;
      if (!turnstile) return null;

      return await new Promise((resolve) => {
        const container = document.createElement("div");
        container.style.position = "fixed";
        container.style.left = "-9999px";
        container.style.top = "-9999px";
        document.body.appendChild(container);

        const cleanup = (id?: string | number) => {
          try {
            if (id !== undefined) turnstile.remove(id);
          } catch {
            // ignore cleanup errors
          }
          container.remove();
        };

        const widgetId = turnstile.render(container, {
          sitekey: TURNSTILE_SITEKEY,
          size: "invisible",
          callback: (token: string) => {
            window.clearTimeout(timeoutRef);
            cleanup(widgetId);
            resolve(token || null);
          },
          "error-callback": () => {
            window.clearTimeout(timeoutRef);
            cleanup(widgetId);
            resolve(null);
          },
          "expired-callback": () => {
            window.clearTimeout(timeoutRef);
            cleanup(widgetId);
            resolve(null);
          },
        });

        const timeoutRef = window.setTimeout(() => {
          cleanup(widgetId);
          resolve(null);
        }, 15_000);

        turnstile.execute(widgetId);
      });
    } catch {
      return null;
    }
  }, []);

  const pickFilename = useCallback((contentDisposition: string | null) => {
    const fallback = `${song.title.replace(/[^a-zA-Z0-9 ]/g, "").trim() || song.videoId}.mp3`;
    if (!contentDisposition) return fallback;

    const starMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (starMatch?.[1]) {
      try {
        return decodeURIComponent(starMatch[1]);
      } catch {
        return starMatch[1];
      }
    }

    const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
    if (plainMatch?.[1]) return plainMatch[1];
    return fallback;
  }, [song.title, song.videoId]);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadMsg("");
    try {
      const turnstileToken = await getTurnstileToken();
      const titleParam = encodeURIComponent(song.title);
      const tokenParam = turnstileToken
        ? `&cfToken=${encodeURIComponent(turnstileToken)}`
        : "";
      const maxAttempts = 2;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const res = await fetch(
          `/api/download?videoId=${song.videoId}&title=${titleParam}${tokenParam}`,
          { cache: "no-store" }
        );

        const ct = res.headers.get("content-type") || "";
        if (res.ok && (ct.includes("audio") || ct.includes("video"))) {
          const blob = await res.blob();
          if (blob.size > 0) {
            downloadBlob(blob, pickFilename(res.headers.get("content-disposition")));
            return;
          }
          downloadFile(`/api/download?videoId=${song.videoId}`);
          return;
        }

        const data = await res.json().catch(() => ({}));
        const retryable =
          data.code === "NOT_AVAILABLE" ||
          data.code === "NOT_CACHED" ||
          data.code === "SOURCE_UNAVAILABLE";

        if (retryable && attempt < maxAttempts - 1) {
          await sleep(900);
          continue;
        }

        if (retryable) {
          return;
        }

        setDownloadMsg(data.error || "This track is temporarily unavailable.");
        return;
      }

      setDownloadMsg("This track is temporarily unavailable.");
    } catch {
      setDownloadMsg("Please try again in a moment.");
    } finally {
      setDownloading(false);
      setTimeout(() => setDownloadMsg(""), 4000);
    }
  };

  return (
    <div className={`song-card ${isActive ? "song-card--active" : ""}`}>
      <div className="song-card__thumbnail-wrapper" onClick={handlePlay}>
        <Image
          src={song.thumbnail}
          alt={song.title}
          width={64}
          height={64}
          className="song-card__thumbnail"
          unoptimized
        />
        <div className="song-card__play-overlay">
          {isActive && isPlaying ? (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
              <polygon points="5,3 19,12 5,21" />
            </svg>
          )}
        </div>
      </div>
      <div className="song-card__info">
        <h3 className="song-card__title" title={song.title}>
          {song.title}
        </h3>
        <p className="song-card__channel">{song.channelName}</p>
      </div>
      <div className="song-card__actions">
        <button
          className="song-card__btn song-card__btn--play"
          onClick={handlePlay}
          aria-label="Play"
          title="Play"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5,3 19,12 5,21" />
          </svg>
        </button>
        <button
          className={`song-card__btn song-card__btn--download ${
            downloading ? "song-card__btn--downloading" : ""
          }`}
          onClick={handleDownload}
          aria-label="Download"
          title={downloading ? "Downloading..." : "Download"}
          disabled={downloading}
        >
          {downloading ? (
            <span className="download-spinner" />
          ) : (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          )}
        </button>
        {downloadMsg && (
          <span className="song-card__queue-status">{downloadMsg}</span>
        )}
      </div>
    </div>
  );
}
