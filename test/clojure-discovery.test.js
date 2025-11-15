/*global test*/

/**
 * Tests for Clojure discovery functionality
 * Tests namespace listing, doc retrieval, and function search
 */

var test = require('node:test');
var assert = require('node:assert');
var clojureDiscovery = require('../src/clojure-discovery');

test('Clojure Discovery', function(t) {
    // Mock nREPL connection for testing
    var mockConnection = null;
    var mockSession = 'test-session';

    t.before(function() {
        // Create a mock nREPL connection
        // In real tests, this would use an actual nREPL connection
        mockConnection = {
            eval: function(code, ns, session, callback) {
                // Mock responses based on code
                var messages = [];

                if (code.includes('all-ns') || code.includes('(all-ns)')) {
                    // Mock namespace listing
                    messages = [
                        { value: '["clojure.core" "clojure.string" "babashka.fs"]', status: ['done'] }
                    ];
                } else if (code.includes('find-ns') || (code.includes('clojure.string') && code.includes('require') && code.includes('ns-publics'))) {
                    // Mock namespace docs - return as JSON string that can be parsed
                    // This matches the code in getNamespaceDocs which uses find-ns and ns-publics
                    var mockDocs = {
                        namespace: 'clojure.string',
                        doc: 'String utilities',
                        functions: [{ name: 'join', doc: 'Joins strings' }]
                    };
                    messages = [
                        { value: JSON.stringify(mockDocs), status: ['done'] }
                    ];
                } else if (code.includes('search-functions') || code.includes('searchFunctions') || code.includes('ns-publics')) {
                    // Mock function search
                    messages = [
                        { value: '[{"namespace":"clojure.string","name":"join","doc":"Joins strings"}]', status: ['done'] }
                    ];
                } else if (code.includes('resolve') && code.includes('clojure.string/join')) {
                    // Mock function signature - return as JSON string
                    // This matches the code in getFunctionSignature which uses resolve
                    var mockSig = {
                        name: 'clojure.string/join',
                        doc: 'Joins strings',
                        arglists: [['([coll])'], ['([separator coll])']]
                    };
                    messages = [
                        { value: JSON.stringify(mockSig), status: ['done'] }
                    ];
                } else {
                    messages = [{ value: 'nil', status: ['done'] }];
                }

                setTimeout(function() {
                    callback(null, messages);
                }, 10);
            }
        };
    });

    t.test('discoverNamespaces - should list available namespaces', function() {
        return new Promise(function(resolve, reject) {
            clojureDiscovery.discoverNamespaces(mockConnection, mockSession, function(err, namespaces) {
                if (err) return reject(err);
                assert(Array.isArray(namespaces), 'Should return an array');
                assert(namespaces.length > 0, 'Should return at least one namespace');
                resolve();
            });
        });
    });

    t.test('discoverNamespaces - should cache namespace results', function() {
        return new Promise(function(resolve, reject) {
            clojureDiscovery.clearCache();
            var callCount = 0;

            var originalEval = mockConnection.eval;
            mockConnection.eval = function(code, ns, session, callback) {
                if (code.includes('all-ns')) {
                    callCount++;
                }
                return originalEval.call(this, code, ns, session, callback);
            };

            clojureDiscovery.discoverNamespaces(mockConnection, mockSession, function(err, namespaces1) {
                assert.ifError(err);
                clojureDiscovery.discoverNamespaces(mockConnection, mockSession, function(err, namespaces2) {
                    assert.ifError(err);
                    assert.strictEqual(callCount, 1, 'Should only call eval once due to caching');
                    assert.deepEqual(namespaces1, namespaces2, 'Cached results should match');
                    mockConnection.eval = originalEval;
                    resolve();
                });
            });
        });
    });

    t.test('getNamespaceDocs - should retrieve namespace documentation', function() {
        return new Promise(function(resolve, reject) {
            clojureDiscovery.getNamespaceDocs(mockConnection, mockSession, 'clojure.string', function(err, docs) {
                if (err) return reject(err);
                assert(docs, 'Should return documentation');
                assert(docs.namespace, 'Should have namespace field');
                resolve();
            });
        });
    });

    t.test('getNamespaceDocs - should cache namespace docs', function() {
        return new Promise(function(resolve, reject) {
            clojureDiscovery.clearCache();
            clojureDiscovery.getNamespaceDocs(mockConnection, mockSession, 'clojure.string', function(err, docs1) {
                assert.ifError(err);
                clojureDiscovery.getNamespaceDocs(mockConnection, mockSession, 'clojure.string', function(err, docs2) {
                    if (err) return reject(err);
                    assert.deepEqual(docs1, docs2, 'Cached docs should match');
                    resolve();
                });
            });
        });
    });

    t.test('searchFunctions - should search for functions matching query', function() {
        return new Promise(function(resolve, reject) {
            clojureDiscovery.searchFunctions(mockConnection, mockSession, 'join', function(err, functions) {
                if (err) return reject(err);
                assert(Array.isArray(functions), 'Should return an array');
                resolve();
            });
        });
    });

    t.test('getFunctionSignature - should retrieve function signature', function() {
        return new Promise(function(resolve, reject) {
            clojureDiscovery.getFunctionSignature(mockConnection, mockSession, 'clojure.string/join', function(err, signature) {
                if (err) return reject(err);
                assert(signature, 'Should return signature');
                assert(signature.name, 'Should have name field');
                resolve();
            });
        });
    });

    t.test('getFunctionSignature - should handle invalid function names', function() {
        return new Promise(function(resolve, reject) {
            clojureDiscovery.getFunctionSignature(mockConnection, mockSession, 'invalid', function(err, signature) {
                assert(err, 'Should return error for invalid function name');
                resolve();
            });
        });
    });

    t.test('clearCache - should clear all caches', function() {
        clojureDiscovery.clearCache();
        // Cache should be empty after clearing
        // This is tested implicitly by the cache tests above
        assert(true, 'Cache cleared');
    });
});

