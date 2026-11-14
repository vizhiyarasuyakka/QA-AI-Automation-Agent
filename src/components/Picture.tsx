/**
 * A screenshot that opens at full size in a new tab. Rendered on the server (no script per picture: the UI Testing
 * page can hold thousands) and loaded by the browser as it nears the screen; the close-ups are pre-rendered on the
 * server (src/lib/prerender.ts), so they come straight from memory. Until it arrives, a quiet placeholder keeps its place.
 */
export function Picture({ href, alt, small = false }: { href: string; alt: string; small?: boolean }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={href} alt={alt} loading="lazy" decoding="async" className={`pic${small ? " pic-small" : ""}`} />
    </a>
  );
}
