import React, { useEffect, useRef } from 'react';

export default function Log({ entries }) {
  const ref = useRef(null);

  // Automatisch ans Ende scrollen, wenn neue Einträge kommen.
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries.length]);

  return (
    <details className="log">
      <summary>Spielverlauf ({entries.length})</summary>
      <div className="log-body" ref={ref}>
        {entries.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </details>
  );
}
