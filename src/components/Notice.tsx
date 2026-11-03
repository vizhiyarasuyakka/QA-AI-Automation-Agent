export function Notice({ searchParams }: { searchParams: { ok?: string; err?: string; info?: string } }) {
  if (searchParams.err) return <div className="notice bad">{searchParams.err}</div>;
  if (searchParams.ok) return <div className="notice ok">{searchParams.ok}</div>;
  if (searchParams.info) return <div className="notice info">{searchParams.info}</div>;
  return null;
}
