import { Link } from "react-router-dom";

export function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="font-mono text-[40px] font-semibold text-accent">404</div>
      <p className="mt-2 text-[13px] text-muted">This page drifted off the glacier.</p>
      <Link to="/" className="mt-4 text-[13px] text-accent hover:underline">← Back to overview</Link>
    </div>
  );
}
