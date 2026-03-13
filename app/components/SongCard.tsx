"use client";

import { useState, useCallback } from "react";
import Image from "next/image";
import { Song } from "@/app/types/song";
import { usePlayer } from "./PlayerProvider";

interface SongCardProps {
  song: Song;
  queue: Song[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
      const titleParam = encodeURIComponent(song.title);

      const checkRes = await fetch(`/api/queue?videoId=${song.videoId}`);
      const checkData = await checkRes.json().catch(() => ({}));
      if (checkData.status === "cached") {
        downloadFile(`/api/download?videoId=${song.videoId}`);
        return;
      }

      const tryDownload = async () => {
        const res = await fetch(
          `/api/download?videoId=${song.videoId}&title=${titleParam}`,
          { cache: "no-store" }
        );

        const ct = res.headers.get("content-type") || "";
        if (res.ok && (ct.includes("audio") || ct.includes("video"))) {
          const blob = await res.blob();
          if (blob.size > 0) {
            downloadBlob(blob, pickFilename(res.headers.get("content-disposition")));
            return { done: true, retryable: false };
          }
          downloadFile(`/api/download?videoId=${song.videoId}`);
          return { done: true, retryable: false };
        }

        const data = await res.json().catch(() => ({}));
        const retryable =
          data.code === "NOT_AVAILABLE" ||
          data.code === "NOT_CACHED" ||
          data.code === "SOURCE_UNAVAILABLE";

        if (!retryable) {
          setDownloadMsg(data.error || "This track is temporarily unavailable.");
          return { done: true, retryable: false, error: data.error as string | undefined };
        }

        return {
          done: false,
          retryable: true,
          error: (data.error as string | undefined) || "Direct download is temporarily unavailable for this track.",
        };
      };

      const firstTry = await tryDownload();
      if (firstTry.done) return;

      await sleep(900);
      const secondTry = await tryDownload();
      if (secondTry.done) return;

      await sleep(1400);
      const thirdTry = await tryDownload();
      if (thirdTry.done) return;

      setDownloadMsg(thirdTry.error || secondTry.error || firstTry.error || "This track is temporarily unavailable.");
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
