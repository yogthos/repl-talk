/*global process,module,require,__dirname*/

// Configuration for the Babashka nREPL AI Tool
// Loads from config.json and can be overridden via environment variables

var fs = require('fs');
var path = require('path');

// Load config.json
var configPath = path.join(__dirname, '../config.json');
var configJson = {};
try {
    var configContent = fs.readFileSync(configPath, 'utf8');
    configJson = JSON.parse(configContent);
} catch (e) {
    console.warn('Warning: Could not load config.json, using defaults:', e.message);
}

/**
 * Resolve environment variable references in config values
 * Supports ${VAR_NAME} syntax
 */
function resolveEnvVars(value) {
    if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
        var envVar = value.slice(2, -1);
        return process.env[envVar] || '';
    }
    return value;
}

/**
 * Load model configuration, resolving env vars and applying env overrides
 */
function loadModelConfig(modelKey, modelConfig) {
    var envPrefix = 'AI_' + modelKey.toUpperCase() + '_';

    return {
        name: modelConfig.name || modelKey,
        endpoint: process.env[envPrefix + 'ENDPOINT'] || resolveEnvVars(modelConfig.endpoint),
        apiKey: process.env[envPrefix + 'API_KEY'] ||
                (modelKey === 'deepseek' ? (process.env.DEEPSEEK_API_KEY || '') : resolveEnvVars(modelConfig.apiKey)),
        model: process.env[envPrefix + 'MODEL'] || modelConfig.model,
        temperature: process.env[envPrefix + 'TEMPERATURE'] ?
                     parseFloat(process.env[envPrefix + 'TEMPERATURE']) :
                     (modelConfig.temperature || 0.7),
        maxTokens: process.env[envPrefix + 'MAX_TOKENS'] ?
                   parseInt(process.env[envPrefix + 'MAX_TOKENS']) :
                   (modelConfig.maxTokens || 4096)
    };
}

// Build models configuration
var models = {};
if (configJson.models) {
    Object.keys(configJson.models).forEach(function(key) {
        models[key] = loadModelConfig(key, configJson.models[key]);
    });
} else {
    // Fallback defaults if config.json doesn't exist
    models.local = loadModelConfig('local', {
        endpoint: 'http://localhost:11434/v1',
        apiKey: 'ollama',
        model: 'llama3.2',
        temperature: 0.7,
        maxTokens: 4096
    });
    models.deepseek = loadModelConfig('deepseek', {
        endpoint: 'https://api.deepseek.com/v1',
        apiKey: process.env.DEEPSEEK_API_KEY || '',
        model: 'deepseek-chat',
        temperature: 0.7,
        maxTokens: 4096
    });
}

var config = {
    // AI Model Configuration
    ai: {
        models: models,
        defaultModel: process.env.AI_DEFAULT_MODEL || configJson.defaultModel || 'local',
        systemPrompt: configJson.systemPrompt || 'You are a Clojure expert with deep knowledge of Babashka and its libraries. You have access to a single powerful tool: eval_clojure, which can execute any Clojure code. When the user asks you to do something, analyze the task and write Clojure code to accomplish it. You can use Babashka libraries like babashka.fs for file operations, babashka.http-client for HTTP requests, and any other Clojure/Babashka functionality. Write complete, working Clojure code that returns useful results.',
        codeModePromptTemplate: configJson.codeModePromptTemplate || '',
        tool: {
            name: configJson.tool && configJson.tool.name || 'eval_clojure',
            description: configJson.tool && configJson.tool.description || 'Evaluates Clojure code in a Babashka nREPL session. Use this to execute any Clojure code, including file operations, HTTP requests, data processing, etc. The code should be a complete Clojure expression that returns a value. You can use Babashka libraries like babashka.fs, babashka.http-client, etc.',
            parameterDescription: configJson.tool && configJson.tool.parameterDescription || 'The Clojure code to evaluate. Should be a complete expression that returns a value.'
        }
    },

    // nREPL Configuration
    nrepl: {
        hostname: process.env.NREPL_HOSTNAME || undefined,
        port: process.env.NREPL_PORT ? parseInt(process.env.NREPL_PORT) : undefined,
        babashkaPath: process.env.BABASHKA_PATH || 'bb',
        verbose: process.env.NREPL_VERBOSE === 'true',
        startTimeout: parseInt(process.env.NREPL_START_TIMEOUT || '10000')
    },

    // Web Server Configuration
    server: {
        port: parseInt(process.env.PORT || '3000'),
        host: process.env.HOST || 'localhost'
    },

    // Code Validation Configuration
    codeValidation: {
        enabled: process.env.ENABLE_CODE_VALIDATION !== 'false' &&
                 (configJson.codeValidation === undefined || configJson.codeValidation.enabled !== false),
        cljKondoPath: process.env.CLJ_KONDO_PATH ||
                     (configJson.codeValidation && configJson.codeValidation.cljKondoPath) ||
                     'clj-kondo'
    }
};

module.exports = config;

