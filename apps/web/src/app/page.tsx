// Scaffold home page. The real Collective Payroll pages (/, /pool?id=, /docs) land in phase 3 (PRD section 6).
export default function HomePage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">ArcDrip</h1>
      <p className="mt-3 text-muted">
        A shared USDC stream for collectives: one rate, N shares, live runway.
      </p>
    </div>
  );
}
