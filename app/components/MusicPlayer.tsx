"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";
import { usePlayer } from "./PlayerProvider";

declare global {
  interface Window {
    YT: typeof YT;
    onYouTubeIframeAPIReady: () => void;
  }
}

export default function MusicPlayer() {
  const {
    currentSong,
    isPlaying,
    togglePlayPause,
    playNext,
    playPrevious,
    setIsPlaying,
    queue,
  } = usePlayer();

  const playerRef = useRef<YT.Player | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const [apiReady, setApiReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(80);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load YouTube IFrame API
  useEffect(() => {
    if (window.YT && window.YT.Player) {
      // Defer state update to avoid synchronous setState in effect body
      queueMicrotask(() => setApiReady(true));
      return;
    }

    const existingScript = document.getElementById("youtube-iframe-api");
    if (!existingScript) {
      const script = document.createElement("script");
      script.id = "youtube-iframe-api";
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    }

    window.onYouTubeIframeAPIReady = () => {
      setApiReady(true);
    };
  }, []);

  // Initialize player when API is ready and song changes
  useEffect(() => {
    if (!apiReady || !currentSong) return;

    if (playerRef.current) {
      playerRef.current.loadVideoById(currentSong.videoId);
      return;
    }

    playerRef.current = new window.YT.Player("yt-player", {
      height: "0",
      width: "0",
      videoId: currentSong.videoId,
      playerVars: {
        autoplay: 1,
        controls: 0,
        disablekb: 1,
        fs: 0,
        modestbranding: 1,
      },
      events: {
        onReady: (event: YT.PlayerEvent) => {
          event.target.setVolume(volume);
        },
        onStateChange: (event: YT.OnStateChangeEvent) => {
          if (event.data === window.YT.PlayerState.ENDED) {
            playNext();
          }
          if (event.data === window.YT.PlayerState.PLAYING) {
            setIsPlaying(true);
          }
          if (event.data === window.YT.PlayerState.PAUSED) {
            setIsPlaying(false);
          }
        },
      },
    });
  }, [apiReady, currentSong, playNext, setIsPlaying, volume]);

  // Play/Pause sync
  useEffect(() => {
    if (!playerRef.current) return;
    try {
      if (isPlaying) {
        playerRef.current.playVideo();
      } else {
        playerRef.current.pauseVideo();
      }
    } catch {
      // Player not ready yet
    }
  }, [isPlaying]);

  // Progress tracking
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);

    if (isPlaying && playerRef.current) {
      intervalRef.current = setInterval(() => {
        try {
          const current = playerRef.current!.getCurrentTime();
          const total = playerRef.current!.getDuration();
          setCurrentTime(current);
          setDuration(total);
          setProgress(total > 0 ? (current / total) * 100 : 0);
        } catch {
          // Player not ready
        }
      }, 500);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying]);

  // Sync progress fill bar width via ref
  useEffect(() => {
    if (progressFillRef.current) {
      progressFillRef.current.style.width = `${progress}%`;
    }
  }, [progress]);

  // Volume sync
  useEffect(() => {
    if (playerRef.current) {
      try {
        playerRef.current.setVolume(volume);
      } catch {
        // Player not ready
      }
    }
  }, [volume]);

  const handleProgressClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!progressRef.current || !playerRef.current) return;
      const rect = progressRef.current.getBoundingClientRect();
      const fraction = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left) / rect.width)
      );
      const seekTo = fraction * duration;
      playerRef.current.seekTo(seekTo, true);
      setProgress(fraction * 100);
      setCurrentTime(seekTo);
    },
    [duration]
  );

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const currentIndex = currentSong
    ? queue.findIndex((s) => s.videoId === currentSong.videoId)
    : -1;
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < queue.length - 1;

  if (!currentSong) return null;

  return (
    <div className="music-player">
      {/* Hidden YouTube player */}
      <div ref={containerRef} className="yt-player-hidden">
        <div id="yt-player" />
      </div>

      {/* Song info */}
      <div className="player__song-info">
        <Image
          src={currentSong.thumbnail}
          alt={currentSong.title}
          width={52}
          height={52}
          className="player__thumbnail"
          unoptimized
        />
        <div className="player__text">
          <span className="player__title" title={currentSong.title}>
            {currentSong.title}
          </span>
          <span className="player__channel">{currentSong.channelName}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="player__controls">
        <div className="player__buttons">
          <button
            className="player__btn"
            onClick={playPrevious}
            disabled={!hasPrevious}
            aria-label="Previous"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="19,20 9,12 19,4" />
              <rect x="5" y="4" width="2" height="16" />
            </svg>
          </button>

          <button
            className="player__btn player__btn--play"
            onClick={togglePlayPause}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            )}
          </button>

          <button
            className="player__btn"
            onClick={playNext}
            disabled={!hasNext}
            aria-label="Next"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,4 15,12 5,20" />
              <rect x="17" y="4" width="2" height="16" />
            </svg>
          </button>
        </div>

        <div className="player__progress-row">
          <span className="player__time">{formatTime(currentTime)}</span>
          <div
            className="player__progress-bar"
            ref={progressRef}
            onClick={handleProgressClick}
          >
            <div
              className="player__progress-fill"
              ref={progressFillRef}
            />
          </div>
          <span className="player__time">{formatTime(duration)}</span>
        </div>
      </div>

      {/* Volume */}
      <div className="player__volume">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          {volume > 0 && (
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          )}
          {volume > 40 && (
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          )}
        </svg>
        <input
          type="range"
          min="0"
          max="100"
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          className="player__volume-slider"
          aria-label="Volume"
        />
      </div>
    </div>
  );
}
