/*global module,console*/

/**
 * Handles serialization of Clojure nREPL results to JSON
 * and determines visualization type for canvas rendering
 */

/**
 * Serialize Clojure result from nREPL to JSON
 * Handles maps, lists, strings, numbers, keywords, etc.
 */
function serializeResult(nreplMessages) {
    if (!nreplMessages || nreplMessages.length === 0) {
        return { value: null, error: null, type: 'null' };
    }

    // Extract value and error from nREPL messages
    var value = null;
    var error = null;
    var out = '';
    var err = '';
    var rootCause = null;
    var rootEx = null;
    var stackTrace = null;

    var hasErrorStatus = false;

    nreplMessages.forEach(function(msg) {
        if (msg.value !== undefined && msg.value !== null) {
            value = msg.value;
        }
        if (msg.err) {
            err += msg.err;
        }
        if (msg.out) {
            out += msg.out;
        }
        // Check status first to determine if this is an error
        if (msg.status && msg.status.indexOf('error') > -1) {
            hasErrorStatus = true;
        }

        if (msg.ex) {
            // msg.ex might be a Java class name or error message
            var exStr = String(msg.ex);
            // Only treat as error if it's not just "class " or if there's an error status
            if (exStr.trim() && exStr.trim() !== 'class ') {
                error = exStr;
            } else if (hasErrorStatus && !error) {
                // Only treat "class " as error if status indicates error
                error = 'Evaluation error: ' + exStr;
            }
        }
        // Check for root-ex (root exception)
        if (msg['root-ex']) {
            rootEx = String(msg['root-ex']);
        }
        // Check for root-cause in message
        if (msg['root-cause']) {
            rootCause = msg['root-cause'];
        }
        // Check for stack trace
        if (msg['stack-trace']) {
            stackTrace = msg['stack-trace'];
        }
    });

    // If we have error status but no error yet, try to set error from available sources
    if (hasErrorStatus && !error) {
        // Prefer rootCause, then rootEx, then err
        if (rootCause) {
            error = rootCause;
        } else if (rootEx && rootEx.trim() && rootEx.trim() !== 'class ') {
            error = rootEx;
        } else if (err && err.trim()) {
            error = err.trim();
        } else {
            error = 'Evaluation error';
        }
    }

    // Only treat as error if there's an actual exception, root-cause, or error status
    // stderr (err) alone is not necessarily an error - it could be warnings
    // rootEx alone is also not necessarily an error unless there's an error status
    if (error || rootCause || hasErrorStatus) {
        // Build comprehensive error message
        // Priority: error > rootCause > rootEx > err (when hasErrorStatus)
        var errorMessage = error;

        // If error is just the generic message and we have rootCause, use rootCause
        if (errorMessage === 'Evaluation error' && rootCause) {
            errorMessage = rootCause;
        } else if (!errorMessage && rootCause) {
            errorMessage = rootCause;
        } else if (!errorMessage && rootEx && rootEx.trim() && rootEx.trim() !== 'class ') {
            errorMessage = rootEx;
        } else if (!errorMessage && hasErrorStatus && err && err.trim()) {
            errorMessage = err.trim();
        } else if (!errorMessage) {
            errorMessage = 'Evaluation error';
        }

        // Append stderr if available and different (for context)
        if (err && err.trim() && err.trim() !== errorMessage) {
            errorMessage += (errorMessage ? '\n' : '') + err.trim();
        }

        return {
            value: null,
            error: errorMessage,
            type: 'error',
            stdout: out || undefined,
            stderr: err || undefined,
            rootCause: rootCause || undefined,
            rootEx: rootEx || undefined,
            stackTrace: stackTrace || undefined
        };
    }

    // Try to parse the value as Clojure data structure
    // nREPL returns values as strings, so we need to parse them
    var parsedValue = null;
    var parseError = null;

    if (value !== null && value !== undefined) {
        try {
            // Try to parse as JSON first (if it's already JSON)
            parsedValue = JSON.parse(value);
        } catch (e1) {
            try {
                // Try to parse as Clojure EDN-like structure
                // This is a simplified parser - for production, use a proper EDN parser
                parsedValue = parseClojureValue(value);
            } catch (e2) {
                // If parsing fails, treat as string
                parsedValue = value;
                parseError = e2.message;
            }
        }
    }

    // Determine result type for visualization
    var resultType = determineType(parsedValue);

    return {
        value: parsedValue,
        raw: value,
        type: resultType,
        stdout: out || undefined,
        parseError: parseError || undefined
    };
}

/**
 * Simple Clojure value parser (handles basic structures)
 * For production, consider using a proper EDN parser library
 */
function parseClojureValue(str) {
    str = str.trim();

    // Try to detect and parse common Clojure structures
    if (str === 'nil') return null;
    if (str === 'true') return true;
    if (str === 'false') return false;

    // Try to parse as number
    if (/^-?\d+$/.test(str)) {
        return parseInt(str, 10);
    }
    if (/^-?\d+\.\d+$/.test(str)) {
        return parseFloat(str);
    }

    // Try to parse as vector/list (starts with [ or ( and ends with ] or ))
    if ((str.startsWith('[') && str.endsWith(']')) ||
        (str.startsWith('(') && str.endsWith(')'))) {
        // Simple list parsing - split by whitespace and commas
        var inner = str.slice(1, -1).trim();
        if (inner === '') return [];
        // This is very basic - a real parser would handle nested structures
        var items = inner.split(/\s+/).filter(function(s) { return s.length > 0; });
        return items.map(parseClojureValue);
    }

    // Try to parse as map (starts with { and ends with })
    if (str.startsWith('{') && str.endsWith('}')) {
        var inner = str.slice(1, -1).trim();
        if (inner === '') return {};
        // Very basic map parsing - real parser needed for production
        var map = {};
        // This is simplified - proper EDN parser needed
        return map;
    }

    // Try to parse as keyword (starts with :)
    if (str.startsWith(':')) {
        return str;
    }

    // Try to parse as string (starts and ends with ")
    if (str.startsWith('"') && str.endsWith('"')) {
        return JSON.parse(str); // JSON strings are compatible
    }

    // Default: return as string
    return str;
}

/**
 * Detect if a string contains HTML content
 */
function isHTML(str) {
    if (typeof str !== 'string') return false;
    // Check for common HTML tags
    var htmlTagPattern = /<\/?[a-z][\s\S]*>/i;
    return htmlTagPattern.test(str);
}

/**
 * Determine the type of result for visualization routing
 */
function determineType(value) {
    if (value === null || value === undefined) {
        return 'null';
    }

    if (typeof value === 'boolean') {
        return 'boolean';
    }

    if (typeof value === 'number') {
        return 'number';
    }

    if (typeof value === 'string') {
        // Check if it's HTML content first
        if (isHTML(value)) {
            return 'html';
        }
        // Check if it looks like a URL or image
        if (/^https?:\/\//.test(value)) {
            return 'url';
        }
        if (/^data:image\//.test(value)) {
            return 'image';
        }
        return 'string';
    }

    if (Array.isArray(value)) {
        // Check if array of numbers (potential chart data)
        if (value.length > 0 && typeof value[0] === 'number') {
            return 'chart-data';
        }
        // Check if array of objects (potential table data)
        if (value.length > 0 && typeof value[0] === 'object' && !Array.isArray(value[0])) {
            return 'table-data';
        }
        return 'list';
    }

    if (typeof value === 'object') {
        // Check if it's a map/object that could be a table
        var keys = Object.keys(value);
        if (keys.length > 0) {
            // If all values are same type, might be table column
            var firstValue = value[keys[0]];
            var allSameType = keys.every(function(k) {
                return typeof value[k] === typeof firstValue;
            });
            if (allSameType && (typeof firstValue === 'number' || typeof firstValue === 'string')) {
                return 'table-data';
            }
        }
        return 'map';
    }

    return 'unknown';
}

/**
 * Format result for display in canvas
 */
function formatForVisualization(result) {
    var formatted = {
        type: result.type,
        data: result.value,
        raw: result.raw,
        stdout: result.stdout,
        error: result.error
    };

    // Add visualization hints based on type
    switch (result.type) {
        case 'chart-data':
            formatted.chartType = 'line'; // Could be determined from data
            break;
        case 'table-data':
            formatted.columns = Array.isArray(result.value) && result.value.length > 0
                ? Object.keys(result.value[0])
                : Object.keys(result.value);
            break;
        case 'map':
            formatted.keys = Object.keys(result.value);
            break;
    }

    return formatted;
}

module.exports = {
    serializeResult: serializeResult,
    determineType: determineType,
    formatForVisualization: formatForVisualization,
    isHTML: isHTML
};

