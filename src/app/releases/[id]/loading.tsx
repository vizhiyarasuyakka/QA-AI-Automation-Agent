/**
 * Shown the moment a release page is opened, while the server prepares it, so a click never looks like nothing
 * happened. Shaped like the page: the side bar of steps, a title and a few cards.
 */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading">
      <nav className="rail" aria-hidden="true">
        <div className="sk sk-line" style={{ width: "60%", height: 12 }} />
        <div className="sk sk-line" style={{ width: "80%", height: 16, marginBottom: "1rem" }} />
        {Array.from({ length: 10 }, (_, i) => <div key={i} className="sk sk-line" style={{ width: `${70 + ((i * 7) % 25)}%`, height: 28 }} />)}
      </nav>
      <div className="sk sk-line" style={{ width: "40%", height: 28, marginBottom: ".6rem" }} />
      <div className="sk sk-line" style={{ width: "70%", height: 14, marginBottom: "1.4rem" }} />
      <div className="grid-2">
        <div className="sk sk-card" />
        <div className="sk sk-card" />
      </div>
      <div className="sk sk-card" style={{ height: 220, marginTop: "1rem" }} />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
