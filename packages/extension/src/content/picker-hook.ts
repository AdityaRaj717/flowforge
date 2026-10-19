// Runs in the page's MAIN world. When FlowForge arms it (data-ff-picker="armed" on <html>), the
// next file-input click is marked instead of opening the OS dialog, so the content script can set
// the files itself. Disarmed, it changes nothing.
(() => {
  const w = window as unknown as { __ffPickerHook?: boolean };
  if (w.__ffPickerHook) return;
  w.__ffPickerHook = true;
  const root = document.documentElement;
  const catchIt = (input: HTMLInputElement) => {
    if (input.type !== 'file' || root.dataset.ffPicker !== 'armed') return false;
    root.dataset.ffPicker = 'caught';
    input.setAttribute('data-ff-picked', '1');
    if (!input.isConnected) {
      input.style.display = 'none';
      document.body.appendChild(input);
    }
    return true;
  };
  const click = HTMLElement.prototype.click;
  HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
    if (catchIt(this)) return;
    return click.call(this);
  };
  const show = HTMLInputElement.prototype.showPicker;
  if (show) {
    HTMLInputElement.prototype.showPicker = function (this: HTMLInputElement) {
      if (catchIt(this)) return;
      return show.call(this);
    };
  }
})();
