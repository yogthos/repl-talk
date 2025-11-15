/*global console,require,module,process,__dirname,setTimeout,clearTimeout*/

/*
 * This will start a Babashka nREPL server via `bb --nrepl-server` to which the node
 * client will connect. If hostname and port are provided, it will connect to an
 * existing server instead of spawning a new one.
 *
 */

var path = require("path");
var ps = require("child_process");
var util = require("util");
var merge = Object.assign;

// note, the JVM will stick around when we just kill the spawning process
// so we have to do a tree kill for the process. unfortunately the "tree-kill"
// lib is currently not working on Mac OS, so we need this little hack:
var kill = (process.platform === 'darwin') ?
    function(pid, signal) {
        ps.exec(util.format("ps a -o pid -o ppid |"
                          + "grep %s | awk '{ print $1 }' |"
                          + "xargs kill -s %s", pid, signal || 'SIGTERM'));
    } : require('tree-kill');


// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// Server start implementation. Tries to detect timeouts
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

function startSentinel(options, serverState, thenDo) {
    // If connecting to external server, skip sentinel
    if (serverState.external) {
        options.verbose && console.log('Connecting to existing nREPL server at %s:%s', serverState.hostname, serverState.port);
        thenDo && thenDo(null, serverState);
        return;
    }

    var proc = serverState.proc,
        thenDoCalled = false;

    if (options.verbose) {
        proc.on('close', function(code) { console.log("nREPL server stopped with code %s: %s", code); });
        proc.on('error', function(error) { console.log("nREPL server error %s", error); });
        proc.stdout.pipe(process.stdout);
        proc.stderr.pipe(process.stdout);
    }

    proc.on('close', function(_) { serverState.exited = true; });

    // Also set a fallback timer - if no message detected, assume server started after delay
    var fallbackTimer = setTimeout(function() {
        if (!serverState.started && !thenDoCalled) {
            // Default to localhost and the port we tried to start
            serverState.hostname = 'localhost';
            serverState.port = 1668; // Our default
            serverState.started = true;
            thenDoCalled = true;
            options.verbose && console.log('nREPL server assumed started (no message detected)');
            thenDo && thenDo(null, serverState);
        }
    }, 2000); // Wait 2 seconds before assuming it's ready

    // Babashka nREPL may not output a startup message, so we'll try both:
    // 1. Check for startup messages in output
    // 2. After a short delay, try to connect anyway
    checkOutputForServerStart(['Started nREPL server', 'nREPL server ready', 'nREPL server started'], fallbackTimer);

    // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
    // helper

    function serverStartDance(serverOutput) {
        grabHostnameAndPortFromOutput(serverOutput);
        // Ensure we have valid hostname and port
        if (!serverState.hostname) {
            serverState.hostname = 'localhost';
        }
        if (!serverState.port) {
            serverState.port = 1667; // Babashka default
        }
        serverState.started = true;
        thenDoCalled = true;
        if (options.verbose) {
            console.log('nREPL server started at', serverState.hostname + ':' + serverState.port);
        }
        thenDo && thenDo(null, serverState);
    }

    function timeout() {
        if (thenDoCalled) return;
        thenDoCalled = true;
        thenDo && thenDo(new Error("nrepl server start timeout"), null);
    }

    function checkOutputForServerStart(expectedOutputs, fallbackTimer) {
        var expectedArray = Array.isArray(expectedOutputs) ? expectedOutputs : [expectedOutputs];
        var timeoutProc = setTimeout(timeout, options.startTimeout),
            outListener = gatherOut("stdout", check),
            errListener = gatherOut("stderr", check);
        proc.stdout.on('data', outListener);
        proc.stderr.on('data', errListener);

        function check(string) {
            // Check if any of the expected outputs are found
            var found = expectedArray.some(function(expected) {
                return string.indexOf(expected) !== -1;
            });
            if (!found) return;
            proc.stdout.removeListener('data', outListener);
            proc.stderr.removeListener('data', errListener);
            clearTimeout(timeoutProc);
            if (fallbackTimer) clearTimeout(fallbackTimer);
            if (options.verbose) {
                console.log('Detected nREPL server start in output:', string.slice(-200));
            }
            serverStartDance(string);
        }
    }

    function gatherOut(type, subscriber) {
        return function(data) {
            serverState[type] = Buffer.concat([serverState[type], data]);
            subscriber(String(serverState[type]));
        }
    }

    function grabHostnameAndPortFromOutput(output) {
        if (!output) return
        // Try multiple patterns for different nREPL server outputs
        // Pattern 1: "on port X on host Y" (standard nREPL format)
        var match = output.match(/on port ([0-9]+) on host ([^\s]+)/);
        // Pattern 2: "Started nREPL server at host:port" (Babashka style)
        if (!match) match = output.match(/Started nREPL server at ([^\s:]+):([0-9]+)/);
        // Pattern 3: "nREPL server ready at host:port" (alternative Babashka format)
        if (!match) match = output.match(/nREPL server ready at ([^\s:]+):([0-9]+)/);
        // Pattern 4: "nREPL server started on port X" (port only)
        if (!match) match = output.match(/nREPL server started on port ([0-9]+)/);
        // Pattern 5: "nREPL server ready on port X" (port only)
        if (!match) match = output.match(/nREPL server ready on port ([0-9]+)/);
        // Pattern 6: Just look for "port X" anywhere
        if (!match) match = output.match(/port ([0-9]+)/);

        if (match) {
            // If we have both hostname and port from match
            if (match[2]) {
                serverState.hostname = match[2];
                serverState.port = parseInt(match[1]);
            } else if (match[1]) {
                // Only port found
                serverState.port = parseInt(match[1]);
                serverState.hostname = 'localhost'; // Default to localhost
            }
        } else {
            // If no match, try to extract port from any number that looks like a port
            var portMatch = output.match(/:([0-9]{4,5})\b/);
            if (portMatch) {
                serverState.port = parseInt(portMatch[1]);
                serverState.hostname = 'localhost';
            }
        }
    }

}

function startServer(hostname, port, projectPath, babashkaPath, thenDo) {
    try {
        // If both hostname and port are provided, we'll connect to existing server
        // Return a mock server state that indicates we're connecting to existing
        if (hostname && port) {
            thenDo(null, {
                proc: null,
                stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0),
                hostname: hostname,
                port: port,
                started: true, // Already started (external)
                exited: false,
                timedout: undefined,
                external: true // Flag to indicate external server
            });
            return;
        }

        // Otherwise, spawn a new Babashka nREPL server
        // Babashka format: bb --nrepl-server [host:port]
        var procArgs = ["--nrepl-server"];
        var serverHost = hostname || 'localhost';
        // Use port 1668 if 1667 is likely in use (common default)
        // User can specify a different port if needed
        var serverPort = port || 1668;

        procArgs.push(serverHost + ':' + serverPort.toString());
        var proc = ps.spawn(babashkaPath || 'bb', procArgs, {cwd: projectPath});
    } catch (e) { thenDo(e, null); return; }
    thenDo(null, {
        proc: proc,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        hostname: undefined, port: undefined, // set when started
        started: false,
        exited: false,
        timedout: undefined,
        external: false
    });
}


// -=-=-=-=-=-=-=-=-=-=-
// the actual interface
// -=-=-=-=-=-=-=-=-=-=-

var defaultOptions = {
    startTimeout: 10*1000, // milliseconds
    verbose: false,
    projectPath: process.cwd(),
    // if host / port stay undefined they are choosen by babashka
    // if both are provided, connect to existing server instead of spawning
    hostname: undefined,
    port: undefined,
    babashkaPath: 'bb' // path to babashka executable
}

function start(options, thenDo) {
    options = merge(merge({}, defaultOptions), options);
    startServer(options.hostname, options.port,
                options.projectPath, options.babashkaPath, function(err, serverState) {
                    if (err) thenDo(err, null);
                    else startSentinel(options, serverState, thenDo);
                });
}

function stop(serverState, thenDo) {
    // If external server, nothing to stop
    if (serverState.external) {
        thenDo && thenDo(null);
        return;
    }

    if (serverState.exited) { thenDo(null); return; }
    if (!serverState.proc) { thenDo(null); return; }

    var timeout = setTimeout(function() {
        // If process hasn't closed after 2 seconds, force kill it
        if (!serverState.exited && serverState.proc && !serverState.proc.killed) {
            console.log("Server stop timeout, forcing SIGKILL");
            kill(serverState.proc.pid, 'SIGKILL');
            // Give it a moment, then call callback anyway
            setTimeout(function() {
                if (thenDo) thenDo(null);
            }, 500);
        }
    }, 2000);

    kill(serverState.proc.pid, 'SIGTERM');
    serverState.proc.once('close', function() {
        clearTimeout(timeout);
        console.log("Stopped nREPL server with pid %s", serverState.proc.pid);
        thenDo && thenDo(null);
    });
}

module.exports = {start: start, stop: stop};
