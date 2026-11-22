import { describe, expect, it } from 'vitest';
import { actionLabel, keyboardSpot, onRects, tidy } from '../web/src/components/ContextMenu';

const a = { label: 'A' };
const b = { label: 'B' };

describe('context menu items', () => {
  it('drops what a condition left out', () => {
    expect(tidy([a, false, null, undefined, 0, '', b])).toEqual([a, b]);
  });

  it('keeps separators only between actions', () => {
    expect(tidy(['sep', a, 'sep', 'sep', b, 'sep'])).toEqual([a, 'sep', b]);
    // A separator left on its own once its neighbours are gone.
    expect(tidy([a, 'sep', false, 'sep'])).toEqual([a]);
  });

  it('is empty when there is nothing to do, so no menu opens', () => {
    expect(tidy(['sep', false, 'sep'])).toEqual([]);
  });
});

describe('right-clicking on selected text', () => {
  // Two lines of a selection.
  const lines = [
    { left: 100, right: 300, top: 50, bottom: 70 },
    { left: 20, right: 140, top: 70, bottom: 90 },
  ];

  it('counts a click on any line of it', () => {
    expect(onRects(200, 60, lines)).toBe(true);
    expect(onRects(30, 85, lines)).toBe(true);
    // The edge, give or take a pixel.
    expect(onRects(300.5, 60, lines)).toBe(true);
  });

  it('does not count a click beside it, even inside the box around both lines', () => {
    expect(onRects(50, 60, lines)).toBe(false);
    expect(onRects(250, 85, lines)).toBe(false);
    expect(onRects(200, 120, lines)).toBe(false);
  });

  it('does not count anything when nothing is selected', () => {
    expect(onRects(10, 10, [])).toBe(false);
  });
});

describe('a menu opened from the keyboard', () => {
  it('opens under the focused thing', () => {
    expect(keyboardSpot({ left: 40, top: 100, bottom: 130 }, 800)).toEqual({ x: 40, y: 130 });
  });

  it('opens at the top of something big or whose bottom is off screen, like the page itself', () => {
    expect(keyboardSpot({ left: 0, top: 0, bottom: 2400 }, 800)).toEqual({ x: 0, y: 0 });
    // The app's root, exactly the window's height.
    expect(keyboardSpot({ left: 0, top: 0, bottom: 800 }, 800)).toEqual({ x: 0, y: 0 });
    expect(keyboardSpot({ left: 300, top: 100, bottom: 700 }, 800)).toEqual({ x: 300, y: 100 });
    // Scrolled: its top is above the window, so the window's top.
    expect(keyboardSpot({ left: -10, top: -300, bottom: 2100 }, 800)).toEqual({ x: 0, y: 0 });
    expect(keyboardSpot({ left: 60, top: 500, bottom: 1200 }, 800)).toEqual({ x: 60, y: 500 });
  });
});

describe('a panel’s header buttons as menu items', () => {
  it('reads like a menu item, without the keyboard hint', () => {
    expect(actionLabel('Previous (←)')).toBe('Previous');
    expect(actionLabel('Close focus view (Esc)')).toBe('Close focus view');
    expect(actionLabel('  Add\n   package ')).toBe('Add package');
    expect(actionLabel('Check links')).toBe('Check links');
  });
});
