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

// Application state
var appState = {
    nreplServerState: null,
    nreplConnection: null,
    nreplSession: null,
    aiClient: null,
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
                }

                // Create AI client with eval callback
                appState.aiClient = aiClient.createAIClient(config, evalClojure);

                broadcastToClients({ type: 'connection', message: 'Connected to nREPL' });
                callback(null);
            });
        });
    });
}

/**
 * Eval callback for AI client - executes Clojure code via nREPL
 */
function evalClojure(codeString, callback) {
    if (!appState.nreplConnection || !appState.nreplSession) {
        return callback(new Error('nREPL not connected'), null);
    }

    console.log('Evaluating Clojure code:', codeString);

    appState.nreplConnection.eval(codeString, undefined, appState.nreplSession, function(err, messages) {
        if (err) {
            console.error('nREPL eval error:', err);
            return callback(err, null);
        }

        // Serialize result
        var result = resultHandler.serializeResult(messages);
        var formatted = resultHandler.formatForVisualization(result);

        console.log('Evaluation result:', formatted);

        // Broadcast result to web clients
        broadcastToClients({ type: 'result', data: formatted });

        callback(null, formatted);
    });
}

/**
 * Step 2-8: Handle user prompt through the 8-step loop
 */
function handleUserMessage(userMessage, modelType, ws) {
    console.log('User message:', userMessage);
    console.log('Using model:', modelType || config.ai.defaultModel);

    // Step 2: Prompt - User gives task (already received)
    // Step 3: Decide - AI analyzes and generates Clojure code (handled by AI client)
    // Step 4: Request - AI calls eval_clojure (handled by AI client)
    // Step 5: Execute - nREPL evaluates code (handled by evalClojure)
    // Step 6: Respond - Serialize result and return to AI (handled by evalClojure callback)
    // Step 7: Update - Add result to conversation context (handled by AI client)
    // Step 8: Answer - AI synthesizes final response (handled by AI client)

    appState.aiClient.sendMessage(userMessage, modelType, function(err, response) {
        if (err) {
            console.error('AI client error:', err);
            sendToClient(ws, { type: 'error', message: err.message || String(err) });
            return;
        }

        if (response && response.content) {
            sendToClient(ws, { type: 'ai_response', content: response.content });
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

        sendToClient(ws, { type: 'status', message: 'Connected to server' });

        ws.on('message', function(message) {
            try {
                var data = JSON.parse(message);

                switch (data.type) {
                    case 'user_message':
                        handleUserMessage(data.message, data.model, ws);
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
            console.log('WebSocket client disconnected');
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

