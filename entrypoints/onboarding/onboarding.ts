import { getSettings, updateSettings } from '../../src/storage'

document.getElementById('open-options')?.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

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
