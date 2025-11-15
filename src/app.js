/*global console,require,process,__dirname*/

/**
 * Main application entry point
 * Orchestrates nREPL server, AI client, and web interface
 * Implements the 8-step loop from PLAN.md
 */

var express = require('express');
var WebSocket = require('ws');
var http = require('http');
var path = require('path');

var config = require('./config');
var nreplServer = require('./nrepl-server');
var nreplClient = require('./nrepl-client');
var aiClient = require('./ai-client');
var resultHandler = require('./result-handler');
var db = require('./db');
var codeValidator = require('./code-validator');
var clojureHelpers = require('./clojure-helpers');

// Application state
var appState = {
    nreplServerState: null,
    nreplConnection: null,
    nreplSession: null,
    aiClients: {}, // Map of sessionId -> aiClient
    pendingCodeExecutions: {}, // Map of messageId -> {code, callback, toolCall, ws}
    wss: null,
    httpServer: null
};

/**
 * Step 1: Initialize - Connect to nREPL, register eval_clojure tool
 */
function initialize(callback) {
    console.log('Initializing Babashka nREPL connection...');

    var nreplOptions = {
        hostname: config.nrepl.hostname,
        port: config.nrepl.port,
        babashkaPath: config.nrepl.babashkaPath,
        verbose: config.nrepl.verbose,
        startTimeout: config.nrepl.startTimeout
    };

    // Start or connect to nREPL server
    nreplServer.start(nreplOptions, function(err, serverState) {
        if (err) {
            console.error('Failed to start nREPL server:', err);
            return callback(err);
        }

        appState.nreplServerState = serverState;
        console.log('nREPL server ready at', serverState.hostname + ':' + serverState.port);

        // Connect nREPL client
        var clientOptions = {
            host: serverState.hostname || 'localhost',
            port: serverState.port,
            verbose: config.nrepl.verbose
        };

        appState.nreplConnection = nreplClient.connect(clientOptions);

        appState.nreplConnection.on('error', function(err) {
            console.error('nREPL connection error:', err);
            broadcastToClients({ type: 'error', message: 'nREPL connection error: ' + err.message });
        });

        appState.nreplConnection.once('connect', function() {
            console.log('Connected to nREPL server');

            // Create a session
            appState.nreplConnection.clone(function(err, messages) {
                if (err) {
                    console.error('Failed to create nREPL session:', err);
                    return callback(err);
                }

                var newSession = messages && messages[0] && messages[0]['new-session'];
                if (newSession) {
                    appState.nreplSession = newSession;
                    console.log('Created nREPL session:', newSession);

                    // Inject helper functions into the session
                    var helperCode = clojureHelpers.getHelperFunctionsCode();
                    appState.nreplConnection.eval(helperCode, 'user', newSession, function(err, helperMessages) {
                        if (err) {
                            console.warn('Warning: Failed to inject helper functions:', err);
                        } else {
                            console.log('Helper functions injected into nREPL session');
                        }

                        // Note: AI clients are now created per-session in handleUserMessage
                        // We no longer create a global AI client here

                        broadcastToClients({ type: 'connection', message: 'Connected to nREPL' });
                        callback(null);
                    });
                } else {
                    broadcastToClients({ type: 'connection', message: 'Connected to nREPL' });
                    callback(null);
                }
            });
        });
    });
}

/**
 * Eval callback for AI client - executes Clojure code via nREPL
 * Validates code with clj-kondo before execution if validation is enabled
 */
function evalClojure(codeString, callback) {
    if (!appState.nreplConnection || !appState.nreplSession) {
        return callback(new Error('nREPL not connected'), null);
    }

    console.log('Evaluating Clojure code:', codeString);

    // Validate code before execution if validation is enabled
    if (config.codeValidation.enabled) {
        codeValidator.validateCode(codeString, config.codeValidation.cljKondoPath, function(validateErr, validateResult) {
            if (validateErr) {
                // Validation process failed (e.g., clj-kondo not found)
                // Log warning but continue with execution (graceful degradation)
                console.warn('Code validation failed:', validateErr.message);
                console.warn('Proceeding with execution without validation');
                executeCode();
            } else if (!validateResult.valid) {
                // Validation found errors - return them in structured format
                console.log('Code validation found errors:', validateResult.errors);

                // Format validation errors similar to execution errors
                var errorMessages = validateResult.errors.map(function(err) {
                    return 'Line ' + err.row + ', Col ' + err.col + ': ' + err.message + ' (' + err.level + ')';
                }).join('\n');

                var validationError = {
                    type: 'error',
                    error: 'Code validation failed:\n' + errorMessages,
                    validationErrors: validateResult.errors,
                    errorDetails: {
                        message: 'Code validation detected errors before execution. Please fix the following issues:',
                        validationErrors: validateResult.errors,
                        hint: 'Review the validation errors and correct the code syntax, types, or structure.'
                    }
                };

                var formatted = resultHandler.formatForVisualization(validationError);
                callback(null, formatted);
            } else {
                // Validation passed (or was skipped) - proceed with execution
                if (validateResult.skipped) {
                    console.log('Code validation skipped:', validateResult.reason);
                } else {
                    console.log('Code validation passed');
                }
                executeCode();
            }
        });
    } else {
        // Validation disabled - proceed directly to execution
        executeCode();
    }

    function executeCode() {
        var startTime = Date.now();
        appState.nreplConnection.eval(codeString, undefined, appState.nreplSession, function(err, messages) {
            if (err) {
                console.error('nREPL eval error:', err);
                return callback(err, null);
            }

            var executionTime = Date.now() - startTime;

            // Serialize result with execution time
            var result = resultHandler.serializeResult(messages, executionTime);
            var formatted = resultHandler.formatForVisualization(result);

            console.log('Evaluation result:', formatted);
            if (formatted.logs && formatted.logs.length > 0) {
                console.log('Execution logs:', formatted.logs.length, 'entries');
            }

            // Do NOT broadcast tool results to canvas - only final AI responses should be displayed
            // Tool results are passed to AI client callback for processing into final HTML response

            callback(null, formatted);
        });
    }
}

/**
 * Handle code approval from user
 */
function handleCodeApproval(messageId, editedCode, ws) {
    console.log('Code approved for message:', messageId);

    var pending = appState.pendingCodeExecutions[messageId];
    if (!pending) {
        console.error('No pending code execution found for message:', messageId);
        sendToClient(ws, { type: 'error', message: 'No pending code execution found' });
        return;
    }

    // Use edited code if provided, otherwise fall back to original code
    var code = editedCode || pending.code;
    var callback = pending.callback;

    if (editedCode && editedCode !== pending.code) {
        console.log('Executing edited code (user modified):', code);
        console.log('Original code was:', pending.code);
    } else {
        console.log('Executing approved code (original):', code);
    }

    evalClojure(code, function(err, result) {
        // Clean up pending execution
        delete appState.pendingCodeExecutions[messageId];

        // If result is an error, notify the client that AI will iterate
        if (result && result.type === 'error') {
            sendToClient(ws, {
                type: 'status',
                message: 'Code execution encountered an error. AI is analyzing and generating a fix...'
            });
        }

        // Call the original callback
        callback(err, result);
    });
}

/**
 * Handle code rejection from user
 */
function handleCodeRejection(messageId, ws) {
    console.log('Code rejected for message:', messageId);

    var pending = appState.pendingCodeExecutions[messageId];
    if (!pending) {
        console.error('No pending code execution found for message:', messageId);
        return;
    }

    // Call callback with error
    var callback = pending.callback;
    delete appState.pendingCodeExecutions[messageId];

    callback(new Error('Code execution cancelled by user'), null);
}

/**
 * Step 2-8: Handle user prompt through the 8-step loop
 */
function handleUserMessage(userMessage, modelType, ws) {
    console.log('User message:', userMessage);
    console.log('Using model:', modelType || config.ai.defaultModel);

    var sessionId = ws.sessionId;
    if (!sessionId) {
        console.error('No session ID found for WebSocket connection');
        sendToClient(ws, { type: 'error', message: 'Session not found' });
        return;
    }

    // Get or create AI client for this session
    var client = appState.aiClients[sessionId];
    if (!client) {
        // Load conversation history from database
        var history = db.getSessionHistory(sessionId);
        console.log('Loaded', history.length, 'messages from history for session', sessionId);

        // Create save callback to persist messages to database
        var saveCallback = function(role, content, toolCalls) {
            db.addMessage(sessionId, role, content, toolCalls);
        };

        // Create status callback to send status updates to user
        var statusCallback = function(statusMessage) {
            sendToClient(ws, {
                type: 'status',
                message: statusMessage
            });
        };

        // Create wrapped eval callback that requests user approval
        var evalCallbackWithApproval = function(code, callback) {
            // Generate unique message ID for this code execution
            var messageId = 'code_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

            // Store pending execution
            appState.pendingCodeExecutions[messageId] = {
                code: code,
                callback: callback,
                ws: ws
            };

            // Send code preview to client
            sendToClient(ws, {
                type: 'code_preview',
                code: code,
                messageId: messageId
            });

            // The callback will be called when user approves/rejects
        };

        // Create AI client with loaded history, save callback, and status callback
        client = aiClient.createAIClient(config, evalCallbackWithApproval, history, saveCallback, statusCallback);
        appState.aiClients[sessionId] = client;
    }

    // Step 2: Prompt - User gives task (already received)
    // Step 3: Decide - AI analyzes and generates Clojure code (handled by AI client)
    // Step 4: Request - AI calls eval_clojure (handled by AI client)
    // Step 5: Execute - nREPL evaluates code (handled by evalClojure)
    // Step 6: Respond - Serialize result and return to AI (handled by evalClojure callback)
    // Step 7: Update - Add result to conversation context (handled by AI client)
    // Step 8: Answer - AI synthesizes final response (handled by AI client)

    client.sendMessage(userMessage, modelType, function(err, response) {
        if (err) {
            console.error('AI client error:', err);
            sendToClient(ws, { type: 'error', message: err.message || String(err) });
            return;
        }

        // IMPORTANT: This callback only fires for FINAL responses (not intermediate tool calls)
        // The ai-client already filters out intermediate messages with tool_calls

        if (response) {
            // If response contains HTML, send it to canvas for visualization
            if (response.type === 'html' && response.html) {
                console.log('Sending HTML result to canvas, length:', response.html.length);
                sendToClient(ws, {
                    type: 'result',
                    data: {
                        type: 'html',
                        html: response.html,
                        content: response.content
                    }
                });
            } else if (response.content) {
                // Regular text response goes to chat
                // Note: With the updated system prompt, final responses should be HTML
                // This path is mainly for error cases or non-HTML responses
                console.log('Sending text response to chat');
                sendToClient(ws, { type: 'ai_response', content: response.content });
            } else {
                // Edge case: empty response
                console.log('Received empty response from AI client');
            }
        }
    });
}

/**
 * Broadcast message to all connected WebSocket clients
 */
function broadcastToClients(message) {
    if (appState.wss) {
        appState.wss.clients.forEach(function(client) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(message));
            }
        });
    }
}

/**
 * Send message to specific WebSocket client
 */
function sendToClient(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

/**
 * Setup Express server and WebSocket
 */
function setupWebServer() {
    var app = express();

    // Serve static files
    app.use(express.static(path.join(__dirname, '../public')));

    // Create HTTP server
    appState.httpServer = http.createServer(app);

    // Create WebSocket server
    appState.wss = new WebSocket.Server({ server: appState.httpServer });

    appState.wss.on('connection', function(ws) {
        console.log('WebSocket client connected');

        // Generate and store session ID for this WebSocket connection
        var sessionId = db.createSession();
        ws.sessionId = sessionId;
        console.log('Created session:', sessionId);

        sendToClient(ws, { type: 'status', message: 'Connected to server' });

        ws.on('message', function(message) {
            try {
                var data = JSON.parse(message);

                switch (data.type) {
                    case 'user_message':
                        handleUserMessage(data.message, data.model, ws);
                        break;
                    case 'code_approved':
                        handleCodeApproval(data.messageId, data.code, ws);
                        break;
                    case 'code_rejected':
                        handleCodeRejection(data.messageId, ws);
                        break;
                    default:
                        console.log('Unknown message type:', data.type);
                }
            } catch (err) {
                console.error('Error parsing WebSocket message:', err);
                sendToClient(ws, { type: 'error', message: 'Invalid message format' });
            }
        });

        ws.on('close', function() {
            console.log('WebSocket client disconnected, session:', ws.sessionId);

            // Clean up pending code executions for this WebSocket
            Object.keys(appState.pendingCodeExecutions).forEach(function(messageId) {
                if (appState.pendingCodeExecutions[messageId].ws === ws) {
                    console.log('Cleaning up pending execution:', messageId);
                    var pending = appState.pendingCodeExecutions[messageId];
                    // Call callback with error
                    pending.callback(new Error('Connection closed'), null);
                    delete appState.pendingCodeExecutions[messageId];
                }
            });

            // Clean up AI client for this session from memory
            if (ws.sessionId && appState.aiClients[ws.sessionId]) {
                delete appState.aiClients[ws.sessionId];
            }
            // Note: We keep the session in the database for history
            // Uncomment the line below if you want to delete sessions on disconnect:
            // db.deleteSession(ws.sessionId);
        });

        ws.on('error', function(err) {
            console.error('WebSocket error:', err);
        });
    });

    // Start HTTP server
    var port = config.server.port;
    var host = config.server.host;

    appState.httpServer.listen(port, host, function() {
        console.log('Web server started at http://' + host + ':' + port);
    });
}

/**
 * Cleanup on shutdown
 */
function cleanup(callback) {
    console.log('Cleaning up...');

    if (appState.wss) {
        appState.wss.close(function() {
            console.log('WebSocket server closed');
        });
    }

    if (appState.httpServer) {
        appState.httpServer.close(function() {
            console.log('HTTP server closed');
        });
    }

    if (appState.nreplConnection) {
        appState.nreplConnection.end();
        console.log('nREPL connection closed');
    }

    // Close database connection
    db.close();
    console.log('Database connection closed');

    if (appState.nreplServerState && !appState.nreplServerState.external) {
        nreplServer.stop(appState.nreplServerState, function() {
            console.log('nREPL server stopped');
            if (callback) callback();
        });
    } else {
        if (callback) callback();
    }
}

// Handle graceful shutdown
process.on('SIGINT', function() {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    cleanup(function() {
        process.exit(0);
    });
});

process.on('SIGTERM', function() {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    cleanup(function() {
        process.exit(0);
    });
});

// Start the application
console.log('Starting Babashka nREPL AI Tool...');
console.log('Configuration:', {
    aiModel: config.ai.defaultModel,
    nreplHost: config.nrepl.hostname || 'auto',
    nreplPort: config.nrepl.port || 'auto',
    webPort: config.server.port
});

initialize(function(err) {
    if (err) {
        console.error('Initialization failed:', err);
        process.exit(1);
    }

    setupWebServer();
    console.log('Application ready!');
});

