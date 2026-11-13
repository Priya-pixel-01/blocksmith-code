import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <>
      <div className="page-header">
        <div className="page-header__eyebrow">404</div>
        <h1>Page not found</h1>
        <p className="page-header__subtitle">There's nothing at this address.</p>
      </div>
      <div className="empty-state">
        <Link to="/">← Back to Workspace</Link>
      </div>
    </>
  );
}
