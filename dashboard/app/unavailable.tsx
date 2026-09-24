/** Shown when the read model cannot be read. Says nothing about why: an error's text stays out of pages and logs. */
export function Unavailable() {
  return (
    <main className="page">
      <h1 className="title">Canvas Monitor</h1>
      <p className="card">The dashboard's data is unavailable right now. The monitor itself is unaffected; try again shortly.</p>
    </main>
  );
}
