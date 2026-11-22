import { describe, expect, it } from 'vitest';
import { tidy } from '../web/src/components/ContextMenu';

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
