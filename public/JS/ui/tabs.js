/**
 * public/js/ui/tabs.js
 * Accessible Segmented Tabs controller for OnMyWay (OMW).
 */

(function () {
  document.addEventListener('click', (e) => {
    const tabTrigger = e.target.closest('[data-tab-target]');
    if (!tabTrigger) return;

    const container = tabTrigger.closest('.data-tabs-container');
    if (!container) return;

    const targetId = tabTrigger.getAttribute('data-tab-target');

    // Update triggers
    container.querySelectorAll('[data-tab-target]').forEach((btn) => {
      const isTarget = btn === tabTrigger;
      btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
      if (isTarget) {
        btn.classList.add('bg-background', 'text-foreground', 'shadow-subtle');
        btn.classList.remove('hover:text-foreground');
      } else {
        btn.classList.remove('bg-background', 'text-foreground', 'shadow-subtle');
        btn.classList.add('hover:text-foreground');
      }
    });

    // Update panels
    container.querySelectorAll('[data-tab-panel]').forEach((panel) => {
      const panelId = panel.getAttribute('data-tab-panel');
      if (panelId === targetId) {
        panel.classList.remove('hidden');
      } else {
        panel.classList.add('hidden');
      }
    });
  });
})();
