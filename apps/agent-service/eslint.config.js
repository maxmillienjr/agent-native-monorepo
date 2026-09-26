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
          ],
        },
      ],
    },
  },
];
