/**
 * public/js/ui/sheet.js
 * Accessible Slide-over Sheet / Bottom Drawer controller for OnMyWay (OMW).
 */

(function () {
  function openSheet(sheetId) {
    const sheet = document.getElementById(sheetId);
    if (!sheet) return;
    sheet.classList.remove('hidden');
    sheet.dataset.state = 'open';
    document.body.classList.add('overflow-hidden');
  }

  function closeSheet(sheetId) {
    const sheet = document.getElementById(sheetId);
    if (!sheet) return;
    sheet.dataset.state = 'closed';
    sheet.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
  }

  document.addEventListener('click', (e) => {
    // Open trigger: [data-sheet-open="id"]
    const openTrigger = e.target.closest('[data-sheet-open]');
    if (openTrigger) {
      e.preventDefault();
      const targetId = openTrigger.getAttribute('data-sheet-open');
      openSheet(targetId);
      return;
    }

    // Close trigger: [data-sheet-close="id"]
    const closeTrigger = e.target.closest('[data-sheet-close]');
    if (closeTrigger) {
      e.preventDefault();
      const targetId = closeTrigger.getAttribute('data-sheet-close');
      closeSheet(targetId);
      return;
    }

    // Backdrop click
    if (e.target.matches('[data-state="open"]')) {
      closeSheet(e.target.id);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const openSheetEl = document.querySelector('[data-state="open"]');
      if (openSheetEl && openSheetEl.id.startsWith('sheet_')) {
        closeSheet(openSheetEl.id);
      }
    }
  });

  window.sheet = { open: openSheet, close: closeSheet };
})();
