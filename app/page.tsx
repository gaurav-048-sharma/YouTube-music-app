"use client";

import { useState } from "react";
import SearchBar from "./components/SearchBar";
import SongCard from "./components/SongCard";
import { Song } from "./types/song";

export default function Home() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async (query: string) => {
    setIsLoading(true);
    setError(null);
    setHasSearched(true);

    try {
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(query)}`
      );
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Search failed");
        setSongs([]);
        return;
      }

      setSongs(data.songs);
    } catch {
      setError("Failed to connect to the server");
      setSongs([]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="main-content">
      <div className="hero">
        <h1 className="hero__title">
          <svg className="hero__icon" width="36" height="36" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <polygon points="10,8 16,12 10,16" />
          </svg>
          YT Music
        </h1>
        <p className="hero__subtitle">Search, play, and download your favorite music</p>
      </div>

      <SearchBar onSearch={handleSearch} isLoading={isLoading} />

      {error && <div className="error-message">{error}</div>}

      {isLoading && (
        <div className="loading">
          <div className="loading__spinner" />
          <p>Searching for music...</p>
        </div>
      )}

      {!isLoading && hasSearched && songs.length === 0 && !error && (
        <div className="empty-state">
          <p>No results found. Try a different search term.</p>
        </div>
      )}

      {songs.length > 0 && (
        <div className="songs-grid">
          {songs.map((song) => (
            <SongCard key={song.videoId} song={song} queue={songs} />
          ))}
        </div>
      )}
    </main>
  );
}
