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
            addOutputMessage(message.content, 'assistant');
            break;
        case 'result':
            visualizeResult(message.data);
            break;
        case 'error':
            addOutputMessage('Error: ' + message.message, 'error');
            break;
        case 'status':
            addOutputMessage(message.message, 'info');
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
    messageDiv.textContent = text;
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

    // Primary HTML rendering - if HTML is present, use it
    if (type === 'html') {
        // Check for HTML in various possible locations
        var htmlContent = result.html || result.data || result.content;
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
 * Render HTML content in the canvas
 * Uses innerHTML to render the HTML directly
 */
function renderHTML(container, htmlContent) {
    // Create a wrapper div for the HTML content
    var htmlDiv = document.createElement('div');
    htmlDiv.className = 'html-content';
    htmlDiv.style.padding = '1rem';
    htmlDiv.style.maxWidth = '100%';
    htmlDiv.style.overflow = 'auto';

    // Set the HTML content directly
    // Note: This renders HTML as-is. For production, consider sanitization
    htmlDiv.innerHTML = htmlContent;

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

// Event listeners
connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
sendBtn.addEventListener('click', sendMessage);
clearBtn.addEventListener('click', function() {
    aiOutput.innerHTML = '';
    canvasContainer.innerHTML = '<div class="canvas-placeholder">Results will be visualized here</div>';
});

userInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendMessage();
    }
});

// Auto-connect on load
window.addEventListener('load', function() {
    connect();
});

