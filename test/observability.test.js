/*global test*/

/**
 * Tests for structured observability
 * Verifies logs in results, execution time, and structured entries
 */

var test = require('node:test');
var assert = require('node:assert');
var resultHandler = require('../src/result-handler');

test('Structured Observability', function(t) {
    t.test('Result structure with logs and execution time', function() {
        return new Promise(function(resolve, reject) {
            try {
                var messages = [
                    { out: 'Processing data\n', status: ['done'] },
                    { value: '42', status: ['done'] }
                ];

                var result = resultHandler.serializeResult(messages, 150);

                assert(result.logs, 'Result should have logs');
                assert(Array.isArray(result.logs), 'Logs should be an array');
                assert(result.executionTime === 150, 'Should include execution time');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

    t.test('should include logs array in error results', function() {
        return new Promise(function(resolve, reject) {
            try {
                var messages = [
                    { err: 'Error message\n', status: ['error', 'done'] },
                    { 'root-cause': 'Test error' }
                ];

                var result = resultHandler.serializeResult(messages, 75);

                assert(result.type === 'error', 'Should be error type');
                assert(result.logs, 'Error result should have logs');
                assert(result.executionTime === 75, 'Error result should include execution time');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

    t.test('should structure log entries with level, message, and timestamp', function() {
        return new Promise(function(resolve, reject) {
            try {
                var messages = [
                    { out: 'Info message\n', status: ['done'] },
                    { err: 'Error message\n', status: ['done'] },
                    { value: 'nil', status: ['done'] }
                ];

                var result = resultHandler.serializeResult(messages, 100);

                assert(result.logs.length >= 2, 'Should have multiple log entries');

                result.logs.forEach(function(log) {
                    assert(log.level, 'Log should have level');
                    assert(['INFO', 'WARN', 'ERROR'].includes(log.level), 'Log level should be valid');
                    assert(log.message, 'Log should have message');
                    assert(log.timestamp, 'Log should have timestamp');
                    assert(typeof log.timestamp === 'string', 'Timestamp should be a string');
                });
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

    t.test('should include execution time in formatted results', function() {
        return new Promise(function(resolve, reject) {
            try {
                var result = {
                    type: 'string',
                    value: 'test',
                    raw: 'test',
                    logs: [],
                    executionTime: 250
                };

                var formatted = resultHandler.formatForVisualization(result);

                assert.strictEqual(formatted.executionTime, 250, 'Formatted result should include execution time');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

    t.test('should include logs in formatted results', function() {
        return new Promise(function(resolve, reject) {
            try {
                var logs = [
                    { level: 'INFO', message: 'Test', timestamp: '2025-01-01T00:00:00.000Z' },
                    { level: 'WARN', message: 'Warning', timestamp: '2025-01-01T00:00:00.000Z' }
                ];

                var result = {
                    type: 'string',
                    value: 'test',
                    raw: 'test',
                    logs: logs,
                    executionTime: 100
                };

                var formatted = resultHandler.formatForVisualization(result);

                assert.deepEqual(formatted.logs, logs, 'Formatted result should include logs');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

    t.test('should handle missing logs gracefully', function() {
        return new Promise(function(resolve, reject) {
            try {
                var result = {
                    type: 'string',
                    value: 'test',
                    raw: 'test',
                    executionTime: 50
                };

                var formatted = resultHandler.formatForVisualization(result);

                assert(Array.isArray(formatted.logs), 'Should have logs array even if missing');
                assert(formatted.logs.length === 0, 'Should have empty logs array');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

    t.test('should preserve log order', function() {
        return new Promise(function(resolve, reject) {
            try {
                var messages = [
                    { out: 'First\nSecond\nThird\n', status: ['done'] },
                    { value: 'nil', status: ['done'] }
                ];

                var result = resultHandler.serializeResult(messages, 200);

                assert(result.logs.length >= 3, 'Should have multiple logs');
                assert(result.logs[0].message === 'First', 'First log should be first');
                assert(result.logs[1].message === 'Second', 'Second log should be second');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
});

