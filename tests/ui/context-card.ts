/**
 * The map's context card (LEV-369) as the jsdom tests drive it: a `contextmenu` at a target opens it (the view's own
 * element in `.mappy-view`, not Obsidian's `Menu`), its rows are read and chosen by title, its colour circles by name.
 */

/** The card on the page, if one is open. */
export function contextCard(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.mappy-context-card');
}

/** A right-click at `target` (at the given client point): the card it opened. */
export function openContextCard(target: EventTarget, clientX = 100, clientY = 100): HTMLElement {
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX, clientY }));
  const card = contextCard();
  if (!card) throw new Error('The right-click opened no context card');
  return card;
}

/** The card's rows other than the colours, in order. */
export function cardRows(card = contextCard()): HTMLButtonElement[] {
  return Array.from(card?.querySelectorAll<HTMLButtonElement>('.mappy-popover-item') ?? []);
}

/** The titles of the card's rows other than the colours, in order. */
export function cardTitles(card = contextCard()): string[] {
  return cardRows(card).map(row => row.querySelector('.mappy-popover-title')?.textContent ?? '');
}

/** The card's colour circles: their names in order, and the checked one(s). */
export function cardSwatches(card = contextCard()): { labels: string[]; checked: string[] } {
  const circles = Array.from(card?.querySelectorAll<HTMLButtonElement>('.mappy-swatch') ?? []);
  return {
    labels: circles.map(circle => circle.getAttribute('aria-label') ?? ''),
    checked: circles.filter(circle => circle.getAttribute('aria-checked') === 'true').map(circle => circle.getAttribute('aria-label') ?? ''),
  };
}

/** The open card's row titled `title`. */
export function cardRow(title: string): HTMLButtonElement {
  const row = cardRows().find(candidate => candidate.querySelector('.mappy-popover-title')?.textContent === title);
  if (!row) throw new Error(`The context card has no row ${title}`);
  return row;
}

/** The open card's colour circle named `label`. */
export function cardSwatch(label: string): HTMLButtonElement {
  const circle = Array.from(contextCard()?.querySelectorAll<HTMLButtonElement>('.mappy-swatch') ?? []).find(candidate => candidate.getAttribute('aria-label') === label);
  if (!circle) throw new Error(`The context card has no colour ${label}`);
  return circle;
}

/** Right-click at `target`, then choose the row titled `title`. */
export function chooseFromCard(target: EventTarget, title: string): void {
  openContextCard(target);
  cardRow(title).click();
}

/** Escape on the open card, as a person closes it; nothing when none is open. */
export function closeContextCard(): void {
  contextCard()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

/** Right-click at `target`, read the rows' titles and close the card again. */
export function cardTitlesAt(target: EventTarget): string[] {
  const titles = cardTitles(openContextCard(target));
  closeContextCard();
  return titles;
}
