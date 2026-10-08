#!/usr/bin/env node
// What the A2A server does that needs real stores (P5-A), checked against the
// running compose stack: model stub, memory live, authentication enforced.
//
//   node scripts/a2a-compose-check.mjs <base-url>
//
// 1. A completed task's id has checkpoints under thread_id = id.
// 2. A second message in one context, from one principal, is given three
//    messages: the first turn's two, rebuilt from episodic memory, and itself.
// 3. The same context id from the other principal is a different session,
//    and is given one.
//
// Uses the compose file's demo tokens, and reads Postgres through
// `docker compose exec`, so it needs nothing installed.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const base = process.argv[2];
if (base === undefined) {
  process.stderr.write('usage: a2a-compose-check.mjs <base-url>\n');
  process.exit(2);
}

const TOKENS = { tck: 'tck-demo-token', console: 'console-demo-token' };

async function send(principal, text, contextId) {
  const response = await fetch(`${base}/a2a/jsonrpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'a2a-version': '1.0',
      authorization: `Bearer ${TOKENS[principal]}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'SendMessage',
      params: {
        message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], contextId },
      },
    }),
  });
  const body = await response.json();
  if (body.error !== undefined) throw new Error(`SendMessage: ${JSON.stringify(body.error)}`);
  const task = body.result.task;
  if (task.status.state !== 'TASK_STATE_COMPLETED') {
    throw new Error(`task ${task.id} ended ${task.status.state}`);
  }
  const run = task.artifacts.find((a) => a.name === 'run').parts[0].data;
  return { task, run };
}

function psql(sql) {
  return execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'agentdb', '-tAc', sql],
    { encoding: 'utf8' },
  ).trim();
}

const failures = [];
const check = (ok, message) => {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${message}\n`);
  if (!ok) failures.push(message);
};

const contextId = `compose-check-${randomUUID()}`;

const first = await send('tck', 'What is LangGraph?', contextId);
const checkpoints = Number(
  psql(`select count(*) from checkpoints where thread_id = '${first.task.id}'`),
);
check(checkpoints >= 1, `task ${first.task.id} has ${checkpoints} checkpoint rows under its id`);
check(
  first.run.messageCount === 1,
  `the first message is given ${first.run.messageCount} message(s)`,
);

const second = await send('tck', 'And what is it for?', contextId);
check(
  second.run.messageCount === 3,
  `a second message in the context, same principal, is given ${second.run.messageCount}; expected 3`,
);

const other = await send('console', 'What is LangGraph?', contextId);
check(
  other.run.messageCount === 1,
  `the same context id from another principal is given ${other.run.messageCount}; expected 1`,
);

process.exit(failures.length === 0 ? 0 : 1);
