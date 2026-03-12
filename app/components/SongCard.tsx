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
    async (res: Response) => {
      const disposition = res.headers.get("Content-Disposition");
      const filenameMatch = disposition?.match(/filename="(.+)"/);
      const filename =
        filenameMatch?.[1] ??
        `${song.title.replace(/[^a-zA-Z0-9 ]/g, "")}.m4a`;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    [song.title]
  );

  const pollForReady = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts++;
      if (attempts > 30) {
        // Stop after ~5 minutes
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
          // Now download the cached file
          const dlRes = await fetch(
            `/api/download?videoId=${song.videoId}`
          );
          if (dlRes.ok) {
            await downloadFile(dlRes);
          }
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
    }, 10000);
  }, [song.videoId, downloadFile]);

  const handleDownload = async () => {
    if (downloading || queued) return;
    setDownloading(true);
    try {
      const titleParam = encodeURIComponent(song.title);
      const res = await fetch(
        `/api/download?videoId=${song.videoId}&title=${titleParam}`
      );

      if (res.ok) {
        await downloadFile(res);
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (data.code === "QUEUED" || data.code === "NOT_CACHED") {
        // Song has been queued for download
        setQueued(true);
        setQueueMsg("Queued for download...");
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
