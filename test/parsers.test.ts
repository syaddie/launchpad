import { describe, expect, it } from 'vitest';
import { detectCarrier } from '../shared/carriers';
import { parseDue } from '../shared/dates';
import { extractTrackingNumbers, labelFor } from '../server/src/gmail-parse';
import { classify, parseSingpost, summarise } from '../server/src/tracking';

const tue = new Date(2026, 9, 27); // Tue 27 Oct 2026

describe('parseDue', () => {
  it('splits a trailing weekday into the next occurrence', () => {
    expect(parseDue('call bank fri', tue)).toEqual({ title: 'call bank', due: '2026-10-30' });
  });
  it('never resolves a weekday to today', () => {
    expect(parseDue('standup tue', tue).due).toBe('2026-11-03');
  });
  it('handles today, tomorrow and next week', () => {
    expect(parseDue('a tod', tue).due).toBe('2026-10-27');
    expect(parseDue('a tmrw', tue).due).toBe('2026-10-28');
    expect(parseDue('a next week', tue).due).toBe('2026-11-02');
  });
  it('leaves other text alone', () => {
    expect(parseDue('buy coffee', tue)).toEqual({ title: 'buy coffee' });
  });
});

describe('detectCarrier', () => {
  it.each([
    ['SPNSV000000518244', 'SingPost'],
    ['RR123456789SG', 'SingPost'],
    ['NVSGSHOPE0001234567', 'Ninja Van'],
    ['JT0001234567SG', 'J&T Express'],
    ['1Z999AA10123456784', 'UPS'],
    ['1234567890', 'DHL'],
    ['123456789012', 'FedEx'],
    ['hello', ''],
  ])('%s → %s', (n, c) => expect(detectCarrier(n)).toBe(c));
});

describe('extractTrackingNumbers', () => {
  it('finds distinctive numbers anywhere', () => {
    const r = extractTrackingNumbers('Your parcel SPNSV000000518244 is on the way. Order #348438.');
    expect(r).toEqual([{ number: 'SPNSV000000518244', carrier: 'SingPost' }]);
  });
  it('only takes bare digits after a tracking keyword', () => {
    expect(extractTrackingNumbers('Call us at 6123456789 today')).toEqual([]);
    expect(extractTrackingNumbers('Tracking number: 1234567890', 'DHL <noreply@dhl.com>')).toEqual([{ number: '1234567890', carrier: 'DHL' }]);
  });
  it('ignores words that only look like prefixes', () => {
    expect(extractTrackingNumbers('SPECIAL OFFER for NVIDIA fans')).toEqual([]);
  });
});

describe('labelFor', () => {
  it('uses the sender name and subject', () => {
    expect(labelFor('Shopee <info@mail.shopee.sg>', 'Your order has shipped')).toBe('Shopee: Your order has shipped');
  });
});

describe('tracking status', () => {
  it('classifies common event wording', () => {
    expect(classify('Out for delivery')).toEqual({ stage: 2, exception: false });
    expect(classify('Item delivered')).toEqual({ stage: 3, exception: false });
    expect(classify('Delivery attempted, no one home')).toEqual({ stage: 2, exception: true });
    expect(classify('SingPost has received your order information, but not your item yet')).toEqual({ stage: 0, exception: false });
  });
  it('never moves the bar backwards on a late generic scan', () => {
    const r = summarise([
      { at: '2026-10-27T05:00:00Z', location: '', event: 'Processed at facility' },
      { at: '2026-10-27T04:00:00Z', location: '', event: 'Out for delivery' },
    ]);
    expect(r.stage).toBe(2);
  });
  it('parses a SingPost API response', () => {
    const r = parseSingpost({
      ok: true,
      items: [{ trackingNumberFound: 'true', events: [
        { statusDescription: 'Item delivered', date: '2026-10-28T14:05:00', location: 'TAMPINES', eventDescription: 'DLC' },
        { statusDescription: 'SingPost has received your order information, but not your item yet', date: '2026-10-27T10:16:07', location: 'SPEEDPOST SERVICE CENTRE', aceStatusCode: 'IR' },
      ] }],
    })!;
    expect(r.stage).toBe(3);
    expect(r.deliveredAt).toBe('2026-10-28T06:05:00.000Z');
    expect(r.timeline[0].location).toBe('Tampines');
  });
});
