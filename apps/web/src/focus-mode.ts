/** Keep automatic focus useful without painting keyboard cues after pointer input. */
export function installFocusMode() {
  const root = document.documentElement;
  root.dataset.focusMode = "pointer";
  const pointer = () => {
    root.dataset.focusMode = "pointer";
  };
  const keyboard = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof Element ? event.target : null;
    const editing = target?.closest(
      'textarea, [contenteditable]:not([contenteditable="false"]), input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="color"]):not([type="file"])',
    );
    if (
      event.key === "Tab" ||
      (!editing &&
        [
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Home",
          "End",
          "PageUp",
          "PageDown",
          "Enter",
          " ",
        ].includes(event.key))
    )
      root.dataset.focusMode = "keyboard";
  };
  // Capture runs before dialogs or comboboxes consume navigation keys.
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("keydown", keyboard, true);
  return () => {
    document.removeEventListener("pointerdown", pointer, true);
    document.removeEventListener("keydown", keyboard, true);
  };
}
