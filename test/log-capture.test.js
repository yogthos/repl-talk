/*global test*/

/**
 * Tests for console log capture functionality
 * Verifies stdout/stderr separation, log levels, and timestamps
 */

var test = require('node:test');
var assert = require('node:assert');
var resultHandler = require('../src/result-handler');

test('Log Capture', function(t) {
    t.test('serializeResult with logs', function() {
        return new Promise(function(resolve, reject) {
            try {
                var messages = [
                    { out: 'Hello world\n', status: ['done'] },
                    { value: 'nil', status: ['done'] }
                ];

                var result = resultHandler.serializeResult(messages, 100);

                assert(result.logs, 'Result should have logs array');
                assert(Array.isArray(result.logs), 'Logs should be an array');
                assert(result.logs.length > 0, 'Should have at least one log entry');

                var infoLog = result.logs.find(function(log) { return log.level === 'INFO'; });
                assert(infoLog, 'Should have INFO level log');
                assert(infoLog.message === 'Hello world', 'Log message should match');
                assert(infoLog.timestamp, 'Log should have timestamp');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

    t.test('should capture stderr as ERROR level logs', function() {
        return new Promise(function(resolve, reject) {
            try {
                var messages = [
                    { err: 'Error occurred\n', status: ['done'] },
                    { value: 'nil', status: ['done'] }
                ];

                var result = resultHandler.serializeResult(messages, 50);

                var errorLog = result.logs.find(function(log) { return log.level === 'ERROR'; });
                assert(errorLog, 'Should have ERROR level log');
                assert(errorLog.message === 'Error occurred', 'Error log message should match');
                assert(errorLog.timestamp, 'Error log should have timestamp');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

    t.test('should detect WARN patterns in stdout', function() {
        return new Promise(function(resolve, reject) {
            try {
                var messages = [
                    { out: 'Warning: This is a warning message\n', status: ['done'] },
                    { value: 'nil', status: ['done'] }
                ];

                var result = resultHandler.serializeResult(messages, 75);

                var warnLog = result.logs.find(function(log) { return log.level === 'WARN'; });
                assert(warnLog, 'Should have WARN level log');
                assert(/warning/i.test(warnLog.message), 'Warn log should contain warning text');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

    t.test('should separate multiple log lines', function() {
        return new Promise(function(resolve, reject) {
            try {
                var messages = [
                    { out: 'Line 1\nLine 2\nLine 3\n', status: ['done'] },
                    { value: 'nil', status: ['done'] }
                ];

                var result = resultHandler.serializeResult(messages, 200);

                assert(result.logs.length >= 3, 'Should have multiple log entries');
                var infoLogs = result.logs.filter(function(log) { return log.level === 'INFO'; });
                assert(infoLogs.length >= 3, 'Should have multiple INFO logs');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

    t.test('should include execution time in result', function() {
        return new Promise(function(resolve, reject) {
            try {
                var messages = [
                    { value: '42', status: ['done'] }
                ];

                var executionTime = 150;
                var result = resultHandler.serializeResult(messages, executionTime);

                assert.strictEqual(result.executionTime, executionTime, 'Execution time should match');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

    t.test('should handle empty logs gracefully', function() {
        return new Promise(function(resolve, reject) {
            try {
                var messages = [
                    { value: '42', status: ['done'] }
                ];

                var result = resultHandler.serializeResult(messages, 100);

                assert(Array.isArray(result.logs), 'Logs should be an array');
                assert(result.logs.length === 0, 'Should have empty logs array when no output');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

    t.test('should include logs in error results', function() {
        return new Promise(function(resolve, reject) {
            try {
                var messages = [
                    { err: 'Something went wrong\n', status: ['error', 'done'] },
                    { 'root-cause': 'RuntimeException: Test error' }
                ];

                var result = resultHandler.serializeResult(messages, 50);

                assert(result.type === 'error', 'Should be error type');
                assert(result.logs.length > 0, 'Error result should have logs');
                assert(result.logs.some(function(log) { return log.level === 'ERROR'; }), 'Should have ERROR logs');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

    t.test('formatForVisualization with logs', function() {
        return new Promise(function(resolve, reject) {
            try {
                var result = {
                    type: 'string',
                    value: 'test',
                    raw: 'test',
                    logs: [
                        { level: 'INFO', message: 'Test message', timestamp: new Date().toISOString() }
                    ],
                    executionTime: 100
                };

                var formatted = resultHandler.formatForVisualization(result);

                assert(formatted.logs, 'Formatted result should have logs');
                assert(Array.isArray(formatted.logs), 'Logs should be an array');
                assert(formatted.executionTime === 100, 'Should include execution time');
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
});

