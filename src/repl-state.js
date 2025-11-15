/*global module*/

/**
 * REPL State Tracking Module
 * Tracks functions, variables, and execution results per session
 */

// In-memory state storage: sessionId -> state
var sessionStates = {};

/**
 * Get or create state for a session
 * @param {string} sessionId - Session ID
 * @returns {Object} State object for the session
 */
function getSessionState(sessionId) {
    if (!sessionStates[sessionId]) {
        sessionStates[sessionId] = {
            lastResult: null,
            resultHistory: [], // Keep last N results (e.g., 10)
            functions: {}, // name -> { name, signature, docstring, namespace, definedAt }
            variables: {} // name -> { name, type, definedAt }
        };
    }
    return sessionStates[sessionId];
}

/**
 * Clear state for a session
 * @param {string} sessionId - Session ID
 */
function clearSessionState(sessionId) {
    delete sessionStates[sessionId];
}

/**
 * Update last result for a session
 * @param {string} sessionId - Session ID
 * @param {*} value - Result value
 * @param {string} type - Result type (e.g., 'map', 'vector', 'string')
 */
function updateLastResult(sessionId, value, type) {
    var state = getSessionState(sessionId);
    var resultEntry = {
        value: value,
        type: type,
        timestamp: Date.now()
    };

    state.lastResult = resultEntry;

    // Add to history (keep last 10)
    state.resultHistory.push(resultEntry);
    if (state.resultHistory.length > 10) {
        state.resultHistory.shift();
    }
}

/**
 * Add a function to the state
 * @param {string} sessionId - Session ID
 * @param {string} name - Function name
 * @param {Object} funcInfo - Function information { signature, docstring, namespace }
 */
function addFunction(sessionId, name, funcInfo) {
    var state = getSessionState(sessionId);
    state.functions[name] = {
        name: name,
        signature: funcInfo.signature || null,
        docstring: funcInfo.docstring || null,
        namespace: funcInfo.namespace || 'user',
        definedAt: Date.now()
    };
}

/**
 * Add a variable to the state
 * @param {string} sessionId - Session ID
 * @param {string} name - Variable name
 * @param {string} type - Variable type
 */
function addVariable(sessionId, name, type) {
    var state = getSessionState(sessionId);
    state.variables[name] = {
        name: name,
        type: type || 'unknown',
        definedAt: Date.now()
    };
}

/**
 * Get state summary for a session (formatted for AI)
 * @param {string} sessionId - Session ID
 * @returns {Object} State summary
 */
function getStateSummary(sessionId) {
    var state = getSessionState(sessionId);

    return {
        lastResult: state.lastResult ? {
            type: state.lastResult.type,
            preview: getValuePreview(state.lastResult.value),
            timestamp: state.lastResult.timestamp
        } : null,
        resultHistory: state.resultHistory.map(function(r) {
            return {
                type: r.type,
                preview: getValuePreview(r.value),
                timestamp: r.timestamp
            };
        }),
        functions: Object.keys(state.functions).map(function(name) {
            var func = state.functions[name];
            return {
                name: func.name,
                signature: func.signature,
                docstring: func.docstring,
                namespace: func.namespace
            };
        }),
        variables: Object.keys(state.variables).map(function(name) {
            var varInfo = state.variables[name];
            return {
                name: varInfo.name,
                type: varInfo.type
            };
        })
    };
}

/**
 * Get a preview of a value (for display in state summary)
 * @param {*} value - Value to preview
 * @returns {string} Preview string
 */
function getValuePreview(value) {
    if (value === null || value === undefined) {
        return 'nil';
    }

    var str = String(value);

    // Truncate long strings
    if (str.length > 100) {
        return str.substring(0, 100) + '...';
    }

    // For objects/arrays, show structure
    if (typeof value === 'object') {
        if (Array.isArray(value)) {
            return '[' + value.length + ' items]';
        } else {
            var keys = Object.keys(value);
            return '{' + keys.length + ' keys}';
        }
    }

    return str;
}

module.exports = {
    getSessionState: getSessionState,
    clearSessionState: clearSessionState,
    updateLastResult: updateLastResult,
    addFunction: addFunction,
    addVariable: addVariable,
    getStateSummary: getStateSummary
};

