/**
 * public/js/ui/toast.js
 * Accessible Sonner-style toast system for OnMyWay (OMW).
 * Strict security: Renders all content safely with textContent only.
 */

(function () {
  const TOAST_CONTAINER_ID = 'omw-toast-viewport';
  const TOAST_TEMPLATE_ID = 'omw-toast-template';

  function getViewport() {
    let viewport = document.getElementById(TOAST_CONTAINER_ID);
    if (!viewport) {
      viewport = document.createElement('div');
      viewport.id = TOAST_CONTAINER_ID;
      viewport.role = 'region';
      viewport.setAttribute('aria-label', 'Notifications');
      viewport.setAttribute('aria-live', 'polite');
      viewport.className = 'fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col-reverse p-4 sm:bottom-0 sm:right-0 sm:top-auto sm:flex-col sm:max-w-[420px] pointer-events-none gap-2';
      document.body.appendChild(viewport);
    }
    return viewport;
  }

  /**
   * Display a new toast notification
   * @param {Object} options
   * @param {string} options.title - Notification title
   * @param {string} [options.description] - Notification description
   * @param {"default"|"destructive"|"success"} [options.variant="default"]
   * @param {number} [options.duration=4000] - Duration in ms
   */
  function toast({ title, description = '', variant = 'default', duration = 4000 }) {
    const viewport = getViewport();
    const template = document.getElementById(TOAST_TEMPLATE_ID);

    let toastEl;
    if (template && template.content) {
      toastEl = template.content.firstElementChild.cloneNode(true);
    } else {
      toastEl = document.createElement('div');
      toastEl.className = 'pointer-events-auto relative flex w-full items-center justify-between space-x-2 overflow-hidden rounded-md border border-border bg-card p-4 pr-6 shadow-popover transition-all duration-150';
      toastEl.innerHTML = `
        <div class="flex items-start gap-3 w-full">
          <div data-toast-icon class="mt-0.5 shrink-0 text-foreground"></div>
          <div class="grid gap-1">
            <div data-toast-title class="text-sm font-semibold text-foreground"></div>
            <div data-toast-description class="text-xs text-muted-foreground leading-relaxed"></div>
          </div>
        </div>
        <button type="button" data-toast-close class="absolute right-1 top-1 rounded-md p-1 text-foreground/50 hover:text-foreground">✕</button>
      `;
    }

    // Set variant styling
    if (variant === 'destructive') {
      toastEl.classList.add('border-destructive/50', 'text-destructive');
    }

    // Populate safely with textContent ONLY
    const titleEl = toastEl.querySelector('[data-toast-title]');
    if (titleEl) titleEl.textContent = title || '';

    const descEl = toastEl.querySelector('[data-toast-description]');
    if (descEl) descEl.textContent = description || '';

    const iconEl = toastEl.querySelector('[data-toast-icon]');
    if (iconEl) {
      const iconName = variant === 'destructive' ? 'alert-triangle' : (variant === 'success' ? 'check' : 'info');
      iconEl.innerHTML = `<svg class="lucide lucide-sm" aria-hidden="true"><use href="/icons/sprite.svg#${iconName}"></use></svg>`;
    }

    // Close button
    const closeBtn = toastEl.querySelector('[data-toast-close]');
    const dismiss = () => {
      toastEl.dataset.state = 'closed';
      toastEl.classList.add('opacity-0', 'translate-x-full');
      setTimeout(() => {
        if (toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      }, 150);
    };

    if (closeBtn) {
      closeBtn.addEventListener('click', dismiss);
    }

    toastEl.dataset.state = 'open';
    viewport.appendChild(toastEl);

    if (duration > 0) {
      setTimeout(dismiss, duration);
    }

    return { dismiss };
  }

  window.toast = toast;
})();
