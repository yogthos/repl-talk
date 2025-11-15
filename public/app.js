/*global WebSocket,console*/

/**
 * Client-side JavaScript for the web interface
 */

var ws = null;
var isConnected = false;

// DOM elements
var connectionStatus = document.getElementById('connection-status');
var connectBtn = document.getElementById('connect-btn');
var disconnectBtn = document.getElementById('disconnect-btn');
var userInput = document.getElementById('user-input');
var sendBtn = document.getElementById('send-btn');
var clearBtn = document.getElementById('clear-btn');
var aiOutput = document.getElementById('ai-output');
var canvasContainer = document.getElementById('canvas-container');
var canvasIframe = document.getElementById('canvas-iframe');
var modelSelect = document.getElementById('model-select');

// State for status messages and code execution
var activeStatusMessages = [];
var pendingCodeExecution = null;

/**
 * Get the iframe document, initializing it if necessary
 * Returns null if iframe is not available
 */
function getIframeDocument() {
    if (!canvasIframe) {
        console.error('Canvas iframe not found');
        return null;
    }

    var iframeDoc = canvasIframe.contentDocument || canvasIframe.contentWindow.document;

    // Initialize iframe document if it's empty or not ready
    if (!iframeDoc || !iframeDoc.body) {
        iframeDoc.open();
        var placeholderHTML = '<div class="canvas-placeholder" style="display: flex; align-items: center; justify-content: center; height: 100%; color: #858585; font-style: italic;">Results will be visualized here</div>';
        iframeDoc.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body { margin: 0; padding: 0; background: #1e1e1e; color: #d4d4d4; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; }</style></head><body>' + placeholderHTML + '</body></html>');
        iframeDoc.close();
    }

    return iframeDoc;
}

// Connect to WebSocket server
function connect() {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = protocol + '//' + window.location.host;

    ws = new WebSocket(wsUrl);

    ws.onopen = function() {
        isConnected = true;
        updateConnectionStatus(true);
        console.log('Connected to server');
    };

    ws.onmessage = function(event) {
        var message = JSON.parse(event.data);
        handleServerMessage(message);
    };

    ws.onerror = function(error) {
        console.error('WebSocket error:', error);
        addOutputMessage('Error: Connection error', 'error');
    };

    ws.onclose = function() {
        isConnected = false;
        updateConnectionStatus(false);
        console.log('Disconnected from server');
    };
}

function disconnect() {
    if (ws) {
        ws.close();
        ws = null;
    }
}

function updateConnectionStatus(connected) {
    if (connected) {
        connectionStatus.textContent = 'Connected';
        connectionStatus.className = 'status-indicator connected';
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
        sendBtn.disabled = false;
    } else {
        connectionStatus.textContent = 'Disconnected';
        connectionStatus.className = 'status-indicator disconnected';
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        sendBtn.disabled = true;
    }
}

function handleServerMessage(message) {
    switch (message.type) {
        case 'connection':
            addOutputMessage('Connected to nREPL server', 'info');
            break;
        case 'ai_response':
            removeAllStatusMessages();
            addOutputMessage(message.content, 'assistant');
            break;
        case 'result':
            console.log('Canvas received result:', message.data);
            removeAllStatusMessages();
            visualizeResult(message.data);
            break;
        case 'error':
            removeAllStatusMessages();
            addOutputMessage('Error: ' + message.message, 'error');
            break;
        case 'status':
            addOutputMessage(message.message, 'info');
            break;
        case 'loading_start':
            addStatusMessage(message.message || 'AI is thinking...', 'thinking');
            break;
        case 'loading_end':
            removeAllStatusMessages();
            break;
        case 'code_preview':
            updateLastStatusMessage('Code ready for review', 'waiting-approval');
            addCodePreviewCard(message.code, message.messageId);
            break;
    }
}

function sendMessage() {
    var text = userInput.value.trim();
    if (!text || !isConnected) return;

    var model = modelSelect.value;

    addOutputMessage('You: ' + text, 'user');
    userInput.value = '';

    ws.send(JSON.stringify({
        type: 'user_message',
        message: text,
        model: model
    }));
}

function addOutputMessage(text, type) {
    var messageDiv = document.createElement('div');
    messageDiv.className = 'message ' + (type || '');

    // Check if text contains markdown and render it
    if (typeof text === 'string' && isMarkdown(text)) {
        messageDiv.innerHTML = markdownToHTML(text);
    } else {
        messageDiv.textContent = text;
    }

    aiOutput.appendChild(messageDiv);
    aiOutput.scrollTop = aiOutput.scrollHeight;
}

function visualizeResult(result) {
    // Get iframe document
    var iframeDoc = getIframeDocument();
    if (!iframeDoc) {
        console.error('Cannot access iframe document');
        return;
    }

    // Clear previous visualization
    iframeDoc.body.innerHTML = '';

    if (!result || result.error) {
        var errorDiv = iframeDoc.createElement('div');
        errorDiv.className = 'visualization';
        errorDiv.innerHTML = '<div style="color: #f48771; padding: 1rem;">Error: ' +
                            (result.error || 'Unknown error') + '</div>';
        iframeDoc.body.appendChild(errorDiv);
        return;
    }

    var type = result.type || 'unknown';
    var vizDiv = iframeDoc.createElement('div');
    vizDiv.className = 'visualization';

    console.log('visualizeResult - type:', type, 'result:', result);

    // Primary HTML rendering - if HTML is present, use it
    if (type === 'html') {
        // Check for HTML in various possible locations
        var htmlContent = result.html || result.data || result.content;
        console.log('HTML content to render:', htmlContent ? htmlContent.substring(0, 200) + '...' : 'none');
        if (htmlContent) {
            renderHTML(vizDiv, htmlContent, iframeDoc);
        } else {
            // Fallback: try to extract from value if it's a string
            var data = result.value;
            if (typeof data === 'string' && data.trim().startsWith('<')) {
                renderHTML(vizDiv, data, iframeDoc);
            } else {
                renderJSON(vizDiv, result, iframeDoc);
            }
        }
    } else {
        // Fallback to legacy rendering for non-HTML results
        var data = result.value;
        switch (type) {
            case 'table-data':
                renderTable(vizDiv, data, iframeDoc);
                break;
            case 'chart-data':
                renderChart(vizDiv, data, iframeDoc);
                break;
            case 'map':
                renderMap(vizDiv, data, iframeDoc);
                break;
            case 'list':
                renderList(vizDiv, data, iframeDoc);
                break;
            case 'string':
            case 'number':
            case 'boolean':
                renderSimple(vizDiv, data, iframeDoc);
                break;
            default:
                renderJSON(vizDiv, result, iframeDoc);
        }
    }

    iframeDoc.body.appendChild(vizDiv);
}

/**
 * Detect if content contains markdown syntax
 */
function isMarkdown(text) {
    if (typeof text !== 'string') return false;
    // Check for common markdown patterns
    var markdownPatterns = [
        /\*\*.*?\*\*/,           // Bold **text**
        /(?:^|[^*])\*[^*\s].*?[^*\s]\*(?!\*)/,  // Italic *text* (not **)
        /^[-*+]\s/m,             // List items
        /^#+\s/m,                // Headers
        /`[^`]+`/,               // Inline code
        /```[\s\S]*?```/,        // Code blocks
        /\[.*?\]\(.*?\)/         // Links
    ];
    return markdownPatterns.some(function(pattern) {
        return pattern.test(text);
    });
}

/**
 * Convert markdown to HTML using marked library
 */
function markdownToHTML(markdown) {
    if (typeof markdown !== 'string') return markdown;

    // Check if marked library is available
    if (typeof marked !== 'undefined' && marked.parse) {
        try {
            return marked.parse(markdown);
        } catch (e) {
            console.error('Error parsing markdown:', e);
            return markdown; // Return original if parsing fails
        }
    } else {
        console.warn('marked library not available');
        return markdown;
    }
}

/**
 * Extract HTML from mixed text/HTML content
 * Looks for HTML document or HTML tags within text
 * Strips commentary text and tool call markers
 */
function extractHTML(content) {
    if (!content || typeof content !== 'string') {
        return content;
    }

    var trimmed = content.trim();

    // Remove tool call markers if present (these shouldn't appear but handle them)
    // Pattern: <｜tool▁calls▁begin｜>, <｜tool▁call▁begin｜>, <｜tool▁sep｜>, etc.
    trimmed = trimmed.replace(/<[｜|][^>]*?[｜|]>/g, '');

    // Remove common patterns that might slip through
    trimmed = trimmed.replace(/[｜▁]/g, '');

    // Remove common commentary phrases that might appear before HTML
    var commentaryPatterns = [
        /^Now I'll create.*?:/i,
        /^Here's.*?:/i,
        /^Let me create.*?:/i,
        /^I'll generate.*?:/i,
        /^Creating.*?:/i,
        /^Generating.*?:/i
    ];

    commentaryPatterns.forEach(function(pattern) {
        trimmed = trimmed.replace(pattern, '');
    });

    trimmed = trimmed.trim();

    // Check if content starts with HTML already (no commentary)
    if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<div')) {
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

    // If no HTML found, return original content
    return trimmed;
}

/**
 * Render HTML content in the canvas
 * Handles both HTML and markdown content
 */
function renderHTML(container, htmlContent, iframeDoc) {
    console.log('renderHTML called with content length:', htmlContent ? htmlContent.length : 0);
    console.log('renderHTML first 500 chars:', htmlContent ? htmlContent.substring(0, 500) : 'empty');

    // Extract HTML if content contains mixed text/HTML
    htmlContent = extractHTML(htmlContent);
    console.log('After extraction, first 500 chars:', htmlContent ? htmlContent.substring(0, 500) : 'empty');

    // Check if this is a full HTML document
    var trimmedContent = htmlContent.trim();
    var isFullDocument = trimmedContent.startsWith('<!DOCTYPE') || trimmedContent.startsWith('<html');

    console.log('Is full HTML document:', isFullDocument);

    var contentToRender = htmlContent;

    // If it's a full HTML document, extract the body content
    if (isFullDocument) {
        // Parse the HTML and extract body content
        var tempDiv = iframeDoc.createElement('div');
        tempDiv.innerHTML = htmlContent;

        // Try to find body element
        var bodyElement = tempDiv.querySelector('body');
        if (bodyElement) {
            contentToRender = bodyElement.innerHTML;
            console.log('Extracted body content, length:', contentToRender.length);
        } else {
            // If no body found, try to extract everything between body tags
            var bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*)<\/body>/i);
            if (bodyMatch && bodyMatch[1]) {
                contentToRender = bodyMatch[1];
                console.log('Extracted body via regex, length:', contentToRender.length);
            } else {
                console.log('No body element found, using full content');
            }
        }

        // Also extract and apply styles from head if present
        var styleElements = tempDiv.querySelectorAll('style');
        if (styleElements.length > 0) {
            console.log('Found', styleElements.length, 'style elements, prepending to content');
            var stylesHTML = '';
            for (var i = 0; i < styleElements.length; i++) {
                stylesHTML += styleElements[i].outerHTML;
            }
            contentToRender = stylesHTML + contentToRender;
        }
    } else {
        // Check if content is markdown and convert it
        if (typeof htmlContent === 'string') {
            // If it doesn't start with HTML tags and contains markdown, convert it
            if (!htmlContent.trim().startsWith('<') && isMarkdown(htmlContent)) {
                contentToRender = markdownToHTML(htmlContent);
                console.log('Converted markdown to HTML');
            }
        }
    }

    // Create a wrapper div for the HTML content
    var htmlDiv = iframeDoc.createElement('div');
    htmlDiv.className = 'html-content';

    // For full documents, don't add extra padding - let the document control its own layout
    if (!isFullDocument) {
        htmlDiv.style.padding = '1rem';
    }
    htmlDiv.style.maxWidth = '100%';
    htmlDiv.style.overflow = 'auto';

    // Set the HTML content directly
    // Note: This renders HTML as-is. For production, consider sanitization
    console.log('Setting innerHTML with content length:', contentToRender.length);
    htmlDiv.innerHTML = contentToRender;

    console.log('htmlDiv created, childNodes:', htmlDiv.childNodes.length);

    container.appendChild(htmlDiv);
}

function renderTable(container, data, iframeDoc) {
    var table = iframeDoc.createElement('table');

    if (Array.isArray(data) && data.length > 0) {
        // Array of objects
        var headers = Object.keys(data[0]);
        var thead = iframeDoc.createElement('thead');
        var headerRow = iframeDoc.createElement('tr');
        headers.forEach(function(h) {
            var th = iframeDoc.createElement('th');
            th.textContent = h;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        var tbody = iframeDoc.createElement('tbody');
        data.forEach(function(row) {
            var tr = iframeDoc.createElement('tr');
            headers.forEach(function(h) {
                var td = iframeDoc.createElement('td');
                td.textContent = String(row[h] || '');
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
    } else if (typeof data === 'object') {
        // Single object as table
        var thead = iframeDoc.createElement('thead');
        var headerRow = iframeDoc.createElement('tr');
        var th1 = iframeDoc.createElement('th');
        th1.textContent = 'Key';
        var th2 = iframeDoc.createElement('th');
        th2.textContent = 'Value';
        headerRow.appendChild(th1);
        headerRow.appendChild(th2);
        thead.appendChild(headerRow);
        table.appendChild(thead);

        var tbody = iframeDoc.createElement('tbody');
        Object.keys(data).forEach(function(key) {
            var tr = iframeDoc.createElement('tr');
            var td1 = iframeDoc.createElement('td');
            td1.textContent = key;
            var td2 = iframeDoc.createElement('td');
            td2.textContent = String(data[key]);
            tr.appendChild(td1);
            tr.appendChild(td2);
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
    }

    container.appendChild(table);
}

function renderChart(container, data, iframeDoc) {
    // Simple text-based chart representation
    // For production, integrate a charting library like Chart.js
    var chartDiv = iframeDoc.createElement('div');
    chartDiv.className = 'chart';
    chartDiv.style.padding = '1rem';

    if (Array.isArray(data)) {
        var max = Math.max.apply(null, data);
        var min = Math.min.apply(null, data);
        var range = max - min || 1;

        var chartText = 'Chart Data:\n';
        data.forEach(function(val, i) {
            var barLength = Math.round((val - min) / range * 50);
            var bar = '█'.repeat(barLength);
            chartText += '[' + i + '] ' + bar + ' ' + val + '\n';
        });

        var pre = iframeDoc.createElement('pre');
        pre.textContent = chartText;
        pre.style.fontFamily = 'monospace';
        pre.style.whiteSpace = 'pre';
        chartDiv.appendChild(pre);
    } else {
        chartDiv.textContent = 'Chart data: ' + JSON.stringify(data);
    }

    container.appendChild(chartDiv);
}

function renderMap(container, data, iframeDoc) {
    renderTable(container, data, iframeDoc);
}

function renderList(container, data, iframeDoc) {
    if (Array.isArray(data)) {
        var ul = iframeDoc.createElement('ul');
        ul.style.listStyle = 'none';
        ul.style.padding = '0';
        data.forEach(function(item) {
            var li = iframeDoc.createElement('li');
            li.style.padding = '0.5rem';
            li.style.borderBottom = '1px solid #3e3e42';
            li.textContent = String(item);
            ul.appendChild(li);
        });
        container.appendChild(ul);
    } else {
        renderSimple(container, data, iframeDoc);
    }
}

function renderSimple(container, data, iframeDoc) {
    var div = iframeDoc.createElement('div');
    div.style.padding = '1rem';
    div.style.fontSize = '1.2rem';
    div.textContent = String(data);
    container.appendChild(div);
}

function renderJSON(container, result, iframeDoc) {
    var jsonDiv = iframeDoc.createElement('div');
    jsonDiv.className = 'json-view';
    var pre = iframeDoc.createElement('pre');
    pre.textContent = JSON.stringify(result, null, 2);
    jsonDiv.appendChild(pre);
    container.appendChild(jsonDiv);
}

// Inline status message functions
function addStatusMessage(text, type) {
    var statusId = 'status-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    var statusDiv = document.createElement('div');
    statusDiv.className = 'status-message ' + (type || 'thinking');
    statusDiv.id = statusId;

    var iconSpan = document.createElement('span');
    iconSpan.className = 'status-icon';
    iconSpan.textContent = type === 'thinking' ? '🤖' : type === 'executing' ? '⚡' : '📝';

    var textSpan = document.createElement('span');
    textSpan.className = 'status-text';
    textSpan.textContent = text;

    statusDiv.appendChild(iconSpan);
    statusDiv.appendChild(textSpan);

    aiOutput.appendChild(statusDiv);
    aiOutput.scrollTop = aiOutput.scrollHeight;

    activeStatusMessages.push(statusId);
    return statusId;
}

function updateStatusMessage(statusId, text, type) {
    var statusDiv = document.getElementById(statusId);
    if (!statusDiv) return;

    if (type) {
        statusDiv.className = 'status-message ' + type;
        var iconSpan = statusDiv.querySelector('.status-icon');
        if (iconSpan) {
            iconSpan.textContent = type === 'thinking' ? '🤖' : type === 'executing' ? '⚡' : '📝';
        }
    }

    var textSpan = statusDiv.querySelector('.status-text');
    if (textSpan) {
        textSpan.textContent = text;
    }
}

function updateLastStatusMessage(text, type) {
    if (activeStatusMessages.length > 0) {
        var lastId = activeStatusMessages[activeStatusMessages.length - 1];
        updateStatusMessage(lastId, text, type);
    }
}

function removeStatusMessage(statusId) {
    var statusDiv = document.getElementById(statusId);
    if (statusDiv) {
        statusDiv.remove();
    }
    activeStatusMessages = activeStatusMessages.filter(function(id) { return id !== statusId; });
}

function removeAllStatusMessages() {
    activeStatusMessages.forEach(function(statusId) {
        var statusDiv = document.getElementById(statusId);
        if (statusDiv) {
            statusDiv.remove();
        }
    });
    activeStatusMessages = [];
}

// Inline code preview card function
function addCodePreviewCard(code, messageId) {
    // Remove any existing code preview card
    var existingCard = document.querySelector('.code-preview-card');
    if (existingCard) {
        existingCard.remove();
    }

    var cardDiv = document.createElement('div');
    cardDiv.className = 'code-preview-card';
    cardDiv.id = 'code-card-' + messageId;

    // Card header
    var headerDiv = document.createElement('div');
    headerDiv.className = 'card-header';
    headerDiv.innerHTML = '<span>📝</span><span>Generated Code - Edit and Review Before Execution</span>';

    // Code display container for CodeMirror
    var codeDisplayDiv = document.createElement('div');
    codeDisplayDiv.className = 'code-display';
    codeDisplayDiv.id = 'codemirror-container-' + messageId;

    // Actions
    var actionsDiv = document.createElement('div');
    actionsDiv.className = 'card-actions';

    var approveBtn = document.createElement('button');
    approveBtn.className = 'btn-success';
    approveBtn.textContent = '✓ Run Code';
    approveBtn.onclick = function() {
        approveCodeExecution(messageId);
    };

    var rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn-danger';
    rejectBtn.textContent = '✗ Cancel';
    rejectBtn.onclick = function() {
        rejectCodeExecution(messageId);
    };

    actionsDiv.appendChild(approveBtn);
    actionsDiv.appendChild(rejectBtn);

    // Assemble card
    cardDiv.appendChild(headerDiv);
    cardDiv.appendChild(codeDisplayDiv);
    cardDiv.appendChild(actionsDiv);

    aiOutput.appendChild(cardDiv);
    aiOutput.scrollTop = aiOutput.scrollHeight;

    // Initialize pendingCodeExecution first
    pendingCodeExecution = { code: code, messageId: messageId, cardElement: cardDiv, editor: null };

    // Initialize CodeMirror editor
    var editor = null;

    function initCodeMirror() {
        if (window.CodeMirror && window.CodeMirror.EditorView && window.CodeMirror.EditorState) {
            try {
                // Build extensions array
                // NOTE: Keymap causes "multiple instances" error with CDN loading
                // Editor will work for basic editing without keymap, but some shortcuts may not work
                var extensions = [];

                // Don't add keymap - it causes version conflicts
                // The editor will still be editable via mouse and basic keyboard, just without advanced shortcuts

                // Add Clojure highlighting if available
                if (window.CodeMirror.clojureMode) {
                    extensions.push(window.CodeMirror.clojureMode);
                    console.log('Using Clojure syntax highlighting');
                } else {
                    console.warn('Clojure mode not available, using plain text');
                }

                // Create EditorState first, then EditorView
                // Ensure editor is editable (default is true, but be explicit)
                var state = window.CodeMirror.EditorState.create({
                    doc: code,
                    extensions: extensions
                });

                editor = new window.CodeMirror.EditorView({
                    state: state,
                    parent: codeDisplayDiv
                });

                // Ensure the editor is focusable and editable
                editor.contentDOM.setAttribute('contenteditable', 'true');
                editor.contentDOM.setAttribute('spellcheck', 'false');

                // Create and apply Clojure highlighting using the same module instances
                // Import modules and create ViewPlugin inline to avoid version conflicts
                if (window.CodeMirror.clojurePatterns) {
                    Promise.all([
                        import('https://cdn.jsdelivr.net/npm/@codemirror/view@6.26.0/+esm'),
                        import('https://cdn.jsdelivr.net/npm/@codemirror/state@6.4.0/+esm')
                    ]).then(function(modules) {
                        var viewModule = modules[0];
                        var stateModule = modules[1];
                        var patterns = window.CodeMirror.clojurePatterns;

                        try {
                            // Create ViewPlugin using the imported modules (same URL = same instance)
                            var ClojureHighlighter = viewModule.ViewPlugin.fromClass(class {
                                constructor(view) {
                                    this.decorations = this.buildDecorations(view, viewModule, stateModule, patterns);
                                }

                                update(update) {
                                    if (update.docChanged || update.viewportChanged) {
                                        this.decorations = this.buildDecorations(update.view, viewModule, stateModule, patterns);
                                    }
                                }

                                buildDecorations(view, viewModule, stateModule, patterns) {
                                    var builder = new stateModule.RangeSetBuilder();
                                    var text = view.state.doc.toString();
                                    var Decoration = viewModule.Decoration;

                                    // Reset regex lastIndex
                                    patterns.keywords.lastIndex = 0;
                                    patterns.strings.lastIndex = 0;
                                    patterns.comments.lastIndex = 0;
                                    patterns.numbers.lastIndex = 0;
                                    patterns.keywords2.lastIndex = 0;

                                    // Highlight keywords
                                    var match;
                                    while ((match = patterns.keywords.exec(text)) !== null) {
                                        builder.add(match.index, match.index + match[0].length,
                                            Decoration.mark({class: 'cm-clojure-keyword'}));
                                    }

                                    // Highlight strings
                                    while ((match = patterns.strings.exec(text)) !== null) {
                                        builder.add(match.index, match.index + match[0].length,
                                            Decoration.mark({class: 'cm-clojure-string'}));
                                    }

                                    // Highlight comments
                                    while ((match = patterns.comments.exec(text)) !== null) {
                                        try {
                                            var line = view.state.doc.lineAt(match.index);
                                            builder.add(match.index, line.to,
                                                Decoration.mark({class: 'cm-clojure-comment'}));
                                        } catch (e) {
                                            builder.add(match.index, match.index + match[0].length,
                                                Decoration.mark({class: 'cm-clojure-comment'}));
                                        }
                                    }

                                    // Highlight numbers
                                    while ((match = patterns.numbers.exec(text)) !== null) {
                                        builder.add(match.index, match.index + match[0].length,
                                            Decoration.mark({class: 'cm-clojure-number'}));
                                    }

                                    // Highlight keywords (like :keyword)
                                    while ((match = patterns.keywords2.exec(text)) !== null) {
                                        builder.add(match.index, match.index + match[0].length,
                                            Decoration.mark({class: 'cm-clojure-keyword2'}));
                                    }

                                    return builder.finish();
                                }
                            }, {
                                decorations: function(v) { return v.decorations; }
                            });

                            // Add the highlighter to the editor's state
                            var newState = editor.state.update({
                                effects: stateModule.StateEffect.appendConfig.of([ClojureHighlighter])
                            });
                            editor.dispatch(newState);
                            console.log('Clojure syntax highlighting added');
                        } catch (e) {
                            console.warn('Could not add Clojure highlighter:', e);
                        }
                    }).catch(function(err) {
                        console.warn('Could not load modules for highlighting:', err);
                    });
                }

                // Force focus to make it clear the editor is active
                setTimeout(function() {
                    editor.focus();
                }, 100);

                console.log('CodeMirror editor initialized successfully');

                // Update pendingCodeExecution with editor instance
                if (pendingCodeExecution) {
                    pendingCodeExecution.editor = editor;
                }
            } catch (e) {
                console.error('Failed to initialize CodeMirror:', e);
                console.error('Error details:', e.message, e.stack);

                // Try one more time without any extensions (in case extension caused the error)
                try {
                    console.log('Retrying with empty extensions...');
                    codeDisplayDiv.innerHTML = ''; // Clear any partial content
                    var state = window.CodeMirror.EditorState.create({
                        doc: code,
                        extensions: []
                    });
                    editor = new window.CodeMirror.EditorView({
                        state: state,
                        parent: codeDisplayDiv
                    });
                    editor.contentDOM.setAttribute('contenteditable', 'true');
                    editor.contentDOM.setAttribute('spellcheck', 'false');
                    if (pendingCodeExecution) {
                        pendingCodeExecution.editor = editor;
                    }
                    console.log('CodeMirror editor initialized on retry');
                } catch (e2) {
                    console.error('Retry also failed:', e2);
                    // Final fallback to plain text display
                    var pre = document.createElement('pre');
                    var codeEl = document.createElement('code');
                    codeEl.textContent = code;
                    pre.appendChild(codeEl);
                    codeDisplayDiv.appendChild(pre);
                }
            }
        } else {
            // Fallback if CodeMirror not loaded
            var missing = [];
            if (!window.CodeMirror) missing.push('CodeMirror object');
            if (!window.CodeMirror || !window.CodeMirror.EditorView) missing.push('EditorView');
            if (!window.CodeMirror || !window.CodeMirror.EditorState) missing.push('EditorState');
            console.warn('CodeMirror not available, missing:', missing.join(', '));
            console.warn('Using plain text display');
            var pre = document.createElement('pre');
            var codeEl = document.createElement('code');
            codeEl.textContent = code;
            pre.appendChild(codeEl);
            codeDisplayDiv.appendChild(pre);
        }
    }

    // Try to initialize immediately, or wait for CodeMirror to load
    function tryInit() {
        if (window.CodeMirror && window.CodeMirror.EditorView && window.CodeMirror.EditorState) {
            // Clear any existing content first
            codeDisplayDiv.innerHTML = '';
            initCodeMirror();
            return true;
        }
        return false;
    }

    if (!tryInit()) {
        // Wait for CodeMirror to load (module script loads asynchronously)
        var attempts = 0;
        var maxAttempts = 100; // 5 seconds at 50ms intervals
        var checkInterval = setInterval(function() {
            attempts++;
            if (tryInit()) {
                clearInterval(checkInterval);
            } else if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
                // Check if there's a pre element that should be replaced
                var pre = codeDisplayDiv.querySelector('pre');
                if (pre && window.CodeMirror && window.CodeMirror.EditorView && window.CodeMirror.EditorState) {
                    // Try to replace pre with editor one last time
                    try {
                        var codeText = pre.querySelector('code') ? pre.querySelector('code').textContent : pre.textContent;
                        codeDisplayDiv.innerHTML = '';
                        var state = window.CodeMirror.EditorState.create({
                            doc: codeText,
                            extensions: []
                        });
                        editor = new window.CodeMirror.EditorView({
                            state: state,
                            parent: codeDisplayDiv
                        });
                        editor.contentDOM.setAttribute('contenteditable', 'true');
                        editor.contentDOM.setAttribute('spellcheck', 'false');
                        if (pendingCodeExecution) {
                            pendingCodeExecution.editor = editor;
                        }
                        console.log('CodeMirror editor initialized in timeout handler');
                    } catch (e) {
                        console.error('Failed to initialize CodeMirror in timeout:', e);
                        // Final fallback
                        codeDisplayDiv.innerHTML = '';
                        var preEl = document.createElement('pre');
                        var codeEl = document.createElement('code');
                        codeEl.textContent = code;
                        preEl.appendChild(codeEl);
                        codeDisplayDiv.appendChild(preEl);
                    }
                } else {
                    console.error('CodeMirror failed to load after 5 seconds, using plain text display');
                    // Clear container and add fallback
                    codeDisplayDiv.innerHTML = '';
                    var preEl = document.createElement('pre');
                    var codeEl = document.createElement('code');
                    codeEl.textContent = code;
                    preEl.appendChild(codeEl);
                    codeDisplayDiv.appendChild(preEl);
                }
            }
        }, 50);
    }
}

function approveCodeExecution(messageId) {
    if (!pendingCodeExecution || !isConnected) return;

    // Get the edited code from CodeMirror if available
    var codeToExecute = pendingCodeExecution.code;
    if (pendingCodeExecution.editor) {
        try {
            codeToExecute = pendingCodeExecution.editor.state.doc.toString();
            console.log('Using edited code from CodeMirror');
        } catch (e) {
            console.warn('Failed to get code from CodeMirror, using original:', e);
        }
    }

    // Destroy CodeMirror editor if it exists
    if (pendingCodeExecution.editor) {
        try {
            pendingCodeExecution.editor.destroy();
        } catch (e) {
            console.warn('Error destroying CodeMirror editor:', e);
        }
    }

    // Remove the code preview card
    if (pendingCodeExecution.cardElement) {
        pendingCodeExecution.cardElement.remove();
    }

    // Update status to show execution
    removeAllStatusMessages();
    addStatusMessage('Executing code...', 'executing');

    // Send approval message to server with edited code
    ws.send(JSON.stringify({
        type: 'code_approved',
        messageId: messageId,
        code: codeToExecute
    }));

    pendingCodeExecution = null;
}

function rejectCodeExecution(messageId) {
    if (!pendingCodeExecution || !isConnected) return;

    // Destroy CodeMirror editor if it exists
    if (pendingCodeExecution.editor) {
        try {
            pendingCodeExecution.editor.destroy();
        } catch (e) {
            console.warn('Error destroying CodeMirror editor:', e);
        }
    }

    // Remove the code preview card
    if (pendingCodeExecution.cardElement) {
        pendingCodeExecution.cardElement.remove();
    }

    // Remove status messages
    removeAllStatusMessages();

    // Send rejection message to server
    ws.send(JSON.stringify({
        type: 'code_rejected',
        messageId: messageId
    }));

    addOutputMessage('Code execution cancelled by user', 'info');
    pendingCodeExecution = null;
}

// Event listeners
connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
sendBtn.addEventListener('click', sendMessage);
clearBtn.addEventListener('click', function() {
    aiOutput.innerHTML = '';
    var iframeDoc = getIframeDocument();
    if (iframeDoc) {
        iframeDoc.body.innerHTML = '<div class="canvas-placeholder" style="display: flex; align-items: center; justify-content: center; height: 100%; color: #858585; font-style: italic;">Results will be visualized here</div>';
    }
    activeStatusMessages = [];
    pendingCodeExecution = null;
});

userInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendMessage();
    }
});

// Keyboard shortcuts for code preview card
document.addEventListener('keydown', function(e) {
    // Only handle if code preview card is visible
    if (pendingCodeExecution && pendingCodeExecution.cardElement) {
        if (e.key === 'Enter' && !e.shiftKey) {
            // Enter to approve
            e.preventDefault();
            approveCodeExecution(pendingCodeExecution.messageId);
        } else if (e.key === 'Escape') {
            // Escape to reject
            e.preventDefault();
            rejectCodeExecution(pendingCodeExecution.messageId);
        }
    }
});

// Auto-connect on load
window.addEventListener('load', function() {
    // Initialize iframe document when iframe is ready
    if (canvasIframe) {
        canvasIframe.addEventListener('load', function() {
            getIframeDocument();
        });
        // Try to initialize immediately (in case iframe is already loaded)
        getIframeDocument();
    }
    connect();
});

