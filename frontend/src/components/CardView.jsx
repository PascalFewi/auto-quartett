import React from 'react';
import { formatValue } from '../deck.js';

/**
 * Eine Quartettkarte. Wenn `onPickAttribute` gesetzt ist (Supertrumpf, eigener
 * Zug), werden die Wertzeilen zu Buttons. `highlightKey` hebt das zuletzt
 * verglichene Attribut hervor.
 */
export default function CardView({ deck, card, onPickAttribute, highlightKey, small }) {
  if (!card) return null;
  const label = deck.labelById[card.id];
  const img = deck.imageUrl(card);

  return (
    <div className={`card ${small ? 'card-sm' : ''}`} data-family={card.family}>
      <div className="card-head">
        <span className="card-index">{label}</span>
        <span className="card-family">{deck.familyName(card.family)}</span>
      </div>
      {img && <img className="card-img" src={img} alt={card.name} draggable={false} />}
      <div className="card-name">{card.name}</div>
      <div className="card-stats">
        {deck.attributes.map((attr) => {
          const row = (
            <>
              <span className="stat-label">{attr.label}</span>
              <span className="stat-dots" aria-hidden="true" />
              <span className="stat-value">{formatValue(attr, card.values[attr.key] ?? 0)}</span>
            </>
          );
          return onPickAttribute ? (
            <button
              key={attr.key}
              className={`stat-row clickable ${highlightKey === attr.key ? 'hl' : ''}`}
              onClick={() => onPickAttribute(attr.key)}
              title={attr.higherWins ? 'Höchster Wert gewinnt' : 'Tiefster Wert gewinnt'}
            >
              {row}
              <span className="stat-dir">{attr.higherWins ? '▲' : '▼'}</span>
            </button>
          ) : (
            <div key={attr.key} className={`stat-row ${highlightKey === attr.key ? 'hl' : ''}`}>
              {row}
            </div>
          );
        })}
      </div>
    </div>
  );
}
