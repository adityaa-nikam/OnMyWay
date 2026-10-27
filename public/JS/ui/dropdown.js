/**
 * public/js/ui/dropdown.js
 * Minimal accessible Dropdown Menu / Popover controller for OnMyWay (OMW).
 */

(function () {
  function closeAllDropdowns() {
    document.querySelectorAll('[data-dropdown-menu]').forEach((menu) => {
      menu.classList.add('hidden');
    });
  }

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-dropdown-trigger]');
    if (trigger) {
      e.stopPropagation();
      const parent = trigger.closest('[data-dropdown]');
      if (!parent) return;

      const menu = parent.querySelector('[data-dropdown-menu]');
      if (!menu) return;

      const isHidden = menu.classList.contains('hidden');
      closeAllDropdowns();

      if (isHidden) {
        menu.classList.remove('hidden');
      }
      return;
    }

    // Clicking outside closes all dropdowns
    if (!e.target.closest('[data-dropdown-menu]')) {
      closeAllDropdowns();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllDropdowns();
    }
  });

  window.dropdown = { closeAll: closeAllDropdowns };
})();
