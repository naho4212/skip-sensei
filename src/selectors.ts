/**
 * SINGLE source of truth for every YouTube DOM selector the extension touches.
 * When YouTube ships a UI change, this is the one file to update.
 */

export const PLAYER = '#movie_player'
export const VIDEO = `${PLAYER} video.html5-main-video`

/** Classes on #movie_player that indicate an ad is playing. */
export const AD_SHOWING_CLASSES = ['ad-showing', 'ad-interrupting']

/** Skip buttons, old and new player UIs. Order = preference. */
export const SKIP_BUTTONS = [
  '.ytp-ad-skip-button-modern',
  '.ytp-ad-skip-button',
  '.ytp-skip-ad-button',
]

/** Overlay / banner ad elements that can simply be removed from the DOM. */
export const OVERLAY_ADS = [
  '.ytp-ad-overlay-slot',
  '.ytp-ad-overlay-container',
  '.ytp-ad-image-overlay',
  '.ytp-ad-text-overlay',
]

/** Close buttons for overlay ads (clicked before falling back to removal). */
export const OVERLAY_CLOSE_BUTTONS = [
  '.ytp-ad-overlay-close-button',
  '.ytp-ad-overlay-close-container',
]

/** Pause-screen ("Continue watching?" / promoted content) ad surfaces. */
export const PAUSE_OVERLAY_ADS = ['.ytp-pause-overlay-container']

/** Badge shown while an ad plays — secondary ad-detection signal. */
export const AD_BADGES = [
  '.ytp-ad-simple-ad-badge',
  '.ytp-ad-badge',
  '.ytp-ad-player-overlay-layout',
]
