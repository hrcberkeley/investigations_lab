/**
 * In-app notifications (Session 8): toast + confirm dialog.
 *
 * Drop-in replacements for `alert()` / `confirm()` that match the app's styling
 * and theme (light/dark via CSS tokens). `toast()` is fire-and-forget;
 * `confirmDialog()` returns a Promise<boolean>.
 */

function ensureToastHost() {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

const TOAST_ICONS = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '⛔' };

export function toast(message, { type = 'info', duration } = {}) {
  const host = ensureToastHost();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon" aria-hidden="true">${TOAST_ICONS[type] || TOAST_ICONS.info}</span><span class="toast-msg"></span><button class="toast-close" aria-label="Dismiss">×</button>`;
  el.querySelector('.toast-msg').textContent = String(message);

  const remove = () => {
    el.classList.add('toast-leaving');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.toast-close').addEventListener('click', remove);
  host.appendChild(el);
  // Errors/warnings linger longer than info/success.
  const ms = duration ?? (type === 'error' || type === 'warning' ? 7000 : 4000);
  setTimeout(remove, ms);
  return el;
}

/**
 * Promise-based confirmation dialog.
 * @returns {Promise<boolean>} resolves true on confirm, false on cancel/escape/backdrop.
 */
export function confirmDialog(message, {
  title = 'Please confirm',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.innerHTML = `
      <div class="dialog-card" role="document">
        <div class="dialog-title"></div>
        <div class="dialog-message"></div>
        <div class="dialog-actions">
          <button class="dialog-btn dialog-cancel"></button>
          <button class="dialog-btn dialog-confirm${danger ? ' danger' : ''}"></button>
        </div>
      </div>`;
    backdrop.querySelector('.dialog-title').textContent = title;
    backdrop.querySelector('.dialog-message').textContent = message;
    const cancelBtn = backdrop.querySelector('.dialog-cancel');
    const confirmBtn = backdrop.querySelector('.dialog-confirm');
    cancelBtn.textContent = cancelLabel;
    confirmBtn.textContent = confirmLabel;

    const close = (result) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') close(true);
    };
    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
    document.addEventListener('keydown', onKey);

    document.body.appendChild(backdrop);
    confirmBtn.focus();
  });
}
