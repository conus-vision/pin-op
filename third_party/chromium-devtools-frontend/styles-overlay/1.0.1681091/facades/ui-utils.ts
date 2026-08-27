export * from '../../../patches/1.0.1681091/facades/ui-utils.js';

interface TextButtonOptions {
  readonly className?: string;
  readonly jslogContext?: string;
}

export function createTextButton(
    text: string, handler: (event: Event) => void, opts?: TextButtonOptions): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = ['text-button', opts?.className].filter(Boolean).join(' ');
  button.type = 'button';
  button.textContent = text;
  if (opts?.jslogContext) button.dataset.jslogContext = opts.jslogContext;
  button.addEventListener('click', handler);
  button.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') event.stopImmediatePropagation();
  });
  return button;
}
