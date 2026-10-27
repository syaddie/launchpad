import { describe, expect, it } from 'vitest';
import { detectCarrier } from '../shared/carriers';
import { parseDue } from '../shared/dates';
import { extractTrackingNumbers, labelFor } from '../server/src/gmail-parse';
import { parseNewsRss } from '../server/src/news';
import { classify, parseSingpost, summarise } from '../server/src/tracking';
import { sniffImage } from '../server/src/photos';
import { pickWeather } from '../server/src/weather';
import { weatherIcon, weatherLabel } from '../web/src/util';

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

describe('parseNewsRss', () => {
  const item = (title: string, source: string, date: string, id: string) =>
    `<item><title>${title} - ${source}</title><link>https://news.google.com/rss/articles/${id}?oc=5</link><pubDate>${date}</pubDate><source url="https://x.example">${source}</source></item>`;
  const feed = `<?xml version="1.0"?><rss><channel><title>"K-pop" - Google News</title>
    ${item('Older story &amp; more', 'Soompi', 'Mon, 26 Oct 2026 10:00:00 GMT', 'a')}
    ${item('NewJeans announce &#8220;comeback&#8221;', 'Korea JoongAng Daily', 'Tue, 27 Oct 2026 04:34:30 GMT', 'b')}
    ${item('NEWJEANS ANNOUNCE “COMEBACK”', 'Kpopmap', 'Tue, 27 Oct 2026 05:00:00 GMT', 'c')}
  </channel></rss>`;

  it('strips the outlet suffix, decodes entities and sorts newest first', () => {
    const items = parseNewsRss(feed);
    expect(items.map((a) => a.title)).toEqual(['NEWJEANS ANNOUNCE “COMEBACK”', 'Older story & more']);
    expect(items[0]).toMatchObject({ source: 'Kpopmap', url: 'https://news.google.com/rss/articles/c?oc=5', publishedAt: '2026-10-27T05:00:00.000Z' });
  });
  it('turns an outlet URL into its host name', () => {
    const [a] = parseNewsRss(item('Ten islands to visit', 'https://www.islands.com/', 'Tue, 27 Oct 2026 01:00:00 GMT', 'd'));
    expect(a).toMatchObject({ title: 'Ten islands to visit', source: 'islands.com' });
  });
  it('ignores the channel title and empty feeds', () => {
    expect(parseNewsRss('<rss><channel><title>x</title></channel></rss>')).toEqual([]);
  });
});

describe('sniffImage', () => {
  const bytes = (head: number[] | string) => {
    const b = new Uint8Array(16);
    b.set(typeof head === 'string' ? [...head].map((c) => c.charCodeAt(0)) : head);
    return b;
  };
  it('recognises JPEG, PNG, GIF and WebP from their first bytes', () => {
    expect(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('image/png');
    expect(sniffImage(bytes('GIF89a'))).toBe('image/gif');
    expect(sniffImage(bytes('RIFF\0\0\0\0WEBP'))).toBe('image/webp');
  });
  it('rejects anything else, whatever it claims to be', () => {
    expect(sniffImage(bytes('<svg xmlns="'))).toBeNull();
    expect(sniffImage(bytes('<html><script>'))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe('pickWeather', () => {
  const forecast = {
    data: {
      area_metadata: [
        { name: 'Bishan', label_location: { latitude: 1.35, longitude: 103.839 } },
        { name: 'City', label_location: { latitude: 1.292, longitude: 103.844 } },
      ],
      items: [{
        timestamp: '2026-10-27T19:12:00+08:00',
        valid_period: { end: '2026-10-27T21:00:00+08:00' },
        forecasts: [{ area: 'Bishan', forecast: 'Thundery Showers' }, { area: 'City', forecast: 'Cloudy' }],
      }],
    },
  };
  const temps = {
    data: {
      stations: [
        { id: 'S109', name: 'Ang Mo Kio Avenue 5', location: { latitude: 1.3793, longitude: 103.85 } },
        { id: 'S24', name: 'Upper Changi Road North', location: { latitude: 1.3678, longitude: 103.9826 } },
        { id: 'S43', name: 'Kim Chuan Road', location: { latitude: 1.3399, longitude: 103.8878 } },
      ],
      readings: [{ timestamp: '2026-10-27T19:13:00+08:00', data: [{ stationId: 'S109', value: 27.4 }, { stationId: 'S24', value: 29 }, { stationId: 'S43', value: 28.1 }] }],
    },
  };
  it('takes the area forecast and the nearest station with a reading', () => {
    const { areas, now } = pickWeather(forecast, temps, 'Bishan');
    expect(areas).toEqual(['Bishan', 'City']);
    expect(now).toMatchObject({ area: 'Bishan', forecast: 'Thundery Showers', tempC: 27.4, station: 'Ang Mo Kio Avenue 5', validUntil: '2026-10-27T21:00:00+08:00' });
  });
  it('falls back to City for an unknown area, and copes without temperatures', () => {
    expect(pickWeather(forecast, {}, 'Atlantis').now).toMatchObject({ area: 'City', forecast: 'Cloudy', tempC: null, station: null });
  });
  it('throws when the response has no forecast', () => {
    expect(() => pickWeather({ data: { items: [] } }, temps, 'City')).toThrow();
  });
});

describe('weather display', () => {
  it.each([
    ['Heavy Thundery Showers with Gusty Winds', false, 'ph-cloud-lightning'],
    ['Light Rain', false, 'ph-cloud-rain'],
    ['Passing Showers', true, 'ph-cloud-rain'],
    ['Slightly Hazy', false, 'ph-cloud-fog'],
    ['Partly Cloudy (Night)', true, 'ph-cloud-moon'],
    ['Partly Cloudy (Day)', false, 'ph-cloud-sun'],
    ['Cloudy', false, 'ph-cloud'],
    ['Fair and Warm', false, 'ph-sun'],
    ['Fair (Night)', true, 'ph-moon'],
  ])('%s → %s', (f, night, icon) => {
    expect(weatherIcon(f, night)).toBe(icon);
  });
  it('drops the day/night suffix and uses sentence case', () => {
    expect(weatherLabel('Partly Cloudy (Night)')).toBe('Partly cloudy');
    expect(weatherLabel('Thundery Showers')).toBe('Thundery showers');
  });
});
