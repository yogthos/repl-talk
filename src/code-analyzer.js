/*global module*/

/**
 * Code Analyzer Module
 * Parses Clojure code to extract function and variable definitions
 */

/**
 * Extract function and variable definitions from Clojure code
 * @param {string} code - Clojure code string
 * @returns {Object} { functions: [...], variables: [...] }
 */
function analyzeCode(code) {
    var functions = [];
    var variables = [];

    if (!code || typeof code !== 'string') {
        return { functions: functions, variables: variables };
    }

    // Remove comments (lines starting with ;)
    var codeWithoutComments = code.split('\n')
        .filter(function(line) {
            return !line.trim().match(/^\s*;/);
        })
        .join('\n');

    // Extract defn definitions: (defn name [args] ...) or (defn name "docstring" [args] ...)
    var defnPattern = /\(defn\s+([^\s\(\)\[\]]+)\s*(?:"[^"]*")?\s*(\[[^\]]*\])?/g;
    var match;
    while ((match = defnPattern.exec(codeWithoutComments)) !== null) {
        var name = match[1];
        var args = match[2] || '[]';
        functions.push({
            name: name,
            type: 'defn',
            signature: args,
            docstring: extractDocstring(code, match.index),
            namespace: 'user' // Default namespace
        });
    }

    // Extract defmacro definitions: (defmacro name [args] ...)
    var defmacroPattern = /\(defmacro\s+([^\s\(\)\[\]]+)\s*(?:"[^"]*")?\s*(\[[^\]]*\])?/g;
    while ((match = defmacroPattern.exec(codeWithoutComments)) !== null) {
        var name = match[1];
        var args = match[2] || '[]';
        functions.push({
            name: name,
            type: 'defmacro',
            signature: args,
            docstring: extractDocstring(code, match.index),
            namespace: 'user'
        });
    }

    // Extract defmethod definitions: (defmethod name dispatch-val [args] ...)
    var defmethodPattern = /\(defmethod\s+([^\s\(\)\[\]]+)\s+([^\s\(\)\[\]]+)\s*(\[[^\]]*\])?/g;
    while ((match = defmethodPattern.exec(codeWithoutComments)) !== null) {
        var name = match[1];
        var dispatchVal = match[2];
        var args = match[3] || '[]';
        functions.push({
            name: name + ' (dispatch: ' + dispatchVal + ')',
            type: 'defmethod',
            signature: args,
            docstring: extractDocstring(code, match.index),
            namespace: 'user'
        });
    }

    // Extract def with function value: (def name (fn [args] ...)) or (def name #(...))
    var defWithFnPattern = /\(def\s+([^\s\(\)\[\]]+)\s*\(fn\s*(\[[^\]]*\])?/g;
    while ((match = defWithFnPattern.exec(codeWithoutComments)) !== null) {
        var name = match[1];
        var args = match[2] || '[]';
        functions.push({
            name: name,
            type: 'def (fn)',
            signature: args,
            docstring: null,
            namespace: 'user'
        });
    }

    // Extract simple def (variables): (def name value)
    // This is trickier - we need to avoid matching def with fn values
    // Look for def that's not followed by (fn or #(
    var defVarPattern = /\(def\s+([^\s\(\)\[\]]+)\s+(?!\(fn\s|#\(|\(fn\[)/g;
    var processedDefs = new Set();
    while ((match = defVarPattern.exec(codeWithoutComments)) !== null) {
        var name = match[1];
        // Skip if we already processed this as a function
        if (!processedDefs.has(name)) {
            // Try to determine type from the value
            var afterDef = codeWithoutComments.substring(match.index + match[0].length);
            var type = inferType(afterDef);
            variables.push({
                name: name,
                type: type
            });
            processedDefs.add(name);
        }
    }

    return { functions: functions, variables: variables };
}

/**
 * Extract docstring from code near a match position
 * @param {string} code - Full code string
 * @param {number} position - Position of the definition
 * @returns {string|null} Docstring or null
 */
function extractDocstring(code, position) {
    // Look for docstring after the function name
    var afterPos = code.substring(position);
    var docstringMatch = afterPos.match(/"([^"]*)"/);
    if (docstringMatch) {
        return docstringMatch[1];
    }
    return null;
}

/**
 * Infer type from a value expression
 * @param {string} valueExpr - Value expression string
 * @returns {string} Inferred type
 */
function inferType(valueExpr) {
    var trimmed = valueExpr.trim();

    if (trimmed.startsWith('{')) {
        return 'map';
    } else if (trimmed.startsWith('[')) {
        return 'vector';
    } else if (trimmed.startsWith('(') && !trimmed.startsWith('(fn')) {
        return 'list';
    } else if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
        return 'string';
    } else if (trimmed.match(/^\d/)) {
        return 'number';
    } else if (trimmed === 'true' || trimmed === 'false') {
        return 'boolean';
    } else if (trimmed === 'nil') {
        return 'nil';
    }

    return 'unknown';
}

/**
 * Check if code requests result binding
 * Looks for comment ;; bind-result or similar markers
 * @param {string} code - Clojure code string
 * @returns {boolean} True if binding is requested
 */
function requestsResultBinding(code) {
    if (!code || typeof code !== 'string') {
        return false;
    }

    // Check for ;; bind-result comment
    var bindPattern = /;;\s*bind-result/i;
    if (bindPattern.test(code)) {
        return true;
    }

    // Check for ;; bind or ;; save-result
    var altPattern = /;;\s*(bind|save-result)/i;
    if (altPattern.test(code)) {
        return true;
    }

    return false;
}

module.exports = {
    analyzeCode: analyzeCode,
    requestsResultBinding: requestsResultBinding
};

