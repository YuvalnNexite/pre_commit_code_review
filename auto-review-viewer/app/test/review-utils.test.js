const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');

const { parseBadAssessments, applySuggestionDiff } = require('../review-utils');

const execFileAsync = promisify(execFile);

test('parseBadAssessments extracts BAD assessments with metadata and diff', () => {
  const sample = `## Change-by-Change Review

### Assessment of the change: BAD
**title:** Fix logging bug
**file:** src/app.js
**function:** logMessage
**Lines:** 10-15
**Details:** Logging uses the wrong level.
**Suggestion (if 'BAD'):** Apply this minimal patch:
\`\`\`diff
--- a/src/app.js
+++ b/src/app.js
@@ -10,3 +10,3 @@
-console.log('debug');
+console.error('debug');
\`\`\`
**Reasoning (if 'BAD'):** Use error logs for failures.
---

### Assessment of the change: GOOD
**title:** Keep helper intact
**file:** src/util.js
**function:** helper
**Lines:** 1-5
**Details:** Looks good.
---

### Assessment of the change: BAD
**title:** Add missing tests
**file:** src/app.test.js
**function:** shouldLogError
**Lines:** 30-60
**Details:** Coverage is missing.
**Suggestion (if 'BAD'):** Please add unit tests.
**Reasoning (if 'BAD'):** Maintain coverage.
---
`;

  const assessments = parseBadAssessments(sample);
  assert.equal(assessments.length, 2);

  const first = assessments[0];
  assert.equal(first.id, 1);
  assert.equal(first.position, 1);
  assert.equal(first.title, 'Fix logging bug');
  assert.equal(first.file, 'src/app.js');
  assert.equal(first.function, 'logMessage');
  assert.equal(first.lines, '10-15');
  assert.match(first.suggestion.text, /Apply this minimal patch/);
  assert.ok(first.suggestion.diff);
  assert.match(first.suggestion.diff, /console\.error/);

  const second = assessments[1];
  assert.equal(second.id, 2);
  assert.equal(second.position, 3);
  assert.equal(second.file, 'src/app.test.js');
  assert.equal(second.suggestion.diff, null);
  assert.match(second.details, /Coverage is missing/);
});

test('applySuggestionDiff applies diff inside a git repository', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-utils-'));
  const execGit = (args) => execFileAsync('git', args, { cwd: repoDir });

  try {
    await execGit(['init', '--quiet']);
    await execGit(['config', 'user.email', 'test@example.com']);
    await execGit(['config', 'user.name', 'Test User']);

    const filePath = path.join(repoDir, 'sample.txt');
    await fs.writeFile(filePath, 'hello\n', 'utf8');
    await execGit(['add', 'sample.txt']);
    await execGit(['commit', '-m', 'Initial commit', '--quiet']);

    const diff = [
      '--- a/sample.txt',
      '+++ b/sample.txt',
      '@@ -1 +1 @@',
      '-hello',
      '+hello world',
      ''
    ].join('\n');

    await applySuggestionDiff(diff, repoDir);
    const updated = await fs.readFile(filePath, 'utf8');
    assert.equal(updated, 'hello world\n');

    await assert.rejects(applySuggestionDiff(diff, repoDir));
  } finally {
    await fs.rm(repoDir, { recursive: true, force: true });
  }
});
