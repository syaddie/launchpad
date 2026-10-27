import { describe, expect, it } from 'vitest';
import { cleanBody, parseInboxMessage, senderEmail, type StoredEmail } from '../server/src/gmail-parse';
import { emailList, inRange, toDigest } from '../server/src/inbox';
import { gmailUrl, inboxBadge } from '../web/src/components/Inbox';
import type { AppState } from '../shared/types';

const mail = (p: Partial<StoredEmail>): StoredEmail => ({
  id: 'm1', threadId: 't1', from: 'Ana', fromEmail: 'ana@example.com', subject: 'Dinner', snippet: 'Are you free?',
  at: '2026-10-27T02:00:00.000Z', unread: false, category: 'primary', body: '', ...p,
});

describe('parseInboxMessage', () => {
  const msg = (labels: string[]) => ({
    id: 'abc', threadId: 'thr', labelIds: labels, internalDate: String(Date.parse('2026-10-26T09:30:00Z')),
    snippet: 'Your bill of $42.10 is due &amp; ready',
    payload: { headers: [{ name: 'From', value: '"DBS Bank" <alerts@DBS.com>' }, { name: 'Subject', value: ' Card statement ' }] },
  });

  it('reads the sender, subject, time, unread and category', () => {
    const e = parseInboxMessage(msg(['INBOX', 'UNREAD', 'CATEGORY_UPDATES']), 'Statement ready.\nView it online');
    expect(e).toMatchObject({
      id: 'abc', threadId: 'thr', from: 'DBS Bank', fromEmail: 'alerts@dbs.com', subject: 'Card statement',
      at: '2026-10-26T09:30:00.000Z', unread: true, category: 'updates', body: 'Statement ready.\nView it online',
    });
    expect(e.snippet).toBe('Your bill of $42.10 is due & ready');
  });

  it('keeps no body for promotions and treats unlabelled mail as primary', () => {
    expect(parseInboxMessage(msg(['CATEGORY_PROMOTIONS']), 'Big sale').body).toBe('');
    expect(parseInboxMessage(msg(['INBOX']), 'Hi').category).toBe('primary');
  });

  it('pulls the address out of a From header', () => {
    expect(senderEmail('Ana <Ana@Example.com>')).toBe('ana@example.com');
    expect(senderEmail('bob@example.com')).toBe('bob@example.com');
  });
});

describe('cleanBody', () => {
  it('drops quoted replies, links and blank runs', () => {
    const text = 'Sure, 7pm works.\n\n\nSee https://maps.app/x there\nOn Mon, 26 Oct 2026 at 10:00, Ana <ana@example.com> wrote:\n> Dinner tomorrow?';
    expect(cleanBody(text)).toBe('Sure, 7pm works.\nSee there');
  });
  it('cuts long bodies', () => {
    expect(cleanBody('x'.repeat(50), 10)).toBe('xxxxxxxxxx…');
  });
});

describe('inbox digest', () => {
  const emails = [mail({ id: 'a' }), mail({ id: 'b', from: 'Shopee', category: 'promotions', unread: true })];

  it('turns Claude’s email numbers into ids and drops items with none', () => {
    const d = toDigest(
      {
        overview: ' One thing needs you. ',
        items: [
          { kind: 'action', headline: 'Reply to Ana', summary: 'She asks about dinner.', due: ' ', emails: [0, 0, 7] },
          { kind: 'fyi', headline: 'Made up', summary: '', due: '', emails: [9] },
        ],
        skimmed: 'Also 1 promotion (Shopee).',
      },
      emails,
      '2026-10-27T03:00:00.000Z',
    );
    expect(d).toEqual({
      overview: 'One thing needs you.',
      items: [{ kind: 'action', headline: 'Reply to Ana', summary: 'She asks about dinner.', due: '', emails: ['a'] }],
      skimmed: 'Also 1 promotion (Shopee).',
      emailCount: 2,
      summarisedAt: '2026-10-27T03:00:00.000Z',
    });
  });

  it('numbers emails for the prompt, with snippets standing in for bodies', () => {
    const list = emailList([mail({ body: 'Free at 7?' }), mail({ id: 'b', from: 'Shopee', fromEmail: 'deals@shopee.sg', category: 'promotions', unread: true, subject: '11.11', snippet: 'Up to 90% off' })]);
    expect(list).toBe(
      '[0] 2026-10-27 02:00 UTC · Ana <ana@example.com> · primary\nSubject: Dinner\nFree at 7?\n\n' +
        '[1] 2026-10-27 02:00 UTC · Shopee <deals@shopee.sg> · promotions · unread\nSubject: 11.11\nUp to 90% off',
    );
  });

  it('keeps each range to its own days', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    const old = [mail({ id: 'new', at: '2026-10-26T12:00:00Z' }), mail({ id: 'mid', at: '2026-10-23T12:00:00Z' }), mail({ id: 'old', at: '2026-10-19T12:00:00Z' })];
    expect(inRange(old, '2d', now).map((e) => e.id)).toEqual(['new']);
    expect(inRange(old, '7d', now).map((e) => e.id)).toEqual(['new', 'mid']);
  });
});

describe('inbox view', () => {
  it('badges actions whose email is still unread', () => {
    const data = {
      inbox: {
        emails: [mail({ id: 'a', unread: true }), mail({ id: 'b' })],
        digests: {
          '2d': {
            overview: '', skimmed: '', emailCount: 2, summarisedAt: '',
            items: [
              { kind: 'action', headline: '', summary: '', due: '', emails: ['a'] },
              { kind: 'action', headline: '', summary: '', due: '', emails: ['b'] },
              { kind: 'update', headline: '', summary: '', due: '', emails: ['a'] },
            ],
          },
          '7d': null,
        },
        fetchedAt: null,
        error: null,
      },
    } as unknown as AppState;
    expect(inboxBadge(data)).toBe(1);
  });

  it('links to the thread in the signed-in account', () => {
    expect(gmailUrl('me@gmail.com', '19a2b')).toBe('https://mail.google.com/mail/u/me%40gmail.com/#all/19a2b');
    expect(gmailUrl(undefined, '19a2b')).toBe('https://mail.google.com/mail/u/0/#all/19a2b');
  });
});
