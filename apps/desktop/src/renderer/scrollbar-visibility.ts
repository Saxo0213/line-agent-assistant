const HIDE_DELAY_MS = 800;
const SCROLLING_CLASS = 'is-scrolling';

const timers = new WeakMap<Element, number>();
const pressed = new Set<Element>();
let installed = false;

function scrollTarget(event: Event): Element | null {
  const target = event.target;
  if (target instanceof Element) return target;
  if (target instanceof Document) return target.scrollingElement;
  return null;
}

function clearTimer(element: Element): void {
  const timer = timers.get(element);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(element);
  }
}

function startTimer(element: Element): void {
  clearTimer(element);
  const timer = window.setTimeout(() => {
    timers.delete(element);
    element.classList.remove(SCROLLING_CLASS);
  }, HIDE_DELAY_MS);
  timers.set(element, timer);
}

function onScroll(event: Event): void {
  const element = scrollTarget(event);
  if (!element) return;
  element.classList.add(SCROLLING_CLASS);
  if (pressed.has(element)) {
    clearTimer(element);
    return;
  }
  startTimer(element);
}

function onPointerDown(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  for (let element: Element | null = target; element; element = element.parentElement) {
    if (element.classList.contains(SCROLLING_CLASS)) {
      pressed.add(element);
      clearTimer(element);
    }
  }
}

function onPointerUp(): void {
  for (const element of pressed) startTimer(element);
  pressed.clear();
}

export function install(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerUp, true);
}

export function uninstall(): void {
  if (!installed) return;
  installed = false;
  document.removeEventListener('scroll', onScroll, true);
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('pointerup', onPointerUp, true);
  document.removeEventListener('pointercancel', onPointerUp, true);
  for (const element of document.querySelectorAll(`.${SCROLLING_CLASS}`)) {
    clearTimer(element);
    element.classList.remove(SCROLLING_CLASS);
  }
  pressed.clear();
}
