'use client';

/** Any render error: a generic message, never the error's text (it can quote data). */
export default function ErrorPage() {
  return (
    <main className="page">
      <h1 className="title">Canvas Monitor</h1>
      <p className="card">Something went wrong. Try again shortly.</p>
    </main>
  );
}
