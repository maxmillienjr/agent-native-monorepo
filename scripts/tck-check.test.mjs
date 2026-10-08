import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, nodeId, parseExpected, parseJUnit } from './tck-check.mjs';

const XML = `<?xml version="1.0"?><testsuites><testsuite name="pytest">
<testcase classname="tests.compatibility.core_operations.test_artifacts.TestTextArtifact" name="test_task_has_text_artifact[jsonrpc]" time="0.1"><failure message="x">boom</failure></testcase>
<testcase classname="tests.compatibility.core_operations.test_requirements" name="test_must_requirement[CORE-SEND-001-jsonrpc]" time="0.1" />
<testcase classname="tests.compatibility.core_operations.test_requirements" name="test_must_requirement[CORE-SEND-003-jsonrpc]" time="0.1"><failure message="y">boom</failure></testcase>
<testcase classname="tests.compatibility.grpc.test_x" name="test_skipped" time="0"><skipped message="no grpc" /></testcase>
</testsuite></testsuites>`;

test('nodeId turns a JUnit classname into a pytest node id, with or without a class', () => {
  assert.equal(
    nodeId(
      'tests.compatibility.core_operations.test_artifacts.TestTextArtifact',
      'test_a[jsonrpc]',
    ),
    'tests/compatibility/core_operations/test_artifacts.py::TestTextArtifact::test_a[jsonrpc]',
  );
  assert.equal(
    nodeId('tests.compatibility.core_operations.test_requirements', 'test_b'),
    'tests/compatibility/core_operations/test_requirements.py::test_b',
  );
});

test('parseJUnit reads each outcome', () => {
  assert.deepEqual(
    parseJUnit(XML).map((c) => c.outcome),
    ['failed', 'passed', 'failed', 'skipped'],
  );
});

test('parseExpected requires a reason on every line', () => {
  assert.throws(() => parseExpected('tests/x.py::test_a\n'), /no reason/);
  assert.equal(parseExpected('# c\n\ntests/x.py::t  scripted\n').get('tests/x.py::t'), 'scripted');
});

test('compare fails both ways: an unlisted failure, a listed pass, a listed test that never ran', () => {
  const cases = parseJUnit(XML);
  const expected = parseExpected(
    [
      'tests/compatibility/core_operations/test_artifacts.py::TestTextArtifact::test_task_has_text_artifact[jsonrpc]  scripted',
      'tests/compatibility/core_operations/test_requirements.py::test_must_requirement[CORE-SEND-001-jsonrpc]  stale',
      'tests/compatibility/grpc/test_x.py::test_skipped  skipped',
      'tests/compatibility/gone.py::test_renamed  renamed',
    ].join('\n'),
  );

  const result = compare(cases, expected);

  assert.deepEqual(
    result.unexpectedFailures.map((c) => c.id),
    [
      'tests/compatibility/core_operations/test_requirements.py::test_must_requirement[CORE-SEND-003-jsonrpc]',
    ],
  );
  assert.deepEqual(result.expectedButPassed, [
    'tests/compatibility/core_operations/test_requirements.py::test_must_requirement[CORE-SEND-001-jsonrpc]',
  ]);
  assert.deepEqual(result.expectedButAbsent, [
    'tests/compatibility/grpc/test_x.py::test_skipped',
    'tests/compatibility/gone.py::test_renamed',
  ]);
});
