import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

/** Unknown addresses used to show the landing page with the wrong URL kept. */
export function NotFoundPage() {
  useDocumentTitle('Not found · Anonyma');
  return (
    <main className="panel join-gate">
      <h1>Page not found</h1>
      <p className="muted join-gate-lead">There is nothing at this address.</p>
      <div className="cta-row">
        <Link className="btn btn-primary" to="/lobby">
          Go to rooms
        </Link>
        <Link className="btn btn-ghost" to="/">
          Home
        </Link>
      </div>
    </main>
  );
}
