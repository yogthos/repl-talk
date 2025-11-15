/*global module,require,__dirname*/

/**
 * Database module for managing per-session conversation history
 * Uses SQLite to store sessions and messages
 */

var Database = require('better-sqlite3');
var path = require('path');
var crypto = require('crypto');

// Database file path
var dbPath = path.join(__dirname, '../conversations.db');
var db = new Database(dbPath);

// Initialize database schema
function initializeSchema() {
    // Create sessions table
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Create messages table
    db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            tool_calls TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        )
    `);

    // Create index for faster queries
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at)
    `);
}

// Initialize schema on module load
initializeSchema();

/**
 * Generate a unique session ID (UUID v4)
 */
function generateSessionId() {
    return crypto.randomUUID();
}

/**
 * Create a new session in the database
 * @returns {string} The session ID
 */
function createSession() {
    var sessionId = generateSessionId();
    var stmt = db.prepare('INSERT INTO sessions (id, created_at, last_activity) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)');
    stmt.run(sessionId);
    return sessionId;
}

/**
 * Get all messages for a session, ordered by creation time
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of message objects
 */
function getSessionHistory(sessionId) {
    var stmt = db.prepare('SELECT role, content, tool_calls, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC');
    var rows = stmt.all(sessionId);

    return rows.map(function(row) {
        var message = {
            role: row.role,
            content: row.content || null
        };

        // Parse tool_calls if present (for assistant messages)
        if (row.tool_calls) {
            try {
                message.tool_calls = JSON.parse(row.tool_calls);
            } catch (e) {
                console.error('Error parsing tool_calls for session', sessionId, ':', e);
            }
        }

        // For tool role messages, the content is a JSON string of the entire tool result
        // Parse it to reconstruct the full tool result object
        if (row.role === 'tool' && row.content) {
            try {
                var toolResult = JSON.parse(row.content);
                // If it's a valid tool result object, use it
                if (toolResult.role === 'tool' && toolResult.tool_call_id) {
                    return toolResult;
                }
            } catch (e) {
                // If parsing fails, keep the content as-is
                console.warn('Error parsing tool result content for session', sessionId, ':', e);
            }
        }

        return message;
    });
}

/**
 * Add a message to the database
 * @param {string} sessionId - The session ID
 * @param {string} role - Message role (user, assistant, tool)
 * @param {string} content - Message content
 * @param {Array} toolCalls - Optional tool_calls array
 */
function addMessage(sessionId, role, content, toolCalls) {
    var toolCallsJson = toolCalls ? JSON.stringify(toolCalls) : null;
    var stmt = db.prepare('INSERT INTO messages (session_id, role, content, tool_calls) VALUES (?, ?, ?, ?)');
    stmt.run(sessionId, role, content, toolCallsJson);

    // Update session activity
    updateSessionActivity(sessionId);
}

/**
 * Update the last_activity timestamp for a session
 * @param {string} sessionId - The session ID
 */
function updateSessionActivity(sessionId) {
    var stmt = db.prepare('UPDATE sessions SET last_activity = CURRENT_TIMESTAMP WHERE id = ?');
    stmt.run(sessionId);
}

/**
 * Delete a session and all its messages
 * @param {string} sessionId - The session ID
 */
function deleteSession(sessionId) {
    // Delete messages first (foreign key constraint)
    var deleteMessages = db.prepare('DELETE FROM messages WHERE session_id = ?');
    deleteMessages.run(sessionId);

    // Delete session
    var deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
    deleteSession.run(sessionId);
}

/**
 * Check if a session exists
 * @param {string} sessionId - The session ID
 * @returns {boolean} True if session exists
 */
function sessionExists(sessionId) {
    var stmt = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE id = ?');
    var result = stmt.get(sessionId);
    return result.count > 0;
}

/**
 * Close database connection (for cleanup)
 */
function close() {
    db.close();
}

module.exports = {
    createSession: createSession,
    getSessionHistory: getSessionHistory,
    addMessage: addMessage,
    updateSessionActivity: updateSessionActivity,
    deleteSession: deleteSession,
    sessionExists: sessionExists,
    close: close
};

