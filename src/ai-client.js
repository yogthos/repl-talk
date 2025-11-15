/*global module,console,require*/

/**
 * AI Client for OpenAI-compatible APIs (local models and DeepSeek)
 * Exposes single eval_clojure tool to AI models
 */

var https = require('https');
var http = require('http');
var resultHandler = require('./result-handler');

/**
 * Create the eval_clojure tool schema from config
 */
function createEvalClojureTool(config) {
    var toolConfig = config.ai.tool;
    return {
        type: 'function',
        function: {
            name: toolConfig.name,
            description: toolConfig.description,
            parameters: {
                type: 'object',
                properties: {
                    code_string: {
                        type: 'string',
                        description: toolConfig.parameterDescription
                    }
                },
                required: ['code_string']
            }
        }
    };
}

/**
 * Create AI Client
 * @param {Object} config - Configuration object
 * @param {Function} evalCallback - Callback for executing Clojure code
 * @param {Array} initialHistory - Optional initial conversation history
 * @param {Function} saveCallback - Optional callback to save messages (sessionId, role, content, toolCalls)
 */
function createAIClient(config, evalCallback, initialHistory, saveCallback) {
    var client = {
        config: config,
        evalCallback: evalCallback,
        conversationHistory: initialHistory || [],
        saveCallback: saveCallback || null
    };

    /**
     * Get the appropriate endpoint and API key based on model type
     */
    function getEndpoint(modelType) {
        var modelKey = modelType || client.config.ai.defaultModel;
        var modelConfig = client.config.ai.models[modelKey];

        if (!modelConfig) {
            throw new Error('Unknown model type: ' + modelKey + '. Available models: ' +
                          Object.keys(client.config.ai.models).join(', '));
        }

        return {
            endpoint: modelConfig.endpoint,
            apiKey: modelConfig.apiKey,
            model: modelConfig.model,
            temperature: modelConfig.temperature,
            maxTokens: modelConfig.maxTokens
        };
    }

    /**
     * Make HTTP request to AI API
     */
    function makeRequest(endpointUrl, apiKey, body, callback) {
        // Use WHATWG URL API instead of deprecated url.parse()
        var parsedUrl = new URL(endpointUrl);
        var isHttps = parsedUrl.protocol === 'https:';
        var httpModule = isHttps ? https : http;

        // Build path from pathname and search (query string)
        var path = parsedUrl.pathname + parsedUrl.search;

        var options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey
            }
        };

        var req = httpModule.request(options, function(res) {
            var data = '';
            res.on('data', function(chunk) {
                data += chunk;
            });
            res.on('end', function() {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        var jsonData = JSON.parse(data);
                        callback(null, jsonData);
                    } catch (e) {
                        callback(new Error('Failed to parse response: ' + e.message), null);
                    }
                } else {
                    callback(new Error('API request failed with status ' + res.statusCode + ': ' + data), null);
                }
            });
        });

        req.on('error', function(err) {
            callback(err, null);
        });

        req.write(JSON.stringify(body));
        req.end();
    }

    /**
     * Handle function calling - execute tool and return result
     */
    function handleToolCall(toolCall, callback) {
        var toolName = client.config.ai.tool.name;
        if (toolCall.function.name === toolName) {
            var args = JSON.parse(toolCall.function.arguments);
            var codeString = args.code_string;

            console.log('AI requested to evaluate Clojure code:');
            console.log(codeString);

            // Call the eval callback (which will use nREPL)
            client.evalCallback(codeString, function(err, result) {
                if (err) {
                    callback(null, {
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        name: toolName,
                        content: JSON.stringify({
                            error: err.message || String(err),
                            status: 'execution_failed'
                        })
                    });
                } else {
                    // Check if result indicates an error and format it clearly for AI
                    var toolResponse = {
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        name: toolName,
                        content: null
                    };

                    if (result && result.type === 'error') {
                        // Format error result with clear instructions for AI
                        var errorResponse = {
                            status: 'error',
                            error: result.error,
                            message: 'The code execution failed with an error. Please analyze the error and generate corrected code using eval_clojure again.',
                            errorDetails: result.errorDetails || {},
                            stdout: result.stdout || null,
                            raw: result.raw || null
                        };
                        toolResponse.content = JSON.stringify(errorResponse);
                    } else {
                        // Success result
                        toolResponse.content = JSON.stringify({
                            status: 'success',
                            result: result
                        });
                    }

                    callback(null, toolResponse);
                }
            });
        } else {
            callback(null, {
                role: 'tool',
                tool_call_id: toolCall.id,
                name: toolCall.function.name,
                content: JSON.stringify({ error: 'Unknown tool: ' + toolCall.function.name })
            });
        }
    }

    /**
     * Extract HTML from mixed text/HTML content
     * Looks for HTML document or HTML tags within text
     */
    function extractHTML(content) {
        if (!content || typeof content !== 'string') {
            return null;
        }

        // Check if content starts with HTML already
        var trimmed = content.trim();
        if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
            return content;
        }

        // Look for HTML document within the content
        var doctypeMatch = content.match(/(<!DOCTYPE[\s\S]*)/i);
        if (doctypeMatch) {
            return doctypeMatch[1];
        }

        // Look for <html> tag within the content
        var htmlMatch = content.match(/(<html[\s\S]*)/i);
        if (htmlMatch) {
            return htmlMatch[1];
        }

        // Look for substantial HTML structure (div/body/etc with content)
        var structureMatch = content.match(/(<(?:div|body|section|article|main)[^>]*>[\s\S]*)/i);
        if (structureMatch) {
            return structureMatch[1];
        }

        // If no HTML found, return null
        return null;
    }

    /**
     * Process AI response and handle tool calls
     */
    function processAIResponse(response, modelType, callback) {
        var message = response.choices && response.choices[0] && response.choices[0].message;
        if (!message) {
            return callback(new Error('Invalid AI response format'), null);
        }

        // Add assistant message to history
        var assistantMsg = {
            role: 'assistant',
            content: message.content,
            tool_calls: message.tool_calls
        };
        client.conversationHistory.push(assistantMsg);

        // Save to database if save callback is provided
        if (client.saveCallback) {
            client.saveCallback('assistant', message.content, message.tool_calls);
        }

        // If there are tool calls, execute them
        if (message.tool_calls && message.tool_calls.length > 0) {
            var toolResults = [];
            var completed = 0;
            var hasError = false;

            message.tool_calls.forEach(function(toolCall) {
                handleToolCall(toolCall, function(err, result) {
                    if (err) {
                        hasError = true;
                        callback(err, null);
                        return;
                    }

                    toolResults.push(result);
                    client.conversationHistory.push(result);

                    // Save tool result to database if save callback is provided
                    if (client.saveCallback) {
                        client.saveCallback('tool', JSON.stringify(result), null);
                    }

                    completed++;

                    // When all tool calls are done, make another request with results
                    if (completed === message.tool_calls.length && !hasError) {
                        // Continue conversation with tool results
                        continueConversation(modelType, callback);
                    }
                });
            });
        } else {
            // No tool calls, return the message
            // Check if content is HTML and mark for visualization
            var response = {
                content: message.content,
                role: 'assistant'
            };

            // Try to extract HTML from the content (handles mixed text/HTML)
            var extractedHTML = null;
            if (message.content) {
                extractedHTML = extractHTML(message.content);
            }

            // Detect if content is HTML (either pure or extracted)
            if (extractedHTML) {
                console.log('AI response contains HTML (extracted), content length:', extractedHTML.length);
                console.log('Extracted HTML preview:', extractedHTML.substring(0, 300));
                response.type = 'html';
                response.html = extractedHTML;
            } else if (message.content && resultHandler.isHTML(message.content)) {
                console.log('AI response detected as HTML (pure), content length:', message.content.length);
                console.log('HTML content preview:', message.content.substring(0, 300));
                response.type = 'html';
                response.html = message.content;
            } else {
                console.log('AI response not detected as HTML');
                if (message.content) {
                    console.log('Content preview:', message.content.substring(0, 200));
                }
            }

            callback(null, response);
        }
    }

    /**
     * Continue conversation after tool execution
     */
    function continueConversation(modelType, callback) {
        var endpointInfo = getEndpoint(modelType || client.config.ai.defaultModel);
        var requestBody = {
            model: endpointInfo.model,
            messages: client.conversationHistory,
            temperature: endpointInfo.temperature,
            max_tokens: endpointInfo.maxTokens
        };

        makeRequest(endpointInfo.endpoint + '/chat/completions', endpointInfo.apiKey, requestBody, function(err, response) {
            if (err) {
                return callback(err, null);
            }

            processAIResponse(response, modelType, callback);
        });
    }

    /**
     * Send a message to the AI
     */
    client.sendMessage = function(userMessage, modelType, callback) {
        // Add user message to history
        var userMsg = {
            role: 'user',
            content: userMessage
        };
        client.conversationHistory.push(userMsg);

        // Save to database if save callback is provided
        if (client.saveCallback) {
            client.saveCallback('user', userMessage, null);
        }

        var endpointInfo = getEndpoint(modelType || client.config.ai.defaultModel);

        // Prepare messages with system prompt from config
        var messages = [
            {
                role: 'system',
                content: client.config.ai.systemPrompt
            }
        ].concat(client.conversationHistory);

        var evalTool = createEvalClojureTool(client.config);
        var requestBody = {
            model: endpointInfo.model,
            messages: messages,
            tools: [evalTool],
            tool_choice: 'auto',
            temperature: endpointInfo.temperature,
            max_tokens: endpointInfo.maxTokens
        };

        makeRequest(endpointInfo.endpoint + '/chat/completions', endpointInfo.apiKey, requestBody, function(err, response) {
            if (err) {
                return callback(err, null);
            }

            processAIResponse(response, modelType, callback);
        });
    };

    /**
     * Clear conversation history
     */
    client.clearHistory = function() {
        client.conversationHistory = [];
    };

    return client;
}

module.exports = {
    createAIClient: createAIClient,
    createEvalClojureTool: createEvalClojureTool
};

