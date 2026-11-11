import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getPublicConfig } from '../../api/client';
import { useDocumentTitle } from '../../lib/useDocumentTitle';

import { decryptedText } from '../../ui/pieces';

// The landing is the entry page: start loading its headline effect with the app.
if (typeof window !== 'undefined') void decryptedText.preload();

export function LandingPage() {
  useDocumentTitle('Anonyma');
  const [ttlMinutes, setTtlMinutes] = useState(10);

  useEffect(() => {
    void getPublicConfig()
      .then((cfg) => setTtlMinutes(Math.max(1, Math.round(cfg.messageTtlSeconds / 60))))
      .catch(() => {
        /* keep default */
      });
  }, []);

  const headline = `Words that vanish in ${ttlMinutes} minutes.`;

  return (
    <section className="hero">
      <div className="hero-copy">
        <p className="brand-hero">Anonyma</p>
        <h1>
          <decryptedText.Piece
            fallback={<span className="hero-wait">{headline}</span>}
            key={ttlMinutes}
            text={headline}
            animateOn="view"
            sequential
            speed={38}
            characters="ABCDEFGHIJKLMNOPQRSTUVWXYZ#%&*+=?"
            encryptedClassName="hero-scramble"
          />
        </h1>
        <p>Anonymous text, voice, or video matches. Encrypted at rest. No accounts. No archives.</p>
        <div className="cta-row">
          <Link className="btn btn-primary" to="/lobby">
            Enter a room
          </Link>
          <Link className="btn btn-ghost" to="/match">
            Random match
          </Link>
        </div>
      </div>
    </section>
  );
}
