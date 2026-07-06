import React from 'react';

export default function FinishedOverlay({ game, send }) {
  const winnerNames = game.winners
    .map((id) => game.players.find((p) => p.id === id)?.name)
    .filter(Boolean)
    .join(' & ');
  const isAdmin = game.you === game.adminId;
  const youWon = game.winners.includes(game.you);

  return (
    <div className="overlay">
      <div className="overlay-card">
        <div className="overlay-trophy">{youWon ? '🏆' : '🃏'}</div>
        <h2>{winnerNames} gewinnt!</h2>
        {game.mode === 'quartett' && (
          <p className="hint">
            {game.players
              .map((p) => `${p.name}: ${p.quartets.length} Quartett(e)`)
              .join(' · ')}
          </p>
        )}
        {isAdmin ? (
          <button className="primary" onClick={() => send({ type: 'restart' })}>
            Nochmal (zurück zur Lobby)
          </button>
        ) : (
          <p className="hint">Warte, bis der Admin eine neue Runde startet …</p>
        )}
      </div>
    </div>
  );
}
