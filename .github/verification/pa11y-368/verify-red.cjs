'use strict';

// This harness verifies known regressions; success does not mean product tests pass.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');

const [sourceArg, contractArg, evidenceArg] = process.argv.slice(2);
assert(sourceArg && contractArg && evidenceArg, 'Expected source, contract and evidence paths');
const source = path.resolve(sourceArg);
const evidence = path.resolve(evidenceArg);
fs.mkdirSync(evidence, {recursive: true});
const contract = JSON.parse(fs.readFileSync(path.resolve(contractArg), 'utf8'));
const receipt = {
	verification_kind: 'expected-regression-proof',
	product_suite_green: false,
	source_sha: contract.source_sha,
	base_sha: contract.base_sha,
	suites: []
};

function git(...args) {
	return execFileSync('git', args, {cwd: source, encoding: 'utf8'}).trim();
}

function sameMembers(actual, expected, label) {
	assert.deepEqual([...actual].sort(), [...expected].sort(), label);
}

function checkUnchangedProduction() {
	assert.match(contract.source_sha, /^[0-9a-f]{40}$/);
	assert.match(contract.base_sha, /^[0-9a-f]{40}$/);
	assert.equal(git('rev-parse', 'HEAD'), contract.source_sha, 'Wrong immutable contribution SHA');
	assert.equal(git('merge-base', contract.base_sha, contract.source_sha), contract.base_sha,
		'Original base must be an ancestor of the tests-only commit');
	const changed = git('diff', '--name-only', contract.base_sha, contract.source_sha, '--')
		.split('\n').filter(Boolean);
	sameMembers(changed, contract.allowed_changed_files, 'Tests-only changed file set differs');
	assert(changed.length > 0, 'Tests-only commit must add acceptance coverage');
	for (const changedPath of changed) {
		assert(changedPath.startsWith('test/'), `Non-test change in RED source: ${changedPath}`);
	}
	for (const required of ['bin/pa11y-ci.js', 'lib/pa11y-ci.js', 'package.json',
		'package-lock.json', '.github/workflows/tests.yml']) {
		assert(contract.source_sha256[required], `Missing required unchanged-source hash: ${required}`);
	}
	for (const [filename, expected] of Object.entries(contract.source_sha256)) {
		assert.match(expected, /^[0-9a-f]{64}$/);
		assert(!path.isAbsolute(filename) && !filename.split('/').includes('..'), 'Invalid source path');
		const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(source, filename))).digest('hex');
		assert.equal(actual, expected, `Production source hash changed: ${filename}`);
	}
}

function runSuite(suite) {
	assert(['unit', 'integration'].includes(suite.name), 'Unknown suite');
	assert(Array.isArray(suite.expected_test_titles) && suite.expected_test_titles.length > 0,
		'Expected complete test-title list is required');
	assert(Array.isArray(suite.expected_failed_titles), 'Expected failure-title list is required');
	const fixedFiles = suite.name === 'unit' ? [
		'--file', 'test/unit/setup.test.js', 'test/unit/lib/pa11y-ci.test.js'
	] : [
		'--file', 'test/integration/setup.test.js',
		'test/integration/cli-erroring.test.js', 'test/integration/cli-json.test.js',
		'test/integration/teardown.test.js', '--timeout', '20000', '--slow', '5000'
	];
	const reportPath = path.join(evidence, `${suite.name}.json`);
	const args = ['node_modules/mocha/bin/mocha.js', ...fixedFiles, '--fail-zero',
		'--reporter', 'json', '--reporter-option', `output=${reportPath}`];
	const result = spawnSync(process.execPath, args, {
		cwd: source, encoding: 'utf8', timeout: 15 * 60 * 1000,
		maxBuffer: 64 * 1024 * 1024, env: process.env
	});
	fs.writeFileSync(path.join(evidence, `${suite.name}.stdout.log`), result.stdout || '');
	fs.writeFileSync(path.join(evidence, `${suite.name}.stderr.log`), result.stderr || '');
	const suiteReceipt = {
		name: suite.name,
		command: [process.execPath, ...args],
		status: result.status,
		signal: result.signal,
		error: result.error ? result.error.message : null
	};
	receipt.suites.push(suiteReceipt);
	assert(!result.error && !result.signal, `${suite.name}: test process did not complete normally`);
	assert.equal(result.status, Math.min(suite.expected_failed_titles.length, 255),
		`${suite.name}: exit status must match the exact expected failure count`);
	const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
	sameMembers(report.tests.map(test => test.fullTitle), suite.expected_test_titles,
		`${suite.name}: test set differs from the observed local test set`);
	sameMembers(report.failures.map(test => test.fullTitle), suite.expected_failed_titles,
		`${suite.name}: failing assertions differ from the exact expected regressions`);
	for (const failure of report.failures) {
		const error = failure.err;
		if (error.operator === 'deepEqual') {
			assert.equal(suite.name, 'integration');
			assert(error.expected.includes('\n  "failures": 1'), 'JSON expectation must contain failures');
			assert.equal(error.actual, error.expected.replace('\n  "failures": 1', ''),
				'JSON must differ only by the absent failure counter');
		} else {
			assert.equal(error.operator, '===', 'Expected a strict equality regression');
			assert.match(error.message, /^(undefined === [012]|0 === 2)$/,
				'Failure must be a missing counter or the incorrect successful exit');
		}
	}
	assert.equal(report.pending.length, 0, `${suite.name}: pending tests are not allowed`);
	assert.equal(report.stats.pending, 0, `${suite.name}: pending stats are not zero`);
	assert.equal(report.stats.failures, suite.expected_failed_titles.length);
	assert.equal(report.stats.tests, suite.expected_test_titles.length);
	assert.equal(report.passes.length + report.failures.length, report.tests.length,
		`${suite.name}: every test must pass or fail as expected`);
	suiteReceipt.tests = report.stats.tests;
	suiteReceipt.passes = report.stats.passes;
	suiteReceipt.expected_failures = report.failures.map(test => ({
		fullTitle: test.fullTitle,
		message: test.err.message
	}));
}

try {
	checkUnchangedProduction();
	assert.equal(contract.suites.length, 2, 'Exactly unit and integration focused suites are required');
	sameMembers(contract.suites.map(suite => suite.name), ['unit', 'integration'], 'Missing focused suite');
	assert(contract.suites.reduce((count, suite) => count + suite.expected_failed_titles.length, 0) > 0,
		'A RED proof must observe at least one expected regression');
	for (const suite of contract.suites) {
		runSuite(suite);
	}
	checkUnchangedProduction();
	receipt.expected_regressions_verified = true;
	console.log('Expected regression proof verified. Product tests remain intentionally failing at this tests-only SHA.');
} catch (error) {
	receipt.expected_regressions_verified = false;
	receipt.verification_error = error.stack;
	console.error(error.stack);
	process.exitCode = 1;
} finally {
	fs.writeFileSync(path.join(evidence, 'verification-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}
