// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as Q from "q";
import * as path from "path";
import * as child_process from "child_process";
import {ScriptImporter}  from "./scriptImporter";

import { Log } from "../common/log/log";
import { LogLevel } from "../common/log/logHelper";
import { ErrorHelper } from "../common/error/errorHelper";
import { IDebuggeeWorker, RNAppMessage } from "./appWorker";

function printDebuggingError(message: string, reason: any) {
    Log.logWarning(ErrorHelper.getNestedWarning(reason, `${message}. Debugging won't work: Try reloading the JS from inside the app, or Reconnect the VS Code debugger`));
}

/** This class will run the RN App logic inside a forked Node process. The framework to run the logic is provided by the file
 * debuggerWorker.js (designed to run on a WebWorker). We add a couple of tweaks (mostly to polyfill WebWorker API) to that
 * file and load it inside of a process.
 * On this side we listen to IPC messages and either respond to them or redirect them to packager via MultipleLifetimeAppWorker's
 * instance. We also intercept packager's signal to load the bundle's code and mutate the message with path to file we've downloaded
 * to let importScripts function take this file.
 */
export class ForkedAppWorker implements IDebuggeeWorker {

    private scriptImporter: ScriptImporter;
    private debuggeeProcess: child_process.ChildProcess = null;
    /** A deferred that we use to make sure that worker has been loaded completely defore start sending IPC messages */
    private workerLoaded = Q.defer<void>();
    private bundleLoaded;

    constructor(
        private packagerPort: number,
        private sourcesStoragePath: string,
        private postReplyToApp: (message: any) => void
    ) {
        this.scriptImporter = new ScriptImporter(packagerPort, sourcesStoragePath);
    }

    public stop() {
        if (this.debuggeeProcess) {
            Log.logInternalMessage(LogLevel.Info, `About to kill debuggee with pid ${this.debuggeeProcess.pid}`);
            this.debuggeeProcess.kill();
            this.debuggeeProcess = null;
        }
    }

    public start(): Q.Promise<number> {
        let scriptToRunPath = path.resolve(this.sourcesStoragePath, ScriptImporter.DEBUGGER_WORKER_FILENAME);
        const port = Math.round(Math.random() * 40000 + 3000);

        // Note that we set --debug-brk flag to pause the process on the first line - this is
        // required for debug adapter to set the breakpoints BEFORE the debuggee has started.
        // The adapter will continue execution once it's done with breakpoints.
        const nodeArgs = [`--inspect=${port}`, "--debug-brk", scriptToRunPath];
        // Start child Node process in debugging mode
        this.debuggeeProcess = child_process.spawn("node", nodeArgs, {
            stdio: ["pipe", "pipe", "pipe", "ipc"],
        })
        .on("message", (message: any) => {
            // 'workerLoaded' is a special message that indicates that worker is done with loading.
            // We need to wait for it before doing any IPC because process.send doesn't seems to care
            // about whether the messahe has been received or not and the first messages are often get
            // discarded by spawned process
            if (message && message.workerLoaded) {
                this.workerLoaded.resolve(void 0);
                return;
            }

            this.postReplyToApp(message);
        })
        .on("error", (error: Error) => {
            Log.logWarning(error);
        });

        // Resolve with port debugger server is listening on
        // This will be sent to subscribers of MLAppWorker in "connected" event
        Log.logInternalMessage(LogLevel.Info,
            `Spawned debuggee process with pid ${this.debuggeeProcess.pid} listening to ${port}`);

        return Q.resolve(port);
    }

    public postMessage(rnMessage: RNAppMessage): void {
        // Before sending messages, make sure that the worker is loaded
        this.workerLoaded.promise
            .then(() => {
                if (rnMessage.method !== "executeApplicationScript") {
                    // Before sending messages, make sure that the app script executed
                    if (this.bundleLoaded) {
                        return this.bundleLoaded.promise.then(() => {
                            return rnMessage;
                        });
                    } else {
                        return rnMessage;
                    }
                } else {
                    this.bundleLoaded = Q.defer<void>();
                    // When packager asks worker to load bundle we download that bundle and
                    // then set url field to point to that downloaded bundle, so the worker
                    // will take our modified bundle
                    Log.logInternalMessage(LogLevel.Info, "Packager requested runtime to load script from " + rnMessage.url);
                    return this.scriptImporter.downloadAppScript(rnMessage.url)
                        .then(downloadedScript => {
                            this.bundleLoaded.resolve(void 0);
                            return Object.assign({}, rnMessage, { url: downloadedScript.filepath });
                        });
                }
            })
            .done((message: RNAppMessage) => this.debuggeeProcess.send({ data: message }),
            reason => printDebuggingError(`Couldn't import script at <${rnMessage.url}>`, reason));
    }
}
