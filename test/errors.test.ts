import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeErrorMessage } from '../server/src/claude';
import { googleApiError, SIGNED_OUT } from '../server/src/google';
import { api, ServerError } from '../web/src/api';

const apiError = (status: number, type: string, message: string) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, undefined, new Headers());

describe('claudeErrorMessage', () => {
  const msg = (e: unknown) => claudeErrorMessage(e, 'claude-haiku-5-5');

  it('points a rejected key at ANTHROPIC_API_KEY', () => {
    expect(msg(apiError(401, 'authentication_error', 'invalid x-api-key'))).toMatch(/ANTHROPIC_API_KEY in \.env/);
  });

  it('points an empty account at billing', () => {
    expect(msg(apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'))).toMatch(/out of credit/);
    expect(msg(apiError(402, 'billing_error', 'Payment required'))).toMatch(/out of credit/);
  });

  it('names the model when it isn’t found', () => {
    expect(msg(apiError(404, 'not_found_error', 'model: claude-haiku-5-5'))).toMatch(/“claude-haiku-5-5”.*NEWS_MODEL, INBOX_MODEL and TRAINING_MODEL/);
  });

  it('says overload and rate limits clear up by themselves', () => {
    expect(msg(apiError(529, 'overloaded_error', 'Overloaded'))).toMatch(/having trouble \(529 Overloaded\).*next sync/);
    expect(msg(apiError(429, 'rate_limit_error', 'Too many requests'))).toMatch(/rate limit/);
  });

  it('sends a network failure to the server’s connection', () => {
    expect(msg(new Anthropic.APIConnectionError({ message: 'fetch failed' }))).toMatch(/internet connection/);
    expect(msg(new Anthropic.APIConnectionTimeoutError())).toMatch(/too long/);
  });

  it('keeps the API’s own words for anything else', () => {
    expect(msg(apiError(400, 'invalid_request_error', 'messages: too long'))).toBe('Claude API error: messages: too long');
  });
});

describe('googleApiError', () => {
  it('treats a 401 as signed out', () => {
    const e = googleApiError(401, { message: 'Invalid Credentials' });
    expect(e.authExpired).toBe(true);
    expect(e.message).toBe(SIGNED_OUT);
  });

  it('asks for a reconnect when a permission is missing', () => {
    const e = googleApiError(403, { message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] });
    expect(e.authExpired).toBe(false);
    expect(e.message).toMatch(/leave every box ticked/);
  });

  it('keeps Google’s message for a disabled API, which links to the fix', () => {
    const e = googleApiError(403, { message: 'Gmail API has not been used in project 123 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] });
    expect(e.message).toMatch(/isn’t enabled.*Gmail API has not been used/);
  });

  it('says outages and rate limits retry', () => {
    expect(googleApiError(503, { message: 'Backend Error' }).message).toMatch(/next sync/);
    expect(googleApiError(403, { message: 'Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] }).message).toMatch(/rate limit/);
  });
});

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals());

  const failWith = async (impl: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(impl));
    return api.state().catch((e) => e);
  };

  it('tells an unreachable server from a failed request', async () => {
    const e = await failWith(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(e).toBeInstanceOf(ServerError);
    expect(e.kind).toBe('unreachable');
  });

  it('reads a tunnel error page as the server being down', async () => {
    const e = await failWith(async () => new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(e).toMatchObject({ kind: 'down', status: 502 });
  });

  it('reads a 403 as the Access sign-in lapsing', async () => {
    expect(await failWith(async () => new Response('', { status: 403 }))).toMatchObject({ kind: 'access' });
  });

  it('passes the server’s own error through', async () => {
    const e = await failWith(async () => Response.json({ error: 'Bad topic' }, { status: 400 }));
    expect(e).not.toBeInstanceOf(ServerError);
    expect(e.message).toBe('Bad topic');
  });
});
