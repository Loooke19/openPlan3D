/**
 * Small status/toast helper shared by the preview, maker, and editor.
 * Transient messages fade out after `duration`; sticky ones (instructions, errors)
 * stay until the next message or an explicit clear.
 */
export function createNotifier(element, {duration = 4000} = {}) {
  let hideTimer = 0, clearTimer = 0, token = 0;
  const cancel = () => { clearTimeout(hideTimer); clearTimeout(clearTimer); token += 1; };
  return (text, {sticky = false} = {}) => {
    if (!element) return;
    cancel();
    if (!text) { element.classList.remove('is-visible'); element.textContent = ''; return; }
    element.textContent = text;
    const mine = token;
    // Let `:empty{display:none}` lift before the opacity class lands so the fade-in runs.
    requestAnimationFrame(() => { if (mine === token) element.classList.add('is-visible'); });
    if (sticky) return;
    hideTimer = setTimeout(() => {
      element.classList.remove('is-visible');
      clearTimer = setTimeout(() => { if (!element.classList.contains('is-visible')) element.textContent = ''; }, 220);
    }, duration);
  };
}
