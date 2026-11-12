// ⌘K's "Ask Launchpad" on the server: what's typed goes to Claude with today's date and
// the names of accounts, task lists, courses and bookmark groups (nothing else), and the
// one action it picks comes back checked and phrased for the palette to show.
import { askTool } from './claude';
import { config } from './config';
import { store } from './store';
import { askSystem, askTools, checkAction, describeAction, type AskContext, type AskResult } from '../../shared/ask';
import { ymd } from '../../shared/dates';
import { mainAccount } from '../../shared/money';

export const MAX_ASK = 300;

export function askContext(now = new Date()): AskContext {
  const money = store.money();
  const accounts = money.accounts.filter((a) => !a.archived);
  const prefs = store.prefs();
  const tasksOn = !!store.google() && prefs.sources.tasks;
  return {
    today: ymd(now),
    accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
    mainAccount: accounts.length ? mainAccount(money.accounts) : '',
    taskLists: tasksOn ? store.tasks().lists.map((l) => ({ id: l.id, title: l.title })) : [],
    courses: store.learn().courses.filter((c) => !c.archived).map((c) => ({ id: c.id, code: c.code, name: c.name })),
    bookmarkGroups: store.bookmarks().map((g) => ({ id: g.id, name: g.name })),
  };
}

export async function ask(typed: string): Promise<AskResult> {
  const c = askContext();
  const res = await askTool({
    model: config.askModel,
    feature: 'ask',
    system: askSystem(c),
    user: typed.slice(0, MAX_ASK),
    tools: askTools(c),
    effort: 'low',
    task: 'turn that into an action',
  });
  if ('text' in res) return { error: res.text || 'Claude couldn’t turn that into something Launchpad can do.' };
  const checked = checkAction(res.name, res.input, c);
  if (!checked.ok) return { error: checked.error };
  return { action: checked.action, ...describeAction(checked.action, c) };
}
