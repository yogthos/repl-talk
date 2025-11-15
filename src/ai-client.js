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
 * @param {Function} statusCallback - Optional callback to send status updates to user (message)
 */
function createAIClient(config, evalCallback, initialHistory, saveCallback, statusCallback) {
    var client = {
        config: config,
        evalCallback: evalCallback,
        conversationHistory: [],
        saveCallback: saveCallback || null,
        statusCallback: statusCallback || null,
        // Error recovery state
        inErrorRecovery: false,
        iterationCount: 0,
        maxIterations: 5 // Safety limit to prevent infinite loops
    };

    /**
     * Sanitize conversation history to ensure valid message sequence
     * Removes orphaned tool messages (tool messages without preceding assistant message with tool_calls)
     * Ensures proper message sequence: user/assistant → assistant with tool_calls → tool → assistant
     */
    function sanitizeHistory(history) {
        if (!history || history.length === 0) {
            return [];
        }

        var sanitized = [];
        var i = 0;

        while (i < history.length) {
            var msg = history[i];

            // Always include user and assistant messages (without tool_calls)
            if (msg.role === 'user' || (msg.role === 'assistant' && !msg.tool_calls)) {
                sanitized.push(msg);
                i++;
            }
            // For assistant messages with tool_calls, include them and their corresponding tool messages
            else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                sanitized.push(msg);
                i++;

                // Collect all tool messages that correspond to this assistant's tool_calls
                var toolCallIds = {};
                msg.tool_calls.forEach(function(toolCall) {
                    toolCallIds[toolCall.id] = true;
                });

                // Track which tool_call_ids we've already included to prevent duplicates
                var includedToolCallIds = {};

                // Include tool messages that match the tool_call_ids from the assistant message
                while (i < history.length && history[i].role === 'tool') {
                    var toolMsg = history[i];
                    if (toolMsg.tool_call_id && toolCallIds[toolMsg.tool_call_id]) {
                        // Check for duplicate
                        if (!includedToolCallIds[toolMsg.tool_call_id]) {
                            sanitized.push(toolMsg);
                            includedToolCallIds[toolMsg.tool_call_id] = true;
                        } else {
                            console.warn('Removing duplicate tool message with tool_call_id:', toolMsg.tool_call_id);
                        }
                        i++;
                    } else {
                        // Orphaned tool message - skip it
                        console.warn('Removing orphaned tool message with tool_call_id:', toolMsg.tool_call_id);
                        i++;
                    }
                }
            }
            // Skip orphaned tool messages (not preceded by assistant with tool_calls)
            else if (msg.role === 'tool') {
                console.warn('Removing orphaned tool message with tool_call_id:', msg.tool_call_id);
                i++;
            }
            // Skip any other unexpected message types
            else {
                console.warn('Skipping unexpected message type:', msg.role);
                i++;
            }
        }

        return sanitized;
    }

    // Sanitize initial history to remove orphaned tool messages
    if (initialHistory && initialHistory.length > 0) {
        var sanitizedHistory = sanitizeHistory(initialHistory);
        if (sanitizedHistory.length !== initialHistory.length) {
            console.log('Sanitized conversation history: removed', initialHistory.length - sanitizedHistory.length, 'orphaned messages');
        }
        client.conversationHistory = sanitizedHistory;
    }

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
                    // Check if this is a user cancellation (not a real execution error)
                    var isUserCancellation = err.message && err.message.includes('cancelled by user');

                    if (isUserCancellation) {
                        // User cancelled - don't send tool response, just stop the conversation
                        console.log('Code execution cancelled by user - stopping conversation');
                        callback(new Error('USER_CANCELLED'), null);
                        return;
                    }

                    // Real execution error - send tool response so AI can handle it
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
                        // Check if this is a validation error vs execution error
                        var isValidationError = result.validationErrors && result.validationErrors.length > 0;
                        var errorMessage = isValidationError
                            ? 'Code validation detected errors before execution. Please fix the validation errors and generate corrected code using eval_clojure again.'
                            : 'The code execution failed with an error. Please analyze the error and generate corrected code using eval_clojure again.';

                        var errorResponse = {
                            status: 'error',
                            error: result.error,
                            message: errorMessage,
                            errorDetails: result.errorDetails || {},
                            validationErrors: result.validationErrors || null,
                            stdout: result.stdout || null,
                            stderr: result.stderr || null,
                            logs: result.logs || [],
                            executionTime: result.executionTime || null,
                            raw: result.raw || null
                        };
                        toolResponse.content = JSON.stringify(errorResponse);
                    } else {
                        // Success result - include logs for observability
                        toolResponse.content = JSON.stringify({
                            status: 'success',
                            result: result,
                            logs: result.logs || [],
                            executionTime: result.executionTime || null
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
     * Strips commentary text and tool call markers
     */
    function extractHTML(content) {
        if (!content || typeof content !== 'string') {
            return null;
        }

        var trimmed = content.trim();

        // Remove tool call markers if present (these shouldn't appear but handle them)
        // Pattern: <｜tool▁calls▁begin｜>, <｜tool▁call▁begin｜>, <｜tool▁sep｜>, etc.
        trimmed = trimmed.replace(/<[｜|][^>]*?[｜|]>/g, '');

        // Remove common patterns that might slip through
        trimmed = trimmed.replace(/[｜▁]/g, '');

        // Check if content starts with HTML already (no commentary)
        if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
            return trimmed;
        }

        // Try to find and extract HTML from mixed content
        // Strategy: Look for first HTML tag and extract everything from there

        // 1. Look for DOCTYPE declaration and extract everything from there
        var doctypeMatch = trimmed.match(/<!DOCTYPE[\s\S]*/i);
        if (doctypeMatch) {
            return doctypeMatch[0].trim();
        }

        // 2. Look for <html> tag and extract everything from there
        var htmlMatch = trimmed.match(/<html[\s\S]*/i);
        if (htmlMatch) {
            return htmlMatch[0].trim();
        }

        // 3. Look for substantial HTML structure and extract from first tag to end
        // This handles cases where commentary appears before the HTML
        var structureMatch = trimmed.match(/(<(?:div|body|section|article|main|table|ul|ol|h[1-6]|p)[^>]*>[\s\S]*)/i);
        if (structureMatch) {
            var htmlContent = structureMatch[1].trim();

            // Try to find the matching closing tag and extract just that portion
            // This removes any trailing commentary
            var firstTag = htmlContent.match(/^<(\w+)/);
            if (firstTag) {
                var tagName = firstTag[1];
                // Find the last occurrence of the closing tag for this element
                var closingTagPattern = new RegExp('</' + tagName + '>(?!.*</' + tagName + '>)', 'i');
                var closingMatch = htmlContent.match(closingTagPattern);
                if (closingMatch) {
                    var endIndex = closingMatch.index + closingMatch[0].length;
                    return htmlContent.substring(0, endIndex).trim();
                }
            }

            return htmlContent;
        }

        // 4. Look for any HTML tags and try to extract clean HTML
        // Find first HTML tag
        var firstTagMatch = trimmed.match(/<[a-z][a-z0-9]*[\s\S]*?>/i);
        if (firstTagMatch) {
            var startIndex = firstTagMatch.index;
            // Extract from first tag to end, then try to find last closing tag
            var potentialHtml = trimmed.substring(startIndex);

            // Find the last closing HTML tag to trim trailing text
            var lastClosingTag = potentialHtml.match(/.*(<\/[a-z][a-z0-9]*>)/i);
            if (lastClosingTag) {
                return potentialHtml.substring(0, lastClosingTag.index + lastClosingTag[1].length).trim();
            }

            return potentialHtml.trim();
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
            // IMPORTANT: This is an intermediate message with tool calls
            // Do NOT send this to the user - it's just setup for tool execution
            // The callback will only be called after tool execution completes

            // If we're in error recovery mode, suppress the AI's commentary
            // The status callback already informed the user about the error recovery
            if (client.inErrorRecovery && message.content) {
                console.log('Suppressing intermediate response during error recovery:', message.content.substring(0, 100));
                // Don't add commentary to history - just the tool calls
                // Update the assistant message to remove commentary
                // Some APIs don't accept null content, so use empty string instead
                assistantMsg.content = ''; // Clear commentary, keep tool_calls
                // Update in history
                client.conversationHistory[client.conversationHistory.length - 1] = assistantMsg;
            }

            var toolResults = [];
            var completed = 0;
            var hasError = false;

            message.tool_calls.forEach(function(toolCall) {
                handleToolCall(toolCall, function(err, result) {
                    if (err) {
                        // Check if this is a user cancellation
                        if (err.message === 'USER_CANCELLED') {
                            // User cancelled - remove the assistant message with tool_calls from history
                            // and stop the conversation without calling continueConversation
                            console.log('User cancelled code execution - removing assistant message and stopping');

                            // Remove the last assistant message (the one with tool_calls that was just added)
                            if (client.conversationHistory.length > 0 &&
                                client.conversationHistory[client.conversationHistory.length - 1].role === 'assistant') {
                                client.conversationHistory.pop();
                            }

                            // Call the main callback with a cancellation error
                            // This will be handled by the caller to show a message to the user
                            callback(new Error('Code execution cancelled by user'), null);
                            return;
                        }

                        // Other errors - treat as fatal
                        hasError = true;
                        callback(err, null);
                        return;
                    }

                    // Validate tool message before adding to history
                    if (!result || !result.role || result.role !== 'tool') {
                        console.error('Invalid tool result:', result);
                        hasError = true;
                        callback(new Error('Invalid tool result format'), null);
                        return;
                    }

                    if (!result.tool_call_id) {
                        console.error('Tool result missing tool_call_id:', result);
                        hasError = true;
                        callback(new Error('Tool result missing tool_call_id'), null);
                        return;
                    }

                    // Verify there's a corresponding assistant message with tool_calls
                    var lastAssistantMsg = null;
                    for (var i = client.conversationHistory.length - 1; i >= 0; i--) {
                        if (client.conversationHistory[i].role === 'assistant') {
                            lastAssistantMsg = client.conversationHistory[i];
                            break;
                        }
                    }

                    if (!lastAssistantMsg || !lastAssistantMsg.tool_calls ||
                        !lastAssistantMsg.tool_calls.some(function(tc) { return tc.id === result.tool_call_id; })) {
                        console.error('Tool message does not correspond to any assistant message with tool_calls');
                        hasError = true;
                        callback(new Error('Tool message sequencing error'), null);
                        return;
                    }

                    // Validate tool response content is valid JSON
                    if (result.content) {
                        try {
                            JSON.parse(result.content);
                        } catch (e) {
                            console.error('Tool response content is not valid JSON:', result.content);
                            hasError = true;
                            callback(new Error('Tool response content is not valid JSON: ' + e.message), null);
                            return;
                        }
                    }

                    // Check for duplicate tool_call_id before adding to history
                    var isDuplicate = false;
                    for (var j = client.conversationHistory.length - 1; j >= 0; j--) {
                        var existingMsg = client.conversationHistory[j];
                        if (existingMsg.role === 'tool' && existingMsg.tool_call_id === result.tool_call_id) {
                            isDuplicate = true;
                            console.warn('Duplicate tool message detected with tool_call_id:', result.tool_call_id, 'at position', j);
                            break;
                        }
                        // Stop checking when we reach the assistant message with tool_calls
                        if (existingMsg.role === 'assistant' && existingMsg.tool_calls) {
                            break;
                        }
                    }

                    // Always add to toolResults for continueConversation, but only add to history if not duplicate
                    toolResults.push(result);
                    if (!isDuplicate) {
                        client.conversationHistory.push(result);
                    } else {
                        console.warn('Skipping duplicate tool message addition to history for tool_call_id:', result.tool_call_id);
                    }

                    // Save tool result to database if save callback is provided
                    if (client.saveCallback) {
                        client.saveCallback('tool', JSON.stringify(result), null);
                    }

                    // Check if result indicates an error (execution succeeded but returned error)
                    var toolResultContent = null;
                    try {
                        toolResultContent = JSON.parse(result.content);
                    } catch (e) {
                        // If parsing fails, treat as non-error
                    }

                    var hasErrorResult = toolResultContent && toolResultContent.status === 'error';

                    if (hasErrorResult) {
                        // Enter error recovery mode
                        if (!client.inErrorRecovery) {
                            client.inErrorRecovery = true;
                            client.iterationCount = 1;
                            // Send status update to user
                            if (client.statusCallback) {
                                client.statusCallback('Code execution failed. AI is analyzing the error and generating a fix...');
                            }
                        } else {
                            // Already in error recovery, increment iteration count
                            client.iterationCount++;
                            if (client.statusCallback) {
                                client.statusCallback('AI is generating corrected code (attempt ' + client.iterationCount + ')...');
                            }
                        }

                        // Check iteration limit
                        if (client.iterationCount > client.maxIterations) {
                            var errorMsg = 'Maximum iteration limit (' + client.maxIterations + ') reached. Unable to fix the error.';
                            console.error(errorMsg);
                            if (client.statusCallback) {
                                client.statusCallback(errorMsg);
                            }
                            client.inErrorRecovery = false;
                            client.iterationCount = 0;
                            callback(new Error(errorMsg), null);
                            return;
                        }
                    } else {
                        // Success! Reset error recovery state
                        if (client.inErrorRecovery) {
                            client.inErrorRecovery = false;
                            client.iterationCount = 0;
                            if (client.statusCallback) {
                                client.statusCallback('Code executed successfully!');
                            }
                        }
                    }

                    completed++;

                    // When all tool calls are done, continue conversation
                    // This happens for both success and error results (error recovery continues)
                    if (completed === message.tool_calls.length && !hasError) {
                        // Continue conversation with tool results
                        // This will eventually call the callback with the FINAL response
                        continueConversation(modelType, callback);
                    }
                });
            });

            // Do NOT call callback here - we're waiting for tool execution to complete
            // The callback will be invoked by continueConversation after tools execute
        } else {
            // No tool calls, this is the FINAL response - return it to the user
            // But check if we're in error recovery - if so, this shouldn't happen
            // (we should have tool calls to fix the error)
            if (client.inErrorRecovery) {
                console.warn('Received final response during error recovery without tool calls. This may indicate the AI gave up.');
                // Reset error recovery state
                client.inErrorRecovery = false;
                client.iterationCount = 0;
            }

            // Check if content is HTML and mark for visualization
            var finalResponse = {
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
                finalResponse.type = 'html';
                finalResponse.html = extractedHTML;
            } else if (message.content && resultHandler.isHTML(message.content)) {
                console.log('AI response detected as HTML (pure), content length:', message.content.length);
                console.log('HTML content preview:', message.content.substring(0, 300));
                finalResponse.type = 'html';
                finalResponse.html = message.content;
            } else {
                console.log('AI response not detected as HTML');
                if (message.content) {
                    console.log('Content preview:', message.content.substring(0, 200));
                }
            }

            callback(null, finalResponse);
        }
    }

    /**
     * Continue conversation after tool execution
     */
    function continueConversation(modelType, callback) {
        var endpointInfo = getEndpoint(modelType || client.config.ai.defaultModel);
        var evalTool = createEvalClojureTool(client.config);

        // Sanitize history before sending to API to ensure valid message sequence
        var sanitizedHistory = sanitizeHistory(client.conversationHistory);

        // Prepare messages with system prompt from config (same as sendMessage)
        // Merge code-mode prompt template if available
        var systemPromptContent = client.config.ai.systemPrompt;
        if (client.config.ai.codeModePromptTemplate) {
            systemPromptContent = systemPromptContent + '\n\n' + client.config.ai.codeModePromptTemplate;
        }
        var messages = [
            {
                role: 'system',
                content: systemPromptContent
            }
        ].concat(sanitizedHistory);

        // Log the message sequence for debugging
        console.log('continueConversation: sending', messages.length, 'messages to API');
        messages.forEach(function(msg, idx) {
            if (msg.role === 'assistant' && msg.tool_calls) {
                console.log('  [' + idx + '] assistant with', msg.tool_calls.length, 'tool_calls, content:', msg.content ? 'present' : 'null/empty');
            } else if (msg.role === 'tool') {
                console.log('  [' + idx + '] tool, tool_call_id:', msg.tool_call_id);
            } else {
                console.log('  [' + idx + ']', msg.role, msg.content ? 'content present' : 'no content');
            }
        });

        var requestBody = {
            model: endpointInfo.model,
            messages: messages,
            tools: [evalTool], // Include tools so AI can continue making tool calls during error recovery
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

        // Sanitize history before sending to API to ensure valid message sequence
        var sanitizedHistory = sanitizeHistory(client.conversationHistory);

        // Prepare messages with system prompt from config
        // Merge code-mode prompt template if available
        var systemPromptContent = client.config.ai.systemPrompt;
        if (client.config.ai.codeModePromptTemplate) {
            systemPromptContent = systemPromptContent + '\n\n' + client.config.ai.codeModePromptTemplate;
        }
        var messages = [
            {
                role: 'system',
                content: systemPromptContent
            }
        ].concat(sanitizedHistory);

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

