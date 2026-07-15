import { getSettings, updateSettings } from '../../src/storage'

document.getElementById('open-options')?.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

// One-click "Block all ads" activation. Mirrors the popup toggle exactly:
// request the all-sites grant on this click gesture, then enable the setting
// either way — declining still gives network (DNR) blocking, the grant adds
// cosmetic hiding + anti-adblock defusal (defuseAntiAdblock defaults on).
const enableBtn = document.getElementById(
  'enable-web-blocking',
) as HTMLButtonElement | null
const enableHint = document.getElementById('enable-hint')

async function renderWebBlocking() {
  if (!enableBtn) return
  const [settings, granted] = await Promise.all([
    getSettings(),
    chrome.permissions
      .contains({ origins: ['*://*/*'] })
      .catch(() => false),
  ])
  if (settings.blockAllAds && granted) {
    enableBtn.disabled = true
    enableBtn.classList.add('enabled')
    enableBtn.textContent = '✓ Blocking ads on every site'
    if (enableHint)
      enableHint.textContent =
        'You can pause any site — or turn this off — from the toolbar popup.'
  }
}
void renderWebBlocking()

enableBtn?.addEventListener('click', async () => {
  const granted = await chrome.permissions
    .request({ origins: ['*://*/*'] })
    .catch(() => false)
  await updateSettings({ blockAllAds: true })
  if (!granted && enableHint) {
    enableHint.textContent =
      'All-sites access was declined, so network-level blocking is on but leftover ad frames can’t be hidden. Tap the button to try again, or grant it later from the popup.'
  }
  void renderWebBlocking()
})

// Aggressive-mode opt-in (no extra permission): the service worker registers
// the MAIN-world pruner the moment the setting flips.
const aggressiveBox = document.getElementById(
  'aggressive-optin',
) as HTMLInputElement | null
if (aggressiveBox) {
  void getSettings().then((settings) => {
    aggressiveBox.checked = settings.aggressivePruning
  })
  aggressiveBox.addEventListener('change', () => {
    void updateSettings({ aggressivePruning: aggressiveBox.checked })
  })
}

document.getElementById('close')?.addEventListener('click', () => {
  window.close()
})

// Crash-report disclosure toggle — mirrors the telemetryEnabled setting so the
// choice made here and the one in options stay in sync.
const telemetryBox = document.getElementById(
  'telemetry-optout',
) as HTMLInputElement | null
if (telemetryBox) {
  void getSettings().then((settings) => {
    telemetryBox.checked = settings.telemetryEnabled
  })
  telemetryBox.addEventListener('change', () => {
    void updateSettings({ telemetryEnabled: telemetryBox.checked })
  })
}
