import base from '@repo/eslint-config';

export default [
  ...base,
  {
    // The clinician gate (P3-A). `@repo/determination/clinician` holds the one
    // constructor for an adverse determination, and the graph lives under
    // src/agent. The package's exports map cannot keep the subpath out — it is
    // public on purpose, for the clinician review surface — and neither can
    // leaving it out of package.json, because every workspace is symlinked into
    // node_modules. This rule is the boundary. `clinician-boundary.test.ts`
    // proves it fires.
    files: ['src/agent/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@repo/determination/clinician',
              message: 'The agent may approve or refer. Only a clinician can deny. See P3-A.',
            },
            // The decision ledger (P3-C). The service appends after a run
            // settles, outside the graph; the agent cannot write the record
            // it is audited by, and never reads it. `ledger-boundary.test.ts`
            // proves the rule fires.
            {
              name: '@repo/decision-ledger',
              message: 'The agent cannot write the ledger it is audited by. See P3-C.',
            },
            {
              name: '@repo/decision-ledger/testing',
              message: 'The agent cannot write the ledger it is audited by. See P3-C.',
            },
          ],
        },
      ],
    },
  },
];
