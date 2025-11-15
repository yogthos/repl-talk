/*global module,console*/

/**
 * Handles serialization of Clojure nREPL results to JSON
 * and determines visualization type for canvas rendering
 */

/**
 * Serialize Clojure result from nREPL to JSON
 * Handles maps, lists, strings, numbers, keywords, etc.
 * @param {Array} nreplMessages - Array of nREPL messages
 * @param {number} executionTime - Execution time in milliseconds (optional)
 * @returns {Object} Serialized result with structured logs
 */
function serializeResult(nreplMessages, executionTime) {
    if (!nreplMessages || nreplMessages.length === 0) {
        return { value: null, error: null, type: 'null', logs: [], executionTime: executionTime };
    }

    // Extract value and error from nREPL messages
    var value = null;
    var error = null;
    var out = '';
    var err = '';
    var rootCause = null;
    var rootEx = null;
    var stackTrace = null;
    var logs = [];
    var timestamp = new Date().toISOString();

    var hasErrorStatus = false;

    nreplMessages.forEach(function(msg) {
        if (msg.value !== undefined && msg.value !== null) {
            value = msg.value;
        }
        if (msg.err) {
            err += msg.err;
            // Add stderr messages as ERROR level logs
            var errLines = msg.err.split('\n').filter(function(line) { return line.trim(); });
            errLines.forEach(function(line) {
                logs.push({
                    level: 'ERROR',
                    message: line,
                    timestamp: timestamp
                });
            });
        }
        if (msg.out) {
            out += msg.out;
            // Add stdout messages as INFO level logs
            // Check for WARN patterns
            var outLines = msg.out.split('\n').filter(function(line) { return line.trim(); });
            outLines.forEach(function(line) {
                var level = 'INFO';
                // Detect WARN patterns (case-insensitive)
                if (/warn/i.test(line) || /warning/i.test(line)) {
                    level = 'WARN';
                }
                logs.push({
                    level: level,
                    message: line,
                    timestamp: timestamp
                });
            });
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
            stackTrace: stackTrace || undefined,
            logs: logs,
            executionTime: executionTime
        };
    }

    // Try to parse the value as Clojure data structure
    // nREPL returns values as strings, so we need to parse them
    var parsedValue = null;
    var parseError = null;
    var useRawValue = false;

    if (value !== null && value !== undefined) {
        try {
            // Try to parse as JSON first (if it's already JSON)
            parsedValue = JSON.parse(value);
        } catch (e1) {
            try {
                // Try to parse as Clojure EDN-like structure
                parsedValue = parseClojureValue(value);

                // Validate the parsed result - check if it's clearly malformed
                if (!isValidParsedResult(parsedValue, value)) {
                    console.warn('Parsed result appears malformed, falling back to raw value');
                    useRawValue = true;
                    parsedValue = value;
                    parseError = 'Parsing produced malformed result';
                }
            } catch (e2) {
                // If parsing fails, treat as string
                parsedValue = value;
                parseError = e2.message;
            }
        }
    }

    // Determine result type for visualization
    // If we're using raw value, treat it as a string
    var resultType = useRawValue ? 'string' : determineType(parsedValue);

    return {
        value: parsedValue,
        raw: value,
        type: resultType,
        stdout: out || undefined,
        stderr: err || undefined,
        parseError: parseError || undefined,
        logs: logs,
        executionTime: executionTime
    };
}

/**
 * Validate that a parsed result is not clearly malformed
 * Returns false if the result appears to be a parsing failure
 */
function isValidParsedResult(parsed, raw) {
    if (typeof parsed === 'string') {
        // If raw value looks like a complex structure but parsed is just a string,
        // it might be a parsing failure
        var rawTrimmed = raw.trim();
        if ((rawTrimmed.startsWith('[') || rawTrimmed.startsWith('{') || rawTrimmed.startsWith('(')) &&
            !rawTrimmed.startsWith('"')) {
            // Raw looks like a collection but parsed is a string - likely malformed
            return false;
        }
        return true;
    }

    if (Array.isArray(parsed)) {
        // Check if array contains string fragments that look like parsing failures
        // e.g., ['{:name', '".cursor",', ':size'] instead of [{name: '.cursor', size: ...}]
        if (parsed.length > 0) {
            var firstItem = parsed[0];
            // If first item is a string that looks like a fragment of a map/vector
            if (typeof firstItem === 'string') {
                // Check for common patterns that indicate parsing failure
                if (firstItem.startsWith('{') || firstItem.startsWith('[') ||
                    firstItem.startsWith(':') && firstItem.length < 50) {
                    // Check if raw value suggests this should be objects, not strings
                    var rawTrimmed = raw.trim();
                    if (rawTrimmed.startsWith('[') && rawTrimmed.includes('{:') &&
                        parsed.every(function(item) { return typeof item === 'string'; })) {
                        // Array of strings when we expect objects - likely malformed
                        return false;
                    }
                }
            }
        }
        return true;
    }

    if (typeof parsed === 'object' && parsed !== null) {
        // Check if object is empty when raw suggests it should have content
        var keys = Object.keys(parsed);
        var rawTrimmed = raw.trim();
        if (keys.length === 0 && rawTrimmed.startsWith('{') && rawTrimmed.length > 2) {
            // Empty object when raw suggests content - might be malformed
            return false;
        }
        return true;
    }

    return true;
}

/**
 * Parse Clojure EDN-like value with proper bracket/brace awareness
 * Handles nested structures (vectors, lists, maps)
 */
function parseClojureValue(str) {
    str = str.trim();
    if (str === '') return str;

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

    // Try to parse as string (starts and ends with ")
    if (str.startsWith('"') && str.endsWith('"')) {
        try {
            return JSON.parse(str); // JSON strings are compatible
        } catch (e) {
            // If JSON parsing fails, return the string without quotes
            return str.slice(1, -1);
        }
    }

    // Try to parse as keyword (starts with :)
    if (str.startsWith(':')) {
        return str;
    }

    // Try to parse as vector (starts with [ and ends with ])
    if (str.startsWith('[') && str.endsWith(']')) {
        return parseCollection(str, '[', ']');
    }

    // Try to parse as list (starts with ( and ends with ))
    if (str.startsWith('(') && str.endsWith(')')) {
        return parseCollection(str, '(', ')');
    }

    // Try to parse as map (starts with { and ends with })
    if (str.startsWith('{') && str.endsWith('}')) {
        return parseMap(str);
    }

    // Default: return as string
    return str;
}

/**
 * Parse a collection (vector or list) with proper bracket matching
 */
function parseCollection(str, openChar, closeChar) {
    var inner = str.slice(1, -1).trim();
    if (inner === '') return [];

    var items = [];
    var current = '';
    var depth = 0;
    var inString = false;
    var escapeNext = false;

    for (var i = 0; i < inner.length; i++) {
        var char = inner[i];
        var prevChar = i > 0 ? inner[i - 1] : '';

        if (escapeNext) {
            current += char;
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            current += char;
            escapeNext = true;
            continue;
        }

        if (char === '"' && prevChar !== '\\') {
            inString = !inString;
            current += char;
            continue;
        }

        if (inString) {
            current += char;
            continue;
        }

        // Track depth for nested structures
        if (char === '[' || char === '(' || char === '{') {
            depth++;
            current += char;
        } else if (char === ']' || char === ')' || char === '}') {
            depth--;
            current += char;
        } else if (depth === 0 && (char === ' ' || char === '\n' || char === '\t')) {
            // Only split on whitespace when at top level
            if (current.trim()) {
                items.push(current.trim());
                current = '';
            }
        } else {
            current += char;
        }
    }

    // Add the last item if any
    if (current.trim()) {
        items.push(current.trim());
    }

    return items.map(parseClojureValue);
}

/**
 * Parse a map with proper brace matching
 */
function parseMap(str) {
    var inner = str.slice(1, -1).trim();
    if (inner === '') return {};

    var map = {};
    var current = '';
    var depth = 0;
    var inString = false;
    var escapeNext = false;
    var key = null;
    var keyStart = 0;

    for (var i = 0; i < inner.length; i++) {
        var char = inner[i];
        var prevChar = i > 0 ? inner[i - 1] : '';

        if (escapeNext) {
            current += char;
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            current += char;
            escapeNext = true;
            continue;
        }

        if (char === '"' && prevChar !== '\\') {
            inString = !inString;
            current += char;
            continue;
        }

        if (inString) {
            current += char;
            continue;
        }

        // Track depth for nested structures
        if (char === '[' || char === '(' || char === '{') {
            depth++;
            current += char;
        } else if (char === ']' || char === ')' || char === '}') {
            depth--;
            current += char;
        } else if (depth === 0) {
            if (char === ' ' || char === '\n' || char === '\t' || char === ',') {
                // Whitespace or comma at top level
                if (current.trim()) {
                    if (key === null) {
                        // This is a key
                        key = current.trim();
                        current = '';
                    } else {
                        // This is a value
                        var parsedKey = parseClojureValue(key);
                        var parsedValue = parseClojureValue(current.trim());
                        // Convert keyword to string key
                        var mapKey = typeof parsedKey === 'string' && parsedKey.startsWith(':')
                            ? parsedKey.slice(1)
                            : String(parsedKey);
                        map[mapKey] = parsedValue;
                        key = null;
                        current = '';
                    }
                }
            } else {
                current += char;
            }
        } else {
            current += char;
        }
    }

    // Handle the last key-value pair
    if (current.trim()) {
        if (key === null) {
            // Odd number of elements - malformed map, return empty
            console.warn('Malformed map: odd number of elements');
            return {};
        } else {
            var parsedKey = parseClojureValue(key);
            var parsedValue = parseClojureValue(current.trim());
            var mapKey = typeof parsedKey === 'string' && parsedKey.startsWith(':')
                ? parsedKey.slice(1)
                : String(parsedKey);
            map[mapKey] = parsedValue;
        }
    }

    return map;
}

/**
 * Detect if a string contains HTML content
 */
function isHTML(str) {
    if (typeof str !== 'string') return false;
    // Check for actual HTML tags (not just any < followed by letter)
    // Must have opening tag with valid HTML tag name, and optionally closing tag
    // This prevents false positives from Clojure code like (< or (> or (<! etc.
    var htmlTagPattern = /<\/?[a-z][a-z0-9]*[\s\S]*?>/i;
    // Also check for common HTML structure patterns
    var hasHtmlStructure = /<(html|head|body|div|span|p|table|ul|ol|h[1-6]|a|img|button|form|input)[\s>]/i.test(str);
    // Must have at least one complete HTML tag (opening or self-closing)
    var hasCompleteTag = /<[a-z][a-z0-9]*[\s\S]*?(\/>|>)/i.test(str);

    return (htmlTagPattern.test(str) || hasHtmlStructure) && hasCompleteTag;
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
        stderr: result.stderr,
        error: result.error,
        logs: result.logs || [],
        executionTime: result.executionTime
    };

    // Enhanced error formatting for AI consumption
    if (result.type === 'error' && result.error) {
        // Add structured error information to help AI understand and fix
        formatted.errorDetails = {
            message: result.error,
            isRetryable: true,
            context: 'Code execution failed. Analyze the error and generate corrected code.'
        };

        // Provide hints based on error patterns
        if (result.error.includes('IllegalArgumentException')) {
            formatted.errorDetails.hint = 'Type mismatch error. Check data types and conversions.';
        } else if (result.error.includes('FileNotFoundException') || result.error.includes('No such file')) {
            formatted.errorDetails.hint = 'File or path not found. Verify the path exists.';
        } else if (result.error.includes('ClassNotFoundException') || result.error.includes('Could not locate')) {
            formatted.errorDetails.hint = 'Missing dependency. Add proper require statement.';
        } else if (result.error.includes('CompilerException') || result.error.includes('Syntax error')) {
            formatted.errorDetails.hint = 'Syntax error. Review Clojure syntax.';
        } else if (result.error.includes('ArityException')) {
            formatted.errorDetails.hint = 'Wrong number of arguments. Check function signature.';
        }
    }

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

