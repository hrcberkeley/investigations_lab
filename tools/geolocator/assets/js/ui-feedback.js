(function() {
  let region;

  function getRegion() {
    if (region && region.isConnected) return region;
    region = document.getElementById('toastRegion');
    if (!region) {
      region = document.createElement('div');
      region.id = 'toastRegion';
      region.className = 'toast-region';
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'false');
      document.body.appendChild(region);
    }
    return region;
  }

  function showToast(message, options = {}) {
    const toast = document.createElement('div');
    const type = options.type || 'info';
    toast.className = `toast toast--${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const text = document.createElement('span');
    text.className = 'toast__message';
    text.textContent = String(message || '');
    toast.appendChild(text);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast__close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';
    toast.appendChild(close);

    const dismiss = () => {
      toast.classList.add('toast--leaving');
      setTimeout(() => toast.remove(), 180);
    };
    close.addEventListener('click', dismiss);
    getRegion().appendChild(toast);

    const duration = Number.isFinite(options.duration) ? options.duration : 5000;
    if (duration > 0) setTimeout(dismiss, duration);
    return toast;
  }

  window.showToast = showToast;
})();
