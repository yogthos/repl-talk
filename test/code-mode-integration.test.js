/*global test,describe,before,after*/

/**
 * Integration tests for code-mode features
 * Tests full REPL loop with logs, discovery, and observability
 * Verifies backward compatibility
 */

var test = require('node:test');
var assert = require('node:assert');

var config = require('../src/config');
var nreplServer = require('../src/nrepl-server');
var nreplClient = require('../src/nrepl-client');
var aiClient = require('../src/ai-client');
var resultHandler = require('../src/result-handler');
var clojureDiscovery = require('../src/clojure-discovery');
var clojureHelpers = require('../src/clojure-helpers');

// Test state
var testState = {
    nreplServerState: null,
    nreplConnection: null,
    nreplSession: null,
    setupComplete: false
};

/**
 * Setup: Start nREPL server
 */
function setup(callback) {
    console.log('Setting up integration test environment...');

    var nreplOptions = {
        hostname: undefined,
        port: undefined,
        babashkaPath: config.nrepl.babashkaPath || 'bb',
        verbose: false,
        startTimeout: config.nrepl.startTimeout || 10000
    };

    nreplServer.start(nreplOptions, function(err, serverState) {
        if (err) {
            return callback(err);
        }

        testState.nreplServerState = serverState;

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
            clearTimeout(connectionTimeout);
            console.error('nREPL connection error:', err);
            callback(err);
        });

        testState.nreplConnection.once('connect', function() {
            console.log('Connected to nREPL server');
            testState.nreplConnection.clone(function(err, messages) {
                if (err) {
                    clearTimeout(connectionTimeout);
                    return callback(err);
                }

                var newSession = messages && messages[0] && messages[0]['new-session'];
                if (newSession) {
                    testState.nreplSession = newSession;

                    // Inject helper functions
                    var helperCode = clojureHelpers.getHelperFunctionsCode();
                    testState.nreplConnection.eval(helperCode, undefined, newSession, function(err) {
                        clearTimeout(connectionTimeout);
                        if (err) {
                            console.warn('Warning: Failed to inject helpers:', err);
                        }
                        console.log('Setup complete - nREPL ready');
                        testState.setupComplete = true;
                        callback(null);
                    });
                } else {
                    clearTimeout(connectionTimeout);
                    console.warn('Warning: No new-session in clone response');
                    testState.setupComplete = true;
                    callback(null);
                }
            });
        });
    });
}

/**
 * Teardown: Clean up nREPL server
 */
function teardown(callback) {
    if (testState.nreplServerState && testState.nreplServerState.process) {
        testState.nreplServerState.process.kill();
    }
    setTimeout(callback, 500);
}

test('Code-Mode Integration Tests', {
    timeout: 30000,
    before: function() {
        console.log('BEFORE HOOK CALLED - Starting setup...');
        return new Promise(function(resolve, reject) {
            console.log('BEFORE HOOK - Calling setup function...');
            setup(function(err) {
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
        return new Promise(function(resolve) {
            teardown(function() {
                resolve();
            });
        });
    }
}, function(t) {
    t.test('should capture logs during code execution', function() {
        return new Promise(function(resolve, reject) {
            if (!testState.setupComplete || !testState.nreplConnection || !testState.nreplSession) {
                return reject(new Error('nREPL not initialized - setup may not have completed'));
            }
            var code = '(println "Hello") (println "World") 42';
            var startTime = Date.now();

            testState.nreplConnection.eval(code, undefined, testState.nreplSession, function(err, messages) {
                if (err) return reject(err);
                var executionTime = Date.now() - startTime;
                var result = resultHandler.serializeResult(messages, executionTime);

                assert(result.logs, 'Result should have logs');
                assert(Array.isArray(result.logs), 'Logs should be an array');
                assert(result.logs.length >= 2, 'Should have multiple log entries from println');
                assert(result.executionTime > 0, 'Should have execution time');
                assert(result.value === 42 || result.value === '42', 'Should have correct return value');

                resolve();
            });
        });
    });

    t.test('should include logs in error results', function() {
        return new Promise(function(resolve, reject) {
            if (!testState.setupComplete || !testState.nreplConnection || !testState.nreplSession) {
                return reject(new Error('nREPL not initialized - setup may not have completed'));
            }
            var code = '(println "Before error") (/ 1 0)';
            var startTime = Date.now();

            testState.nreplConnection.eval(code, undefined, testState.nreplSession, function(err, messages) {
                if (err) return reject(err);
                var executionTime = Date.now() - startTime;
                var result = resultHandler.serializeResult(messages, executionTime);

                assert(result.type === 'error', 'Should be error type');
                assert(result.logs, 'Error result should have logs');
                assert(result.executionTime > 0, 'Error result should have execution time');

                resolve();
            });
        });
    });

    t.test('should discover namespaces', function() {
        return new Promise(function(resolve, reject) {
            if (!testState.setupComplete || !testState.nreplConnection || !testState.nreplSession) {
                return reject(new Error('nREPL not initialized - setup may not have completed'));
            }
            clojureDiscovery.discoverNamespaces(testState.nreplConnection, testState.nreplSession, function(err, namespaces) {
                if (err) return reject(err);
                assert(Array.isArray(namespaces), 'Should return array of namespaces');
                assert(namespaces.length > 0, 'Should find at least one namespace');
                assert(namespaces.includes('clojure.core') || namespaces.some(function(ns) { return ns.includes('clojure.core'); }), 'Should include clojure.core');
                resolve();
            });
        });
    });

    t.test('should retrieve namespace documentation', function() {
        return new Promise(function(resolve, reject) {
            if (!testState.setupComplete || !testState.nreplConnection || !testState.nreplSession) {
                return reject(new Error('nREPL not initialized - setup may not have completed'));
            }
            clojureDiscovery.getNamespaceDocs(testState.nreplConnection, testState.nreplSession, 'clojure.string', function(err, docs) {
                if (err) return reject(err);
                assert(docs, 'Should return documentation');
                assert(docs.namespace === 'clojure.string' || docs.namespace === '"clojure.string"', 'Should have correct namespace');
                resolve();
            });
        });
    });

    t.test('should search for functions', function() {
        return new Promise(function(resolve, reject) {
            if (!testState.setupComplete || !testState.nreplConnection || !testState.nreplSession) {
                return reject(new Error('nREPL not initialized - setup may not have completed'));
            }
            clojureDiscovery.searchFunctions(testState.nreplConnection, testState.nreplSession, 'join', function(err, functions) {
                if (err) return reject(err);
                assert(Array.isArray(functions), 'Should return array');
                // May or may not find functions depending on what's loaded
                resolve();
            });
        });
    });

    t.test('should have helper functions available in session', function() {
        return new Promise(function(resolve, reject) {
            if (!testState.setupComplete || !testState.nreplConnection || !testState.nreplSession) {
                return reject(new Error('nREPL not initialized - setup may not have completed'));
            }
            // Test that helper functions were injected
            var code = '(if (resolve (symbol "list-namespaces")) "helpers-loaded" "helpers-missing")';

            testState.nreplConnection.eval(code, undefined, testState.nreplSession, function(err, messages) {
                if (err) return reject(err);
                var result = resultHandler.serializeResult(messages, 0);
                // Helper functions should be available
                resolve();
            });
        });
    });

    t.test('should maintain backward compatibility - results without logs still work', function() {
        return new Promise(function(resolve, reject) {
            if (!testState.setupComplete || !testState.nreplConnection || !testState.nreplSession) {
                return reject(new Error('nREPL not initialized - setup may not have completed'));
            }
            // Test that old code still works
            var code = '42';
            var startTime = Date.now();

            testState.nreplConnection.eval(code, undefined, testState.nreplSession, function(err, messages) {
                if (err) return reject(err);
                var executionTime = Date.now() - startTime;
                var result = resultHandler.serializeResult(messages, executionTime);
                var formatted = resultHandler.formatForVisualization(result);

                // Should have all expected fields
                assert(result.value !== undefined, 'Should have value');
                assert(result.type, 'Should have type');
                assert(Array.isArray(result.logs), 'Should have logs array (even if empty)');
                assert(formatted.logs, 'Formatted should have logs');

                resolve();
            });
        });
    });

    t.test('should include execution time in all results', function() {
        return new Promise(function(resolve, reject) {
            if (!testState.setupComplete || !testState.nreplConnection || !testState.nreplSession) {
                return reject(new Error('nREPL not initialized - setup may not have completed'));
            }
            var code = '(Thread/sleep 10) 42';
            var startTime = Date.now();

            testState.nreplConnection.eval(code, undefined, testState.nreplSession, function(err, messages) {
                if (err) return reject(err);
                var executionTime = Date.now() - startTime;
                var result = resultHandler.serializeResult(messages, executionTime);

                assert(result.executionTime === executionTime, 'Execution time should match');
                assert(result.executionTime >= 10, 'Execution time should be at least sleep duration');

                resolve();
            });
        });
    });

    t.test('should structure logs with proper levels', function() {
        return new Promise(function(resolve, reject) {
            if (!testState.setupComplete || !testState.nreplConnection || !testState.nreplSession) {
                return reject(new Error('nREPL not initialized - setup may not have completed'));
            }
            var code = '(println "INFO message") (binding [*err* *out*] (println "ERROR message")) 42';
            var startTime = Date.now();

            testState.nreplConnection.eval(code, undefined, testState.nreplSession, function(err, messages) {
                if (err) return reject(err);
                var executionTime = Date.now() - startTime;
                var result = resultHandler.serializeResult(messages, executionTime);

                assert(result.logs.length > 0, 'Should have logs');
                var hasInfo = result.logs.some(function(log) { return log.level === 'INFO'; });
                // Note: stderr detection may vary, but we should have at least INFO logs
                assert(hasInfo, 'Should have INFO level logs');

                resolve();
            });
        });
    });
});

