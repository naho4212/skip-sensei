document.getElementById('open-options')?.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

document.getElementById('close')?.addEventListener('click', () => {
  window.close()
})
