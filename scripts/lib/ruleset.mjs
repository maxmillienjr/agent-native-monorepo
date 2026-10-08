/**
 * Every required check in `.github/rulesets/main.json` is a job that exists (P1-D).
 *
 * The ruleset names the checks a merge into main waits for, by the name GitHub gives each
 * job's check run. Nothing ties that string to a workflow: rename a job, or bump the Node
 * version in a matrix, and the check becomes one that nothing reports, which GitHub shows
 * as "Expected — waiting" for ever and which blocks every pull request. So each context is
 * resolved against the check names the workflows actually produce, after matrix
 * expansion, and must match exactly one.
 *
 * GitHub's rule, for a job without an expression in its name: the check is the job's
 * `name`, or its id when it has none, followed by ` (v1, v2)` — the matrix values in key
 * order — when the job has a matrix. Anything this cannot expand the same way (an
 * expression in the name, `include`, `exclude`, a matrix from an expression) is refused
 * rather than guessed at, because a guess is how a required check ends up waiting for ever.
 */
import { parse as parseYaml } from 'yaml';

/**
 * The check-run names one workflow produces, and the problems that stopped a job from
 * being expanded.
 */
export function workflowCheckNames(file, text) {
  const names = [];
  const problems = [];
  const workflow = parseYaml(text) ?? {};

  for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
    const where = `.github/workflows/${file} job \`${id}\``;
    const name = typeof job?.name === 'string' ? job.name : id;
    if (name.includes('${{')) {
      problems.push(`${where} has an expression in its name, which this check cannot resolve`);
      continue;
    }

    const matrix = job?.strategy?.matrix;
    if (matrix === undefined) {
      names.push(name);
      continue;
    }
    if (
      typeof matrix !== 'object' ||
      matrix === null ||
      'include' in matrix ||
      'exclude' in matrix
    ) {
      problems.push(`${where} has a matrix this check cannot expand`);
      continue;
    }

    let combos = [[]];
    let expandable = true;
    for (const values of Object.values(matrix)) {
      if (!Array.isArray(values) || values.some((v) => typeof v === 'object' && v !== null)) {
        expandable = false;
        break;
      }
      combos = combos.flatMap((combo) => values.map((value) => [...combo, String(value)]));
    }
    if (!expandable) {
      problems.push(`${where} has a matrix this check cannot expand`);
      continue;
    }
    for (const combo of combos) names.push(`${name} (${combo.join(', ')})`);
  }
  return { names, problems };
}

/** The contexts the ruleset requires, in file order. */
export function requiredContexts(ruleset) {
  return (ruleset?.rules ?? [])
    .filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
    .map((check) => check.context);
}

/**
 * Problems with a ruleset against a set of workflows, as sentences. Empty when every
 * required context is reported by exactly one job.
 *
 * @param {unknown} ruleset the parsed `.github/rulesets/main.json`
 * @param {{ file: string, text: string }[]} workflows every file in `.github/workflows`
 */
export function checkRuleset(ruleset, workflows) {
  const problems = [];
  const contexts = requiredContexts(ruleset);
  if (contexts.length === 0) problems.push('requires no status check, so it gates nothing');

  const names = [];
  for (const { file, text } of workflows) {
    const result = workflowCheckNames(file, text);
    names.push(...result.names);
    problems.push(...result.problems);
  }

  for (const context of contexts) {
    const count = names.filter((name) => name === context).length;
    if (count === 1) continue;
    problems.push(
      `requires the check \`${context}\`, which ` +
        (count === 0 ? 'no workflow job reports' : `${count} workflow jobs report`) +
        ` (checks: ${names.map((n) => `\`${n}\``).join(', ')})`,
    );
  }
  return problems;
}
