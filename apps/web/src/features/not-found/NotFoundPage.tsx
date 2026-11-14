import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import FuzzyText from '../../ui/reactbits/FuzzyText';

/** Unknown addresses used to show the landing page with the wrong URL kept. */
export function NotFoundPage() {
  useDocumentTitle('Not found · Anonyma');
  return (
    <main className="panel join-gate">
      {/* React Bits Fuzzy Text: the number keeps a faint fuzz and shakes harder
          under the pointer. */}
      <div className="not-found-fuzz">
        <FuzzyText
          fontSize="clamp(4.5rem, 16vw, 8.5rem)"
          fontWeight={600}
          baseIntensity={0.08}
          hoverIntensity={0.32}
          fuzzRange={18}
          intro
        >
          404
        </FuzzyText>
      </div>
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
