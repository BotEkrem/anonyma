import { lazyPiece } from './lazyPiece';

/**
 * React Bits pieces that need the animation library: each loads on its own and
 * renders directly once loaded (see lazyPiece). Pages call `preload` when they
 * open so the piece is usually ready before it is needed.
 */
export const decryptedText = lazyPiece(() => import('./reactbits/DecryptedText'));
export const codeSlots = lazyPiece(() => import('./reactbits/CodeSlots'));
export const squishSwitch = lazyPiece(() => import('./reactbits/SquishSwitch'));
export const statusMark = lazyPiece(() => import('./reactbits/StatusMark'));
export const wakeSlider = lazyPiece(() => import('./reactbits/WakeSlider'));
