/**
 * Tests for HTML extraction functionality
 * Verifies that commentary text and tool markers are properly stripped
 */

var test = require('node:test');
var assert = require('node:assert');

/**
 * Extract HTML from mixed text/HTML content (backend version)
 * This is a copy of the function from src/ai-client.js for testing
 */
function extractHTML(content) {
    if (!content || typeof content !== 'string') {
        return null;
    }

    var trimmed = content.trim();

    // Remove tool call markers if present
    trimmed = trimmed.replace(/<[｜|][^>]*?[｜|]>/g, '');

    // Remove common patterns that might slip through
    trimmed = trimmed.replace(/[｜▁]/g, '');

    // Check if content starts with HTML already (no commentary)
    if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
        return trimmed;
    }

    // Try to find and extract HTML from mixed content

    // 1. Look for DOCTYPE declaration
    var doctypeMatch = trimmed.match(/<!DOCTYPE[\s\S]*/i);
    if (doctypeMatch) {
        return doctypeMatch[0].trim();
    }

    // 2. Look for <html> tag
    var htmlMatch = trimmed.match(/<html[\s\S]*/i);
    if (htmlMatch) {
        return htmlMatch[0].trim();
    }

    // 3. Look for substantial HTML structure
    var structureMatch = trimmed.match(/(<(?:div|body|section|article|main|table|ul|ol|h[1-6]|p)[^>]*>[\s\S]*)/i);
    if (structureMatch) {
        var htmlContent = structureMatch[1].trim();

        // Try to find the matching closing tag
        var firstTag = htmlContent.match(/^<(\w+)/);
        if (firstTag) {
            var tagName = firstTag[1];
            var closingTagPattern = new RegExp('</' + tagName + '>(?!.*</' + tagName + '>)', 'i');
            var closingMatch = htmlContent.match(closingTagPattern);
            if (closingMatch) {
                var endIndex = closingMatch.index + closingMatch[0].length;
                return htmlContent.substring(0, endIndex).trim();
            }
        }

        return htmlContent;
    }

    // 4. Look for any HTML tags
    var firstTagMatch = trimmed.match(/<[a-z][a-z0-9]*[\s\S]*?>/i);
    if (firstTagMatch) {
        var startIndex = firstTagMatch.index;
        var potentialHtml = trimmed.substring(startIndex);

        var lastClosingTag = potentialHtml.match(/.*(<\/[a-z][a-z0-9]*>)/i);
        if (lastClosingTag) {
            return potentialHtml.substring(0, lastClosingTag.index + lastClosingTag[1].length).trim();
        }

        return potentialHtml.trim();
    }

    // If no HTML found, return null
    return null;
}

test.describe('HTML Extraction Tests', function() {

    test.describe('Pure HTML (no commentary)', function() {
        test('should preserve complete HTML documents', function() {
            var input = '<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>';
            var result = extractHTML(input);
            assert.strictEqual(result, input);
        });

        test('should preserve HTML starting with <html>', function() {
            var input = '<html><body><p>Content</p></body></html>';
            var result = extractHTML(input);
            assert.strictEqual(result, input);
        });

        test('should preserve HTML starting with <div>', function() {
            var input = '<div class="container"><p>Content</p></div>';
            var result = extractHTML(input);
            assert.strictEqual(result, input);
        });

        test('should preserve HTML tables', function() {
            var input = '<table><thead><tr><th>Name</th><th>Age</th></tr></thead><tbody><tr><td>John</td><td>30</td></tr></tbody></table>';
            var result = extractHTML(input);
            assert.strictEqual(result, input);
        });
    });

    test.describe('HTML with commentary before', function() {
        test('should strip "Now I\'ll create" commentary', function() {
            var input = 'Now I\'ll create an HTML table to display the files:<table><tr><td>Test</td></tr></table>';
            var result = extractHTML(input);
            assert.strictEqual(result, '<table><tr><td>Test</td></tr></table>');
        });

        test('should strip "Here\'s" commentary', function() {
            var input = 'Here\'s the result:<div><p>Content</p></div>';
            var result = extractHTML(input);
            assert.strictEqual(result, '<div><p>Content</p></div>');
        });

        test('should strip "Let me create" commentary', function() {
            var input = 'Let me create a visualization:<div>Data</div>';
            var result = extractHTML(input);
            assert.strictEqual(result, '<div>Data</div>');
        });

        test('should extract HTML from mixed content with DOCTYPE', function() {
            var input = 'Some explanatory text here\n<!DOCTYPE html><html><body>Content</body></html>';
            var result = extractHTML(input);
            assert.strictEqual(result, '<!DOCTYPE html><html><body>Content</body></html>');
        });
    });

    test.describe('HTML with tool call markers', function() {
        test('should remove tool call markers', function() {
            var input = '<｜tool▁calls▁begin｜><table><tr><td>Test</td></tr></table><｜tool▁calls▁end｜>';
            var result = extractHTML(input);
            assert.strictEqual(result, '<table><tr><td>Test</td></tr></table>');
        });

        test('should remove tool_sep markers', function() {
            var input = 'Text<｜tool▁sep｜><div>Content</div>';
            var result = extractHTML(input);
            assert.strictEqual(result, '<div>Content</div>');
        });

        test('should remove special Unicode characters', function() {
            var input = '｜▁<table><tr><td>Test</td></tr></table>▁｜';
            var result = extractHTML(input);
            assert.strictEqual(result, '<table><tr><td>Test</td></tr></table>');
        });
    });

    test.describe('HTML with commentary after', function() {
        test('should extract only the HTML portion and remove trailing text', function() {
            var input = '<div><p>Content</p></div> And here is some extra text that should be removed.';
            var result = extractHTML(input);
            assert.strictEqual(result, '<div><p>Content</p></div>');
        });

        test('should handle table with trailing commentary', function() {
            var input = '<table><tr><td>Data</td></tr></table> This table shows the results.';
            var result = extractHTML(input);
            assert.strictEqual(result, '<table><tr><td>Data</td></tr></table>');
        });
    });

    test.describe('Complex mixed content', function() {
        test('should extract HTML from commentary + markers + HTML + commentary', function() {
            var input = 'Now I\'ll create an HTML table:<｜tool▁calls▁begin｜><table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>John</td></tr></tbody></table><｜tool▁calls▁end｜> This shows the data.';
            var result = extractHTML(input);
            assert.ok(result.includes('<table>'), 'Should contain table tag');
            assert.ok(result.includes('</table>'), 'Should contain closing table tag');
            assert.ok(!result.includes('Now I\'ll'), 'Should not contain commentary');
            assert.ok(!result.includes('｜'), 'Should not contain tool markers');
        });

        test('should handle nested HTML structures', function() {
            var input = 'Commentary: <div class="outer"><div class="inner"><p>Nested content</p></div></div>';
            var result = extractHTML(input);
            assert.strictEqual(result, '<div class="outer"><div class="inner"><p>Nested content</p></div></div>');
        });
    });

    test.describe('Edge cases', function() {
        test('should return null for null input', function() {
            var result = extractHTML(null);
            assert.strictEqual(result, null);
        });

        test('should return null for undefined input', function() {
            var result = extractHTML(undefined);
            assert.strictEqual(result, null);
        });

        test('should return null for empty string', function() {
            var result = extractHTML('');
            assert.strictEqual(result, null);
        });

        test('should return null for text with no HTML', function() {
            var result = extractHTML('Just plain text with no HTML tags');
            assert.strictEqual(result, null);
        });

        test('should handle single self-closing tags', function() {
            var input = '<img src="test.jpg" />';
            var result = extractHTML(input);
            assert.strictEqual(result, '<img src="test.jpg" />');
        });

        test('should handle HTML with inline styles', function() {
            var input = '<div style="color: red; padding: 10px;"><p>Styled content</p></div>';
            var result = extractHTML(input);
            assert.strictEqual(result, input);
        });
    });

    test.describe('Real-world example from bug report', function() {
        test('should extract clean HTML from the reported issue', function() {
            var input = 'Now I\'ll create an HTML table to display the files in a nicely formatted way:<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>eval_clojure<｜tool▁sep｜>{"code_string": "..."}<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
            var result = extractHTML(input);
            // Since there's no actual HTML in this example, it should return null
            assert.strictEqual(result, null);
        });

        test('should handle actual HTML response after tool execution', function() {
            // This simulates what the AI should return after tool execution
            var input = '<table style="border-collapse: collapse; width: 100%;"><thead><tr><th>Name</th><th>Type</th></tr></thead><tbody><tr><td>file.txt</td><td>File</td></tr></tbody></table>';
            var result = extractHTML(input);
            assert.strictEqual(result, input);
        });
    });
});

module.exports = {
    extractHTML: extractHTML
};

