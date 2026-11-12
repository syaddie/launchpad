import { describe, expect, it } from 'vitest';
import { findDay, parseDue, parseDueWord, parseEvent } from '../shared/dates';

// Thu 12 Nov 2026, 10:00.
const now = new Date(2026, 10, 12, 10, 0);
const at = (h: number, m = 0) => h * 60 + m;

describe('parseEvent', () => {
  it('reads a weekday and a time, an hour long', () => {
    expect(parseEvent('lunch w/ Dan fri 1pm', now)).toEqual({ title: 'lunch w/ Dan', date: '2026-11-13', allDay: false, start: at(13), end: at(14), understood: true });
  });
  it('reads a written date and a range sharing one pm', () => {
    expect(parseEvent('dentist 14 nov 3:30-4:30pm', now)).toMatchObject({ title: 'dentist', date: '2026-11-14', start: at(15, 30), end: at(16, 30) });
    expect(parseEvent('workshop 11-1pm tmr', now)).toMatchObject({ title: 'workshop', date: '2026-11-13', start: at(11), end: at(13) });
    expect(parseEvent('call 9am to 9:30am', now)).toMatchObject({ title: 'call', start: at(9), end: at(9, 30) });
  });
  it('reads all day', () => {
    expect(parseEvent('flight to KL sat all day', now)).toMatchObject({ title: 'flight to KL', date: '2026-11-14', allDay: true, start: 0, end: 1440 });
  });
  it('makes a day without a time all day', () => {
    expect(parseEvent('mum’s birthday 3 dec', now)).toMatchObject({ title: 'mum’s birthday', date: '2026-12-03', allDay: true });
  });
  it('puts a time without a day today, or tomorrow once it has passed', () => {
    expect(parseEvent('standup 3pm', now)).toMatchObject({ date: '2026-11-12', start: at(15) });
    expect(parseEvent('standup 9am', now)).toMatchObject({ date: '2026-11-13', start: at(9) });
  });
  it('takes a duration, a bare "at 3" and 24-hour times', () => {
    expect(parseEvent('gym tmr 7am for 90 min', now)).toMatchObject({ title: 'gym', start: at(7), end: at(8, 30) });
    expect(parseEvent('coffee at 3 mon', now)).toMatchObject({ title: 'coffee', date: '2026-11-16', start: at(15) });
    expect(parseEvent('review 14:30 for 2h on 20/11', now)).toMatchObject({ title: 'review', date: '2026-11-20', start: at(14, 30), end: at(16, 30) });
    expect(parseEvent('dinner fri noon', now)).toMatchObject({ title: 'dinner', start: at(12) });
  });
  it('runs past midnight', () => {
    expect(parseEvent('gig sat 10pm-1am', now)).toMatchObject({ title: 'gig', start: at(22), end: at(25) });
  });
  it('leaves numbers that aren’t times alone', () => {
    expect(parseEvent('read chapters 3-4', now)).toMatchObject({ title: 'read chapters 3-4', allDay: true, understood: false });
  });
  it('rolls a date that has passed to next year', () => {
    expect(parseEvent('trip 5 jan', now).date).toBe('2027-01-05');
  });
});

describe('due dates', () => {
  it('reads written dates on a new task', () => {
    expect(parseDue('pay rent 1 dec', now)).toEqual({ title: 'pay rent', due: '2026-12-01' });
    expect(parseDue('renew passport by 20/11', now)).toEqual({ title: 'renew passport', due: '2026-11-20' });
    expect(parseDue('call bank in 3 days', now)).toEqual({ title: 'call bank', due: '2026-11-15' });
  });
  it('reads a due date typed on its own, or clears it', () => {
    expect(parseDueWord('fri', now)).toBe('2026-11-13');
    expect(parseDueWord('next fri', now)).toBe('2026-11-20');
    expect(parseDueWord('none', now)).toBe('');
    expect(parseDueWord('', now)).toBe('');
    expect(parseDueWord('whenever', now)).toBeUndefined();
  });
  it('finds a deadline in the digest’s words', () => {
    expect(findDay('by Fri 13 Nov', now)).toBe('2026-11-13');
    expect(findDay('pay before 20/11/2026', now)).toBe('2026-11-20');
    expect(findDay('reply by tomorrow', now)).toBe('2026-11-13');
    // A deadline just missed stays this year.
    expect(findDay('was due 31 Oct', now)).toBe('2026-10-31');
    expect(findDay('', now)).toBeNull();
    expect(findDay('no rush', now)).toBeNull();
  });
});
