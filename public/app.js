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
var modelSelect = document.getElementById('model-select');

// State for status messages and code execution
var activeStatusMessages = [];
var pendingCodeExecution = null;

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
    // Clear previous visualization
    canvasContainer.innerHTML = '';

    if (!result || result.error) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'visualization';
        errorDiv.innerHTML = '<div style="color: #f48771; padding: 1rem;">Error: ' +
                            (result.error || 'Unknown error') + '</div>';
        canvasContainer.appendChild(errorDiv);
        return;
    }

    var type = result.type || 'unknown';
    var vizDiv = document.createElement('div');
    vizDiv.className = 'visualization';

    console.log('visualizeResult - type:', type, 'result:', result);

    // Primary HTML rendering - if HTML is present, use it
    if (type === 'html') {
        // Check for HTML in various possible locations
        var htmlContent = result.html || result.data || result.content;
        console.log('HTML content to render:', htmlContent ? htmlContent.substring(0, 200) + '...' : 'none');
        if (htmlContent) {
            renderHTML(vizDiv, htmlContent);
        } else {
            // Fallback: try to extract from value if it's a string
            var data = result.value;
            if (typeof data === 'string' && data.trim().startsWith('<')) {
                renderHTML(vizDiv, data);
            } else {
                renderJSON(vizDiv, result);
            }
        }
    } else {
        // Fallback to legacy rendering for non-HTML results
        var data = result.value;
        switch (type) {
            case 'table-data':
                renderTable(vizDiv, data);
                break;
            case 'chart-data':
                renderChart(vizDiv, data);
                break;
            case 'map':
                renderMap(vizDiv, data);
                break;
            case 'list':
                renderList(vizDiv, data);
                break;
            case 'string':
            case 'number':
            case 'boolean':
                renderSimple(vizDiv, data);
                break;
            default:
                renderJSON(vizDiv, result);
        }
    }

    canvasContainer.appendChild(vizDiv);
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
 */
function extractHTML(content) {
    if (!content || typeof content !== 'string') {
        return content;
    }

    // Check if content starts with HTML already
    var trimmed = content.trim();
    if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<div')) {
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

    // If no HTML found, return original content
    return content;
}

/**
 * Render HTML content in the canvas
 * Handles both HTML and markdown content
 */
function renderHTML(container, htmlContent) {
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
        var tempDiv = document.createElement('div');
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
    var htmlDiv = document.createElement('div');
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

function renderTable(container, data) {
    var table = document.createElement('table');

    if (Array.isArray(data) && data.length > 0) {
        // Array of objects
        var headers = Object.keys(data[0]);
        var thead = document.createElement('thead');
        var headerRow = document.createElement('tr');
        headers.forEach(function(h) {
            var th = document.createElement('th');
            th.textContent = h;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');
        data.forEach(function(row) {
            var tr = document.createElement('tr');
            headers.forEach(function(h) {
                var td = document.createElement('td');
                td.textContent = String(row[h] || '');
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
    } else if (typeof data === 'object') {
        // Single object as table
        var thead = document.createElement('thead');
        var headerRow = document.createElement('tr');
        var th1 = document.createElement('th');
        th1.textContent = 'Key';
        var th2 = document.createElement('th');
        th2.textContent = 'Value';
        headerRow.appendChild(th1);
        headerRow.appendChild(th2);
        thead.appendChild(headerRow);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');
        Object.keys(data).forEach(function(key) {
            var tr = document.createElement('tr');
            var td1 = document.createElement('td');
            td1.textContent = key;
            var td2 = document.createElement('td');
            td2.textContent = String(data[key]);
            tr.appendChild(td1);
            tr.appendChild(td2);
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
    }

    container.appendChild(table);
}

function renderChart(container, data) {
    // Simple text-based chart representation
    // For production, integrate a charting library like Chart.js
    var chartDiv = document.createElement('div');
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

        var pre = document.createElement('pre');
        pre.textContent = chartText;
        pre.style.fontFamily = 'monospace';
        pre.style.whiteSpace = 'pre';
        chartDiv.appendChild(pre);
    } else {
        chartDiv.textContent = 'Chart data: ' + JSON.stringify(data);
    }

    container.appendChild(chartDiv);
}

function renderMap(container, data) {
    renderTable(container, data);
}

function renderList(container, data) {
    if (Array.isArray(data)) {
        var ul = document.createElement('ul');
        ul.style.listStyle = 'none';
        ul.style.padding = '0';
        data.forEach(function(item) {
            var li = document.createElement('li');
            li.style.padding = '0.5rem';
            li.style.borderBottom = '1px solid #3e3e42';
            li.textContent = String(item);
            ul.appendChild(li);
        });
        container.appendChild(ul);
    } else {
        renderSimple(container, data);
    }
}

function renderSimple(container, data) {
    var div = document.createElement('div');
    div.style.padding = '1rem';
    div.style.fontSize = '1.2rem';
    div.textContent = String(data);
    container.appendChild(div);
}

function renderJSON(container, result) {
    var jsonDiv = document.createElement('div');
    jsonDiv.className = 'json-view';
    var pre = document.createElement('pre');
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
    headerDiv.innerHTML = '<span>📝</span><span>Generated Code - Review Before Execution</span>';

    // Code display
    var codeDisplayDiv = document.createElement('div');
    codeDisplayDiv.className = 'code-display';
    var pre = document.createElement('pre');
    var codeEl = document.createElement('code');
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    codeDisplayDiv.appendChild(pre);

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

    pendingCodeExecution = { code: code, messageId: messageId, cardElement: cardDiv };
}

function approveCodeExecution(messageId) {
    if (!pendingCodeExecution || !isConnected) return;

    // Remove the code preview card
    if (pendingCodeExecution.cardElement) {
        pendingCodeExecution.cardElement.remove();
    }

    // Update status to show execution
    removeAllStatusMessages();
    addStatusMessage('Executing code...', 'executing');

    // Send approval message to server
    ws.send(JSON.stringify({
        type: 'code_approved',
        messageId: messageId
    }));

    pendingCodeExecution = null;
}

function rejectCodeExecution(messageId) {
    if (!pendingCodeExecution || !isConnected) return;

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
    canvasContainer.innerHTML = '<div class="canvas-placeholder">Results will be visualized here</div>';
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
    connect();
});

