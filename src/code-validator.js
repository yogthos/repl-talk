/*global module,console,require*/

/**
 * Code Validator using clj-kondo
 * Validates Clojure code before execution to catch syntax errors and other issues early
 */

var childProcess = require('child_process');

/**
 * Validate Clojure code using clj-kondo
 * @param {string} code - The Clojure code to validate
 * @param {string} cljKondoPath - Path to clj-kondo executable (default: 'clj-kondo')
 * @param {Function} callback - Callback function (err, result)
 *   - err: Error if validation process failed
 *   - result: Object with validation results
 *     - valid: boolean - whether code passed validation
 *     - errors: array - array of validation errors (if any)
 */
function validateCode(code, cljKondoPath, callback) {
    if (typeof cljKondoPath === 'function') {
        callback = cljKondoPath;
        cljKondoPath = 'clj-kondo';
    }

    if (!code || typeof code !== 'string') {
        return callback(new Error('Code must be a non-empty string'), null);
    }

    // clj-kondo command: lint from stdin with JSON output
    var args = [
        '--lint', '-',
        '--config', '{:output {:format :json}}'
    ];

    var cljKondo = childProcess.spawn(cljKondoPath, args, {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    var stdout = '';
    var stderr = '';
    var hasError = false;

    cljKondo.stdout.on('data', function(data) {
        stdout += data.toString();
    });

    cljKondo.stderr.on('data', function(data) {
        stderr += data.toString();
    });

    cljKondo.on('error', function(err) {
        // clj-kondo not found or can't be executed
        hasError = true;
        console.warn('clj-kondo not available:', err.message);
        console.warn('Skipping code validation. Install clj-kondo for pre-execution validation.');
        // Return success (no validation) - graceful degradation
        callback(null, {
            valid: true,
            errors: [],
            skipped: true,
            reason: 'clj-kondo not available'
        });
    });

    cljKondo.on('close', function(code) {
        if (hasError) {
            return; // Already handled in error event
        }

        // clj-kondo returns non-zero exit code if errors found
        // But we still need to parse the output to get the actual errors
        try {
            var result = {
                valid: true,
                errors: [],
                skipped: false
            };

            // Parse JSON output
            if (stdout.trim()) {
                var output = JSON.parse(stdout);

                // clj-kondo output structure: {findings: [...]}
                if (output.findings && Array.isArray(output.findings)) {
                    // Filter for errors and warnings (level: :error or :warning)
                    var findings = output.findings.filter(function(finding) {
                        return finding.level === 'error' || finding.level === 'warning';
                    });

                    if (findings.length > 0) {
                        result.valid = false;
                        result.errors = findings.map(function(finding) {
                            return {
                                level: finding.level,
                                message: finding.message,
                                row: finding.row || 0,
                                col: finding.col || 0,
                                filename: finding.filename || 'stdin'
                            };
                        });
                    }
                }
            }

            callback(null, result);
        } catch (parseErr) {
            // If we can't parse the output, log it but don't fail
            console.warn('Failed to parse clj-kondo output:', parseErr.message);
            console.warn('clj-kondo stdout:', stdout);
            console.warn('clj-kondo stderr:', stderr);
            // Return as valid (graceful degradation)
            callback(null, {
                valid: true,
                errors: [],
                skipped: true,
                reason: 'Failed to parse clj-kondo output'
            });
        }
    });

    // Write code to stdin
    cljKondo.stdin.write(code, 'utf8');
    cljKondo.stdin.end();
}

module.exports = {
    validateCode: validateCode
};

