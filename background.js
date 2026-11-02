// Clicking the toolbar icon opens the side panel. All agent logic lives in
// sidepanel.js (a normal page context, so it is not killed by service-worker idle timeouts).
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});
