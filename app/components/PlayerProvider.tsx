"use client";

import React, { createContext, useContext, useState, useCallback } from "react";
import { Song } from "@/app/types/song";

interface PlayerState {
  currentSong: Song | null;
  queue: Song[];
  isPlaying: boolean;
}

interface PlayerContextType extends PlayerState {
  playSong: (song: Song, queue?: Song[]) => void;
  togglePlayPause: () => void;
  playNext: () => void;
  playPrevious: () => void;
  setIsPlaying: (playing: boolean) => void;
}

const PlayerContext = createContext<PlayerContextType | null>(null);

export function usePlayer() {
  const context = useContext(PlayerContext);
  if (!context) {
    throw new Error("usePlayer must be used within a PlayerProvider");
  }
  return context;
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<PlayerState>({
    currentSong: null,
    queue: [],
    isPlaying: false,
  });

  const playSong = useCallback((song: Song, queue?: Song[]) => {
    setState((prev) => ({
      currentSong: song,
      queue: queue ?? prev.queue,
      isPlaying: true,
    }));
  }, []);

  const togglePlayPause = useCallback(() => {
    setState((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
  }, []);

  const playNext = useCallback(() => {
    setState((prev) => {
      if (!prev.currentSong || prev.queue.length === 0) return prev;
      const currentIndex = prev.queue.findIndex(
        (s) => s.videoId === prev.currentSong!.videoId
      );
      const nextIndex = currentIndex + 1;
      if (nextIndex >= prev.queue.length) return prev;
      return { ...prev, currentSong: prev.queue[nextIndex], isPlaying: true };
    });
  }, []);

  const playPrevious = useCallback(() => {
    setState((prev) => {
      if (!prev.currentSong || prev.queue.length === 0) return prev;
      const currentIndex = prev.queue.findIndex(
        (s) => s.videoId === prev.currentSong!.videoId
      );
      const prevIndex = currentIndex - 1;
      if (prevIndex < 0) return prev;
      return { ...prev, currentSong: prev.queue[prevIndex], isPlaying: true };
    });
  }, []);

  const setIsPlaying = useCallback((playing: boolean) => {
    setState((prev) => ({ ...prev, isPlaying: playing }));
  }, []);

  return (
    <PlayerContext.Provider
      value={{
        ...state,
        playSong,
        togglePlayPause,
        playNext,
        playPrevious,
        setIsPlaying,
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
}
