/**
 * public/js/ui/dialog.js
 * Accessible Modal Dialog controller for OnMyWay (OMW).
 */

(function () {
  function openDialog(dialogId) {
    const dlg = document.getElementById(dialogId);
    if (!dlg) return;
    dlg.classList.remove('hidden');
    dlg.dataset.state = 'open';
    document.body.classList.add('overflow-hidden');

    // Focus on first input or close button
    const focusable = dlg.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable.length > 0) {
      focusable[0].focus();
    }
  }

  function closeDialog(dialogId) {
    const dlg = document.getElementById(dialogId);
    if (!dlg) return;
    dlg.dataset.state = 'closed';
    dlg.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
  }

  document.addEventListener('click', (e) => {
    // Open trigger: [data-dialog-open="id"]
    const openTrigger = e.target.closest('[data-dialog-open]');
    if (openTrigger) {
      e.preventDefault();
      const targetId = openTrigger.getAttribute('data-dialog-open');
      openDialog(targetId);
      return;
    }

    // Close trigger: [data-dialog-close="id"]
    const closeTrigger = e.target.closest('[data-dialog-close]');
    if (closeTrigger) {
      e.preventDefault();
      const targetId = closeTrigger.getAttribute('data-dialog-close');
      closeDialog(targetId);
      return;
    }

    // Backdrop click: clicking directly on modal background
    if (e.target.matches('[role="dialog"][data-state="open"]')) {
      closeDialog(e.target.id);
    }
  });

  // ESC key dismisses open dialogs
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const openDlg = document.querySelector('[role="dialog"][data-state="open"]');
      if (openDlg) {
        closeDialog(openDlg.id);
      }
    }
  });

  window.dialog = { open: openDialog, close: closeDialog };
})();
