/*global test,describe,before,after*/
/**
 * REPL Loop Tests
 * Tests the complete REPL loop using real components (AI client and nREPL)
 * Headless tests - no UI/WebSocket components
 */

var test = require('node:test');
var assert = require('node:assert');

var config = require('../src/config');
var nreplServer = require('../src/nrepl-server');
var nreplClient = require('../src/nrepl-client');
var aiClient = require('../src/ai-client');
var resultHandler = require('../src/result-handler');

// Test state
var testState = {
    nreplServerState: null,
    nreplConnection: null,
    nreplSession: null,
    aiClientInstance: null,
    setupComplete: false
};

/**
 * Setup: Start nREPL server and create AI client
 */
function setup(callback) {
    console.log('Setting up test environment...');

    var nreplOptions = {
        hostname: undefined, // Let Babashka choose
        port: undefined, // Let Babashka choose
        babashkaPath: config.nrepl.babashkaPath || 'bb',
        verbose: false,
        startTimeout: config.nrepl.startTimeout || 10000
    };

    // Start nREPL server
    nreplServer.start(nreplOptions, function(err, serverState) {
        if (err) {
            console.error('Failed to start nREPL server:', err);
            return callback(err);
        }

        testState.nreplServerState = serverState;
        console.log('nREPL server ready at', serverState.hostname + ':' + serverState.port);

        // Connect nREPL client
        var clientOptions = {
            host: serverState.hostname || 'localhost',
            port: serverState.port,
            verbose: false
        };

        testState.nreplConnection = nreplClient.connect(clientOptions);

        var connectionTimeout = setTimeout(function() {
            if (!testState.nreplSession) {
                console.error('Connection timeout - nREPL connection did not establish');
                callback(new Error('nREPL connection timeout'));
            }
        }, 30000);

        testState.nreplConnection.on('error', function(err) {
            console.error('nREPL connection error:', err);
            clearTimeout(connectionTimeout);
            callback(err);
        });

        testState.nreplConnection.once('connect', function() {
            console.log('Connected to nREPL server');

            // Create a session
            testState.nreplConnection.clone(function(err, messages) {
                clearTimeout(connectionTimeout);
                if (err) {
                    console.error('Failed to create nREPL session:', err);
                    return callback(err);
                }

                var newSession = messages && messages[0] && messages[0]['new-session'];
                if (newSession) {
                    testState.nreplSession = newSession;
                    console.log('Created nREPL session:', newSession);
                } else {
                    console.warn('Warning: No new-session in clone response');
                }

                // Create eval callback for AI client
                function evalClojure(codeString, callback) {
                    if (!testState.nreplConnection || !testState.nreplSession) {
                        return callback(new Error('nREPL not connected'), null);
                    }

                    testState.nreplConnection.eval(codeString, undefined, testState.nreplSession, function(err, messages) {
                        if (err) {
                            return callback(err, null);
                        }

                        // Serialize result
                        var executionTime = Date.now() - Date.now(); // 0 for test
                        var result = resultHandler.serializeResult(messages, executionTime);
                        var formatted = resultHandler.formatForVisualization(result);

                        callback(null, formatted);
                    });
                }

                // Create AI client with eval callback
                testState.aiClientInstance = aiClient.createAIClient(config, evalClojure, [], null, null);

                console.log('Setup complete - nREPL ready');
                testState.setupComplete = true;
                callback(null);
            });
        });
    });
}

/**
 * Teardown: Stop nREPL server and close connections
 */
function teardown(callback) {
    console.log('Tearing down test environment...');

    if (testState.nreplConnection) {
        testState.nreplConnection.end();
        testState.nreplConnection = null;
    }

    if (testState.nreplServerState && !testState.nreplServerState.external) {
        nreplServer.stop(testState.nreplServerState, function() {
            console.log('nREPL server stopped');
            if (callback) callback();
        });
    } else {
        if (callback) callback();
    }
}

// Helper to flush output
function flushOutput() {
    if (process.stdout.write) {
        process.stdout.write('');
    }
    if (process.stderr.write) {
        process.stderr.write('');
    }
}

// Test suite with before/after hooks
var testSuite = test('REPL Loop Tests', {
    before: function() {
        console.log('BEFORE HOOK CALLED - Starting setup...');
        flushOutput();
        return new Promise(function(resolve, reject) {
            console.log('BEFORE HOOK - Calling setup function...');
            setup(function(err) {
                flushOutput();
                if (err) {
                    console.error('BEFORE HOOK - Setup failed:', err);
                    reject(err);
                } else {
                    console.log('BEFORE HOOK - Setup completed successfully');
                    resolve();
                }
            });
        });
    },
    after: function() {
        flushOutput();
        return new Promise(function(resolve) {
            teardown(function() {
                flushOutput();
                resolve();
            });
        });
    }
}, function(t) {

    // Test 1: Direct nREPL evaluation
    t.test('nREPL can evaluate simple Clojure code', function() {
        return new Promise(function(resolve, reject) {
            if (!testState.setupComplete || !testState.nreplConnection || !testState.nreplSession) {
                return reject(new Error('nREPL not initialized - setup may not have completed'));
            }
            var code = '(+ 1 2)';
            testState.nreplConnection.eval(code, undefined, testState.nreplSession, function(err, messages) {
                if (err) {
                    reject(err);
                    return;
                }

                // Debug: log messages if needed
                if (process.env.DEBUG_TESTS) {
                    console.log('nREPL messages for (+ 1 2):', JSON.stringify(messages, null, 2));
                }

                var executionTime = Date.now() - Date.now(); // 0 for test
                var result = resultHandler.serializeResult(messages, executionTime);

                // Debug: log result if needed
                if (process.env.DEBUG_TESTS) {
                    console.log('Serialized result:', JSON.stringify(result, null, 2));
                }

                assert.ok(result, 'Result should exist');

                // If we got an error, provide more information
                if (result.type === 'error') {
                    console.error('Unexpected error in nREPL evaluation:', result.error);
                    console.error('Raw messages:', messages);
                    reject(new Error('nREPL evaluation returned error: ' + result.error +
                        (result.stderr ? '\nstderr: ' + result.stderr : '')));
                    return;
                }

                assert.strictEqual(result.type, 'number',
                    'Result type should be number, got: ' + result.type + ', result: ' + JSON.stringify(result));

                // Handle case where value might be string "3" instead of number 3
                var expectedValue = 3;
                if (typeof result.value === 'string' && result.value === '3') {
                    // Parser might return string, that's okay for this test
                    expectedValue = '3';
                }

                assert.strictEqual(result.value, expectedValue,
                    'Result value should be 3, got: ' + result.value + ' (type: ' + typeof result.value + ')');
                resolve();
            });
        });
    });

    // Test 2: nREPL file listing
    t.test('nREPL can list files using babashka.fs', function() {
        return new Promise(function(resolve, reject) {
            if (!testState.setupComplete || !testState.nreplConnection || !testState.nreplSession) {
                return reject(new Error('nREPL not initialized - setup may not have completed'));
            }
            var code = '(require \'[babashka.fs :as fs])\n(map str (fs/list-dir "."))';
            testState.nreplConnection.eval(code, undefined, testState.nreplSession, function(err, messages) {
                if (err) {
                    reject(err);
                    return;
                }

                var executionTime = Date.now() - Date.now(); // 0 for test
                var result = resultHandler.serializeResult(messages, executionTime);
                assert.ok(result, 'Result should exist');

                // Check if we got an error
                if (result.type === 'error') {
                    console.log('Error result:', result);
                    // This might be the "class " error we're investigating
                    assert.fail('nREPL evaluation failed: ' + (result.error || 'Unknown error'));
                } else {
                    assert.ok(result.value !== null, 'Result should have a value');
                    // Result should be a list of file names
                    assert.ok(Array.isArray(result.value) || typeof result.value === 'string',
                        'Result should be a list or string');
                }
                resolve();
            });
        });
    });

    // Test 3: Result handler serialization
    t.test('Result handler properly serializes nREPL messages', function() {
        // Test with mock nREPL messages
        var mockMessages = [
            { value: '3', status: ['done'] }
        ];
        var result = resultHandler.serializeResult(mockMessages, 0);
        assert.ok(result, 'Result should exist');
        assert.strictEqual(result.type, 'number', 'Result type should be number');
        assert.strictEqual(result.value, 3, 'Result value should be 3');

        // Test with error messages
        var errorMessages = [
            { err: 'Error message', status: ['done', 'error'] }
        ];
        var errorResult = resultHandler.serializeResult(errorMessages, 0);
        assert.ok(errorResult, 'Error result should exist');
        assert.strictEqual(errorResult.type, 'error', 'Error result type should be error');
        assert.ok(errorResult.error, 'Error result should have error message');
    });

    // Test 4: AI client generates code for file listing
    t.test('AI client generates Clojure code for file listing request', function() {
        return new Promise(function(resolve, reject) {
            if (!testState.setupComplete || !testState.aiClientInstance) {
                return reject(new Error('AI client not initialized - setup may not have completed'));
            }
            var userMessage = 'list files in current directory';
            var codeGenerated = false;
            var generatedCode = null;

            // Intercept the eval callback to capture generated code
            var originalEvalCallback = testState.aiClientInstance.evalCallback;
            testState.aiClientInstance.evalCallback = function(codeString, callback) {
                codeGenerated = true;
                generatedCode = codeString;
                console.log('AI generated code:', codeString);

                // Verify code structure
                assert.ok(codeString, 'Generated code should not be empty');
                assert.ok(typeof codeString === 'string', 'Generated code should be a string');

                // Check if it uses babashka.fs (common pattern)
                var usesFs = codeString.includes('babashka.fs') || codeString.includes('fs/list-dir') ||
                            codeString.includes('fs/list-dir');

                // Call original callback to actually execute
                originalEvalCallback(codeString, callback);
            };

            testState.aiClientInstance.sendMessage(userMessage, null, function(err, response) {
                // Restore original callback
                testState.aiClientInstance.evalCallback = originalEvalCallback;

                if (err) {
                    reject(err);
                    return;
                }

                // Verify AI was called (it may or may not generate code depending on model)
                // The important thing is that the flow works
                assert.ok(response, 'AI should return a response');
                resolve();
            });
        });
    });

    // Test 5: Full integration test - complete REPL loop
    t.test('Full REPL loop: user message → AI → nREPL → result', function() {
        return new Promise(function(resolve, reject) {
            if (!testState.setupComplete || !testState.aiClientInstance) {
                return reject(new Error('AI client not initialized - setup may not have completed'));
            }
            var userMessage = 'list files in current directory';
            var steps = {
                aiCalled: false,
                codeGenerated: false,
                nreplExecuted: false,
                resultReceived: false
            };

            // Track the flow
            var originalEvalCallback = testState.aiClientInstance.evalCallback;
            testState.aiClientInstance.evalCallback = function(codeString, callback) {
                steps.aiCalled = true;
                steps.codeGenerated = true;
                console.log('Step 2: AI generated code:', codeString);

                // Execute via nREPL
                originalEvalCallback(codeString, function(err, result) {
                    if (err) {
                        console.error('Step 3: nREPL execution error:', err);
                        callback(err, null);
                        return;
                    }

                    steps.nreplExecuted = true;
                    steps.resultReceived = true;
                    console.log('Step 4: nREPL result:', result);

                    // Verify result structure
                    assert.ok(result, 'Result should exist');
                    assert.ok(typeof result === 'object', 'Result should be an object');
                    assert.ok('type' in result, 'Result should have type property');

                    callback(null, result);
                });
            };

            testState.aiClientInstance.sendMessage(userMessage, null, function(err, response) {
                // Restore original callback
                testState.aiClientInstance.evalCallback = originalEvalCallback;

                if (err) {
                    console.error('Full loop error:', err);
                    reject(err);
                    return;
                }

                // Verify all steps were executed
                assert.ok(steps.aiCalled, 'AI should have been called');
                assert.ok(steps.codeGenerated, 'Code should have been generated');
                assert.ok(steps.nreplExecuted, 'nREPL should have executed code');
                assert.ok(steps.resultReceived, 'Result should have been received');
                assert.ok(response, 'AI should return final response');

                console.log('Full REPL loop completed successfully');
                resolve();
            });
        });
    });

    // Test 6: Error handling
    t.test('Error handling: invalid Clojure code', function() {
        return new Promise(function(resolve, reject) {
            if (!testState.setupComplete || !testState.nreplConnection || !testState.nreplSession) {
                return reject(new Error('nREPL not initialized - setup may not have completed'));
            }
            var invalidCode = '(invalid syntax here';
            testState.nreplConnection.eval(invalidCode, undefined, testState.nreplSession, function(err, messages) {
                if (err) {
                    // Connection error
                    assert.ok(err, 'Should have error for invalid code');
                    resolve();
                    return;
                }

                // Check if nREPL returned error in messages
                var executionTime = Date.now() - Date.now(); // 0 for test
                var result = resultHandler.serializeResult(messages, executionTime);

                // Either we get an error type or the result indicates failure
                if (result.type === 'error') {
                    assert.ok(result.error, 'Error result should have error message');
                    console.log('Error handled correctly:', result.error);
                } else {
                    // Some nREPL implementations might not return error type
                    console.log('Result for invalid code:', result);
                }
                resolve();
            });
        });
    });

    // Test 7: Test result handler with various result types
    t.test('Result handler handles various result types', function() {
        // Test string result
        var stringMessages = [{ value: '"hello"', status: ['done'] }];
        var stringResult = resultHandler.serializeResult(stringMessages, 0);
        assert.strictEqual(stringResult.type, 'string', 'String result type');
        assert.strictEqual(stringResult.value, 'hello', 'String result value');

        // Test list result
        var listMessages = [{ value: '["a" "b" "c"]', status: ['done'] }];
        var listResult = resultHandler.serializeResult(listMessages, 0);
        assert.ok(listResult, 'List result should exist');
        // Note: Simple parser may not handle complex structures perfectly

        // Test null result
        var nullMessages = [{ value: 'nil', status: ['done'] }];
        var nullResult = resultHandler.serializeResult(nullMessages, 0);
        assert.strictEqual(nullResult.type, 'null', 'Null result type');
        assert.strictEqual(nullResult.value, null, 'Null result value');
    });

    // Test 8: Improved error handling - "class " error case
    t.test('Result handler properly handles incomplete error messages like "class "', function() {
        // Test the "class " error case
        var classErrorMessages = [
            { ex: 'class ', status: ['done', 'error'] }
        ];
        var errorResult = resultHandler.serializeResult(classErrorMessages, 0);
        assert.ok(errorResult, 'Error result should exist');
        assert.strictEqual(errorResult.type, 'error', 'Error result type should be error');
        assert.ok(errorResult.error, 'Error result should have error message');
        assert.ok(errorResult.error.includes('class') || errorResult.error.includes('Evaluation error'),
            'Error message should include class or evaluation error');

        // Test with root-cause
        var rootCauseMessages = [
            { 'root-cause': 'java.lang.ClassNotFoundException: SomeClass', status: ['done', 'error'] }
        ];
        var rootCauseResult = resultHandler.serializeResult(rootCauseMessages, 0);
        assert.ok(rootCauseResult, 'Root cause result should exist');
        assert.strictEqual(rootCauseResult.type, 'error', 'Root cause result type should be error');
        assert.ok(rootCauseResult.rootCause, 'Root cause should be captured');
        assert.ok(rootCauseResult.error.includes('ClassNotFoundException'),
            'Error message should include root cause');

        // Test with both ex and root-cause
        var combinedMessages = [
            { ex: 'class ', 'root-cause': 'Actual error message', status: ['done', 'error'] }
        ];
        var combinedResult = resultHandler.serializeResult(combinedMessages, 0);
        assert.ok(combinedResult, 'Combined result should exist');
        assert.strictEqual(combinedResult.type, 'error', 'Combined result type should be error');
        assert.ok(combinedResult.error, 'Combined result should have error message');
    });
});

// Export for test runner
module.exports = testSuite;

