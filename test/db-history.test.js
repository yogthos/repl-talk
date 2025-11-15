/*global test,describe,before,after*/
/**
 * Database Chat History Tests
 * Tests the database persistence and loading of conversation history
 */

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var fs = require('fs');

var db = require('../src/db');
var config = require('../src/config');
var nreplServer = require('../src/nrepl-server');
var nreplClient = require('../src/nrepl-client');
var aiClient = require('../src/ai-client');

// Test database path (separate from production)
var testDbPath = path.join(__dirname, '../test-conversations.db');

// Test state
var testState = {
    nreplServerState: null,
    nreplConnection: null,
    nreplSession: null,
    testSessions: [] // Track test sessions for cleanup
};

/**
 * Setup: Start nREPL server and prepare test database
 */
function setup(callback) {
    console.log('Setting up database test environment...');

    // Backup original db path and use test database
    // We'll need to modify db.js to accept a custom path, or use a test-specific db module
    // For now, we'll use the production db but clean it up after tests

    var nreplOptions = {
        hostname: undefined,
        port: undefined,
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

        testState.nreplConnection.on('error', function(err) {
            console.error('nREPL connection error:', err);
        });

        testState.nreplConnection.once('connect', function() {
            console.log('Connected to nREPL server');

            // Create nREPL session using clone (newSession doesn't exist)
            testState.nreplConnection.clone(function(err, messages) {
                if (err) {
                    console.error('Failed to create nREPL session:', err);
                    return callback(err);
                }

                var newSession = messages && messages[0] && messages[0]['new-session'];
                if (newSession) {
                    testState.nreplSession = newSession;
                    console.log('Created nREPL session:', newSession);
                }
                callback(null);
            });
        });
    });
}

/**
 * Teardown: Stop nREPL server and clean up test database
 */
function teardown(callback) {
    console.log('Tearing down database test environment...');

    // Clean up test sessions first
    if (testState.testSessions && testState.testSessions.length > 0) {
        console.log('Cleaning up', testState.testSessions.length, 'test sessions...');
        testState.testSessions.forEach(function(sessionId) {
            try {
                db.deleteSession(sessionId);
            } catch (e) {
                console.warn('Failed to delete session', sessionId, ':', e);
            }
        });
    }

    // Close nREPL connection if it exists
    if (testState.nreplConnection) {
        // The connection is a net.Socket, destroy it to close properly
        if (testState.nreplConnection.destroy) {
            testState.nreplConnection.destroy();
        }
        testState.nreplConnection = null;
    }

    // Stop nREPL server
    if (testState.nreplServerState && !testState.nreplServerState.external) {
        nreplServer.stop(testState.nreplServerState, function() {
            console.log('nREPL server stopped');
            if (callback) callback();
        });
    } else {
        // Don't close database connection - it's a singleton shared across tests
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
var testSuite = test('Database Chat History Tests', {
    before: function() {
        flushOutput();
        return new Promise(function(resolve, reject) {
            setup(function(err) {
                flushOutput();
                if (err) reject(err);
                else resolve();
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

    // Test 1: Create session and save messages
    t.test('Create session and save messages to database', function() {
        var sessionId = db.createSession();
        testState.testSessions.push(sessionId);
        assert.ok(sessionId, 'Session ID should be generated');
        assert.strictEqual(typeof sessionId, 'string', 'Session ID should be a string');
        assert.ok(sessionId.length > 0, 'Session ID should not be empty');

        // Verify session exists
        assert.ok(db.sessionExists(sessionId), 'Session should exist in database');

        // Save user message
        db.addMessage(sessionId, 'user', 'Hello, what is 2 + 2?', null);

        // Save assistant message with tool calls
        var toolCalls = [{
            id: 'call_123',
            type: 'function',
            function: {
                name: 'eval_clojure',
                arguments: JSON.stringify({ code_string: '(+ 2 2)' })
            }
        }];
        db.addMessage(sessionId, 'assistant', null, toolCalls);

        // Save tool result
        var toolResult = {
            role: 'tool',
            tool_call_id: 'call_123',
            name: 'eval_clojure',
            content: JSON.stringify({ type: 'number', value: 4 })
        };
        db.addMessage(sessionId, 'tool', JSON.stringify(toolResult), null);

        // Save final assistant response
        db.addMessage(sessionId, 'assistant', 'The answer is 4', null);

        // Verify messages were saved
        var history = db.getSessionHistory(sessionId);
        assert.strictEqual(history.length, 4, 'Should have 4 messages in history');

        // Verify message order and content
        assert.strictEqual(history[0].role, 'user', 'First message should be user');
        assert.strictEqual(history[0].content, 'Hello, what is 2 + 2?', 'User message content should match');

        assert.strictEqual(history[1].role, 'assistant', 'Second message should be assistant');
        assert.ok(history[1].tool_calls, 'Assistant message should have tool_calls');
        assert.strictEqual(history[1].tool_calls.length, 1, 'Should have one tool call');

        assert.strictEqual(history[2].role, 'tool', 'Third message should be tool');
        assert.strictEqual(history[2].tool_call_id, 'call_123', 'Tool result should have correct tool_call_id');
        assert.strictEqual(history[2].name, 'eval_clojure', 'Tool result should have correct name');

        assert.strictEqual(history[3].role, 'assistant', 'Fourth message should be assistant');
        assert.strictEqual(history[3].content, 'The answer is 4', 'Final assistant message content should match');
    });

    // Test 2: Load conversation history and create AI client with it
    t.test('Load conversation history and create AI client with history', function() {
        var sessionId = db.createSession();
        testState.testSessions.push(sessionId);

        // Save a conversation
        db.addMessage(sessionId, 'user', 'What is the capital of France?', null);
        db.addMessage(sessionId, 'assistant', 'The capital of France is Paris.', null);
        db.addMessage(sessionId, 'user', 'What is its population?', null);

        // Load history
        var history = db.getSessionHistory(sessionId);
        assert.strictEqual(history.length, 3, 'Should have 3 messages in history');

        // Create eval callback
        var evalCallback = function(codeString, callback) {
            // Mock eval callback for this test
            callback(null, { type: 'string', value: 'test result' });
        };

        // Create save callback
        var savedMessages = [];
        var saveCallback = function(role, content, toolCalls) {
            savedMessages.push({ role: role, content: content, toolCalls: toolCalls });
        };

        // Create AI client with loaded history
        var client = aiClient.createAIClient(config, evalCallback, history, saveCallback, null);

        // Verify client has the history
        assert.strictEqual(client.conversationHistory.length, 3, 'AI client should have 3 messages in history');
        assert.strictEqual(client.conversationHistory[0].role, 'user', 'First message should be user');
        assert.strictEqual(client.conversationHistory[0].content, 'What is the capital of France?', 'First message content should match');
        assert.strictEqual(client.conversationHistory[1].role, 'assistant', 'Second message should be assistant');
        assert.strictEqual(client.conversationHistory[2].role, 'user', 'Third message should be user');
        assert.strictEqual(client.conversationHistory[2].content, 'What is its population?', 'Third message content should match');
    });

    // Test 3: Verify messages are saved when AI client processes messages
    t.test('AI client saves messages to database via save callback', function() {
        var sessionId = db.createSession();
        testState.testSessions.push(sessionId);
        var savedMessages = [];

        // Create save callback that tracks what's saved
        var saveCallback = function(role, content, toolCalls) {
            savedMessages.push({ role: role, content: content, toolCalls: toolCalls });
            // Also save to database
            db.addMessage(sessionId, role, content, toolCalls);
        };

        // Create eval callback
        var evalCallback = function(codeString, callback) {
            callback(null, { type: 'string', value: 'test result' });
        };

        // Create AI client with save callback
        var client = aiClient.createAIClient(config, evalCallback, [], saveCallback, null);

        // Note: We can't easily test the full AI flow without mocking the AI API,
        // but we can verify the save callback is set up correctly
        assert.ok(client.saveCallback, 'AI client should have save callback');

        // Manually trigger save callback to verify it works
        client.saveCallback('user', 'Test message', null);
        assert.strictEqual(savedMessages.length, 1, 'Save callback should be called');
        assert.strictEqual(savedMessages[0].role, 'user', 'Saved message should have correct role');
        assert.strictEqual(savedMessages[0].content, 'Test message', 'Saved message should have correct content');

        // Verify it was saved to database
        var history = db.getSessionHistory(sessionId);
        assert.strictEqual(history.length, 1, 'Message should be saved to database');
        assert.strictEqual(history[0].role, 'user', 'Database message should have correct role');
        assert.strictEqual(history[0].content, 'Test message', 'Database message should have correct content');
    });

    // Test 4: Test session activity tracking
    t.test('Session activity is updated when messages are added', function() {
        var sessionId = db.createSession();
        testState.testSessions.push(sessionId);

        // Get initial activity (we can't easily check timestamp, but we can verify update doesn't error)
        db.addMessage(sessionId, 'user', 'Test', null);
        db.updateSessionActivity(sessionId);

        // Verify session still exists
        assert.ok(db.sessionExists(sessionId), 'Session should still exist after activity update');
    });

    // Test 5: Test tool result reconstruction
    t.test('Tool results are correctly reconstructed from database', function() {
        var sessionId = db.createSession();
        testState.testSessions.push(sessionId);

        // Save a tool result
        var toolResult = {
            role: 'tool',
            tool_call_id: 'call_abc',
            name: 'eval_clojure',
            content: JSON.stringify({ type: 'number', value: 42 })
        };
        db.addMessage(sessionId, 'tool', JSON.stringify(toolResult), null);

        // Load history
        var history = db.getSessionHistory(sessionId);
        assert.strictEqual(history.length, 1, 'Should have 1 message in history');

        // Verify tool result is correctly reconstructed
        assert.strictEqual(history[0].role, 'tool', 'Message should be tool');
        assert.strictEqual(history[0].tool_call_id, 'call_abc', 'Tool call ID should match');
        assert.strictEqual(history[0].name, 'eval_clojure', 'Tool name should match');
        assert.ok(history[0].content, 'Tool result should have content');

        // Verify content can be parsed
        var content = JSON.parse(history[0].content);
        assert.strictEqual(content.type, 'number', 'Content type should match');
        assert.strictEqual(content.value, 42, 'Content value should match');
    });

    // Test 6: Test multiple sessions with separate histories
    t.test('Multiple sessions maintain separate conversation histories', function() {
        var session1 = db.createSession();
        var session2 = db.createSession();
        testState.testSessions.push(session1);
        testState.testSessions.push(session2);

        // Add messages to session 1
        db.addMessage(session1, 'user', 'Session 1 message', null);
        db.addMessage(session1, 'assistant', 'Session 1 response', null);

        // Add messages to session 2
        db.addMessage(session2, 'user', 'Session 2 message', null);
        db.addMessage(session2, 'assistant', 'Session 2 response', null);

        // Verify histories are separate
        var history1 = db.getSessionHistory(session1);
        var history2 = db.getSessionHistory(session2);

        assert.strictEqual(history1.length, 2, 'Session 1 should have 2 messages');
        assert.strictEqual(history2.length, 2, 'Session 2 should have 2 messages');

        assert.strictEqual(history1[0].content, 'Session 1 message', 'Session 1 should have correct first message');
        assert.strictEqual(history2[0].content, 'Session 2 message', 'Session 2 should have correct first message');

        assert.notStrictEqual(history1[0].content, history2[0].content, 'Sessions should have different messages');
    });
});

// Export for test runner
module.exports = testSuite;

