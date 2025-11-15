/*global module,console*/

/**
 * Clojure namespace and function discovery module
 * Provides discovery capabilities similar to code-mode's tool discovery
 * Uses nREPL to query namespace and function information
 */

var namespaceCache = {};
var functionCache = {};

/**
 * Discover available namespaces in the Clojure runtime
 * @param {Object} nreplConnection - nREPL connection object
 * @param {string} nreplSession - nREPL session ID
 * @param {Function} callback - Callback with (err, namespaces)
 */
function discoverNamespaces(nreplConnection, nreplSession, callback) {
    // Check cache first
    if (namespaceCache.allNamespaces) {
        return callback(null, namespaceCache.allNamespaces);
    }

    // Use Clojure code to list all loaded namespaces
    var code = '(sort (map str (keys (all-ns))))';

    nreplConnection.eval(code, 'user', nreplSession, function(err, messages) {
        if (err) {
            return callback(err, null);
        }

        // Extract value from messages
        var value = null;
        messages.forEach(function(msg) {
            if (msg.value !== undefined && msg.value !== null) {
                value = msg.value;
            }
        });

        if (!value) {
            return callback(new Error('No namespaces found'), null);
        }

        try {
            // Parse the result (should be a string representation of a vector)
            var resultHandler = require('./result-handler');
            var parsed = resultHandler.serializeResult(messages, 0);

            if (parsed.value && Array.isArray(parsed.value)) {
                namespaceCache.allNamespaces = parsed.value;
                callback(null, parsed.value);
            } else {
                // Try to parse as Clojure vector string
                var namespaces = [];
                if (typeof value === 'string') {
                    // Simple parsing - extract namespace names from vector string
                    var match = value.match(/\[(.*?)\]/);
                    if (match) {
                        var nsList = match[1];
                        namespaces = nsList.split(/\s+/)
                            .map(function(ns) { return ns.trim().replace(/^"|"$/g, ''); })
                            .filter(function(ns) { return ns.length > 0; });
                    }
                }
                namespaceCache.allNamespaces = namespaces;
                callback(null, namespaces);
            }
        } catch (e) {
            callback(e, null);
        }
    });
}

/**
 * Get documentation for a namespace
 * @param {Object} nreplConnection - nREPL connection object
 * @param {string} nreplSession - nREPL session ID
 * @param {string} namespace - Namespace name (e.g., 'babashka.fs')
 * @param {Function} callback - Callback with (err, docs)
 */
function getNamespaceDocs(nreplConnection, nreplSession, namespace, callback) {
    var cacheKey = 'docs:' + namespace;
    if (namespaceCache[cacheKey]) {
        return callback(null, namespaceCache[cacheKey]);
    }

    // Get namespace documentation and public functions
    var code = [
        '(require \'' + namespace + ')',
        '(let [ns-obj (find-ns \'' + namespace + ')',
        '      ns-doc (-> ns-obj meta :doc)',
        '      public-vars (ns-publics \'' + namespace + ')',
        '      functions (map (fn [[name var]]',
        '                        {:name (str name)',
        '                         :doc (-> var meta :doc)',
        '                         :arglists (-> var meta :arglists)',
        '                         :file (-> var meta :file)',
        '                         :line (-> var meta :line)})',
        '                      public-vars)]',
        '  {:namespace "' + namespace + '"',
        '   :doc ns-doc',
        '   :functions (sort-by :name functions)})'
    ].join('\n');

    nreplConnection.eval(code, 'user', nreplSession, function(err, messages) {
        if (err) {
            return callback(err, null);
        }

        var resultHandler = require('./result-handler');
        var parsed = resultHandler.serializeResult(messages, 0);

        if (parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) && parsed.value !== null) {
            namespaceCache[cacheKey] = parsed.value;
            callback(null, parsed.value);
        } else if (parsed.value && typeof parsed.value === 'string') {
            // Try to parse as JSON if it's a string
            try {
                var jsonValue = JSON.parse(parsed.value);
                if (jsonValue && typeof jsonValue === 'object' && !Array.isArray(jsonValue) && jsonValue !== null) {
                    namespaceCache[cacheKey] = jsonValue;
                    callback(null, jsonValue);
                } else {
                    callback(new Error('Failed to parse namespace docs: ' + parsed.value), null);
                }
            } catch (e) {
                callback(new Error('Failed to parse namespace docs: ' + parsed.value + ' - ' + e.message), null);
            }
        } else {
            // Debug: log what we got
            console.log('Debug getNamespaceDocs - parsed:', JSON.stringify(parsed, null, 2));
            callback(new Error('Failed to get namespace docs: value=' + JSON.stringify(parsed.value) + ', type=' + typeof parsed.value), null);
        }
    });
}

/**
 * Search for functions matching a query
 * @param {Object} nreplConnection - nREPL connection object
 * @param {string} nreplSession - nREPL session ID
 * @param {string} query - Search query (function name or keyword)
 * @param {Function} callback - Callback with (err, functions)
 */
function searchFunctions(nreplConnection, nreplSession, query, callback) {
    var cacheKey = 'search:' + query;
    if (functionCache[cacheKey]) {
        return callback(null, functionCache[cacheKey]);
    }

    // Search across all namespaces for functions matching the query
    var code = [
        '(let [query "' + query + '"',
        '      all-nss (all-ns)',
        '      results (atom [])]',
        '  (doseq [ns all-nss]',
        '    (try',
        '      (require ns)',
        '      (doseq [[name var] (ns-publics ns)]',
        '        (let [name-str (str name)',
        '              doc-str (or (-> var meta :doc) "")]',
        '          (when (or (.contains name-str query)',
        '                    (.contains doc-str query))',
        '            (swap! results conj',
        '                   {:namespace (str ns)',
        '                    :name name-str',
        '                    :doc (-> var meta :doc)',
        '                    :arglists (-> var meta :arglists)}))))',
        '      (catch Exception e nil)))',
        '  (sort-by (juxt :namespace :name) @results))'
    ].join('\n');

    nreplConnection.eval(code, 'user', nreplSession, function(err, messages) {
        if (err) {
            return callback(err, null);
        }

        var resultHandler = require('./result-handler');
        var parsed = resultHandler.serializeResult(messages, 0);

        if (parsed.value && Array.isArray(parsed.value)) {
            functionCache[cacheKey] = parsed.value;
            callback(null, parsed.value);
        } else {
            callback(new Error('Failed to search functions'), null);
        }
    });
}

/**
 * Get function signature and documentation
 * @param {Object} nreplConnection - nREPL connection object
 * @param {string} nreplSession - nREPL session ID
 * @param {string} functionName - Fully qualified function name (e.g., 'babashka.fs/list-dir')
 * @param {Function} callback - Callback with (err, signature)
 */
function getFunctionSignature(nreplConnection, nreplSession, functionName, callback) {
    var cacheKey = 'sig:' + functionName;
    if (functionCache[cacheKey]) {
        return callback(null, functionCache[cacheKey]);
    }

    // Parse namespace and function name
    var parts = functionName.split('/');
    if (parts.length !== 2) {
        return callback(new Error('Function name must be in format namespace/function'), null);
    }

    var namespace = parts[0];
    var fnName = parts[1];

    var code = [
        '(require \'' + namespace + ')',
        '(let [var-obj (resolve \'' + functionName + ')',
        '      meta-info (when var-obj (meta var-obj))]',
        '  (when meta-info',
        '    {:name "' + functionName + '"',
        '     :doc (:doc meta-info)',
        '     :arglists (:arglists meta-info)',
        '     :file (:file meta-info)',
        '     :line (:line meta-info)',
        '     :column (:column meta-info)}))'
    ].join('\n');

    nreplConnection.eval(code, 'user', nreplSession, function(err, messages) {
        if (err) {
            return callback(err, null);
        }

        var resultHandler = require('./result-handler');
        var parsed = resultHandler.serializeResult(messages, 0);

        if (parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) && parsed.value !== null) {
            functionCache[cacheKey] = parsed.value;
            callback(null, parsed.value);
        } else if (parsed.value && typeof parsed.value === 'string') {
            // Try to parse as JSON if it's a string
            try {
                var jsonValue = JSON.parse(parsed.value);
                if (jsonValue && typeof jsonValue === 'object' && !Array.isArray(jsonValue) && jsonValue !== null) {
                    functionCache[cacheKey] = jsonValue;
                    callback(null, jsonValue);
                } else {
                    callback(new Error('Failed to parse function signature: ' + parsed.value), null);
                }
            } catch (e) {
                callback(new Error('Failed to parse function signature: ' + parsed.value + ' - ' + e.message), null);
            }
        } else {
            // Debug: log what we got
            console.log('Debug getFunctionSignature - parsed:', JSON.stringify(parsed, null, 2));
            callback(new Error('Function not found: value=' + JSON.stringify(parsed.value) + ', type=' + typeof parsed.value), null);
        }
    });
}

/**
 * Clear discovery caches
 */
function clearCache() {
    namespaceCache = {};
    functionCache = {};
}

module.exports = {
    discoverNamespaces: discoverNamespaces,
    getNamespaceDocs: getNamespaceDocs,
    searchFunctions: searchFunctions,
    getFunctionSignature: getFunctionSignature,
    clearCache: clearCache
};

