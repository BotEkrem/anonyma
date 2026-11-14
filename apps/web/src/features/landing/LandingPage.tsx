import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getPublicConfig } from '../../api/client';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import { usePageTheme } from '../../lib/usePageTheme';

import { decryptedText, grainient } from '../../ui/pieces';
import Magnet from '../../ui/reactbits/Magnet';
import { GLOW_COLORS, LensPattern, MORPH_MS } from './LensPattern';
import { LensTimer } from './LensTimer';

// The landing is the entry page: start loading its effects with the app.
if (typeof window !== 'undefined') {
  void decryptedText.preload();
  void grainient.preload();
}

export function LandingPage() {
  useDocumentTitle('Anonyma');
  const [ttlMinutes, setTtlMinutes] = useState(12);
  const theme = usePageTheme();
  /** Rounds of the lens clock: each new one gives the lens a new pattern. */
  const [turn, setTurn] = useState(0);
  /** A round of the lens clock is over: move the lens to a new pattern, and
   *  let the clock come back once it has settled. */
  const nextPattern = () => {
    setTurn((t) => t + 1);
    return new Promise<void>((resolve) => window.setTimeout(resolve, MORPH_MS + 80));
  };

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
      {/* A faint glow across the background, and the lens in front of it. */}
      <div className="hero-glow is-wash" aria-hidden="true">
        <grainient.Piece
          fallback={null}
          colors={GLOW_COLORS}
          lightMode={theme === 'light'}
          grainAmount={0}
          silk={0.15}
          speed={0.6}
          angle={140}
          interactive={false}
          clickSwirl={false}
        />
      </div>
      <div className="hero-glow is-orb" aria-hidden="true">
        <div className="lens-well">
          <LensPattern turn={turn} light={theme === 'light'} />
          <LensTimer onRoundEnd={nextPattern} />
        </div>
      </div>
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
        {/* React Bits Magnet: the two ways in lean towards the pointer. */}
        <div className="cta-row">
          <Magnet padding={56} magnetStrength={5} maxOffset={8}>
            <Link className="btn btn-primary" to="/lobby">
              Enter a room
            </Link>
          </Magnet>
          <Magnet padding={56} magnetStrength={5} maxOffset={8}>
            <Link className="btn btn-ghost" to="/match">
              Random match
            </Link>
          </Magnet>
        </div>
      </div>
    </section>
  );
}
