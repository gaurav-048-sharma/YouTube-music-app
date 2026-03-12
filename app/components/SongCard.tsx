"use client";

import { useState, useRef, useCallback } from "react";
import Image from "next/image";
import { Song } from "@/app/types/song";
import { usePlayer } from "./PlayerProvider";

interface SongCardProps {
  song: Song;
  queue: Song[];
}

export default function SongCard({ song, queue }: SongCardProps) {
  const { playSong, currentSong, isPlaying } = usePlayer();
  const isActive = currentSong?.videoId === song.videoId;
  const [downloading, setDownloading] = useState(false);
  const [queued, setQueued] = useState(false);
  const [queueMsg, setQueueMsg] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handlePlay = () => {
    playSong(song, queue);
  };

  const downloadFile = useCallback(
    async (downloadUrl: string) => {
      // Use a hidden link to trigger browser download directly
      // This avoids blob issues and works with redirects
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

  const pollForReady = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts++;
      if (attempts > 60) {
        // Stop after ~3 minutes
        if (pollRef.current) clearInterval(pollRef.current);
        setQueued(false);
        setQueueMsg("");
        return;
      }
      try {
        const res = await fetch(`/api/queue?videoId=${song.videoId}`);
        const data = await res.json();
        if (data.status === "cached") {
          if (pollRef.current) clearInterval(pollRef.current);
          setQueueMsg("Ready! Starting download...");
          // Download the cached file directly via link
          downloadFile(`/api/download?videoId=${song.videoId}`);
          setQueued(false);
          setQueueMsg("");
        } else if (data.status === "processing") {
          setQueueMsg("Downloading... please wait");
        } else if (data.status === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          setQueueMsg("Download failed. Try again later.");
          setTimeout(() => {
            setQueued(false);
            setQueueMsg("");
          }, 3000);
        }
      } catch {
        // ignore poll errors
      }
    }, 3000);
  }, [song.videoId, downloadFile]);

  const handleDownload = async () => {
    if (downloading || queued) return;
    setDownloading(true);
    try {
      // First check if already cached via queue API (fast)
      const checkRes = await fetch(`/api/queue?videoId=${song.videoId}`);
      const checkData = await checkRes.json();

      if (checkData.status === "cached") {
        // Already cached — trigger direct download via link (redirects to Cloudinary)
        downloadFile(`/api/download?videoId=${song.videoId}`);
        return;
      }

      // Not cached — call download endpoint to trigger queueing / on-the-fly download
      const titleParam = encodeURIComponent(song.title);
      const res = await fetch(
        `/api/download?videoId=${song.videoId}&title=${titleParam}`
      );

      const ct = res.headers.get("content-type") || "";
      if (res.ok && (ct.includes("audio") || ct.includes("video"))) {
        // Actually got audio back (local server downloaded on the fly)
        downloadFile(`/api/download?videoId=${song.videoId}`);
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (data.code === "QUEUED" || data.code === "NOT_CACHED") {
        setQueued(true);
        setQueueMsg("Queued — your cache-worker will process it...");
        pollForReady();
      } else {
        alert(data.error || "Download failed");
      }
    } catch {
      alert("Download failed.");
    } finally {
      setDownloading(false);
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
            downloading
              ? "song-card__btn--downloading"
              : queued
                ? "song-card__btn--queued"
                : ""
          }`}
          onClick={handleDownload}
          aria-label="Download"
          title={
            queued
              ? queueMsg
              : downloading
                ? "Downloading..."
                : "Download"
          }
          disabled={downloading || queued}
        >
          {downloading || queued ? (
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
        {queued && (
          <span className="song-card__queue-status">{queueMsg}</span>
        )}
      </div>
    </div>
  );
}
