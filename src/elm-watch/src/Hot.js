import * as childProcess from "child_process";
import * as chokidar from "chokidar";
import * as fs from "fs";
import * as path from "path";
import * as Decode from "tiny-decoders";
import { URLSearchParams } from "url";
import { encodeWebSocketToClientMessage, WebSocketToServerMessage, } from "../client/WebSocketMessages";
import * as Compile from "./Compile";
import { __ELM_WATCH_EXIT_ON_ERROR, __ELM_WATCH_EXIT_ON_WORKER_LIMIT, __ELM_WATCH_OPEN_EDITOR_TIMEOUT_MS, __ELM_WATCH_WORKER_LIMIT_TIMEOUT_MS, ELM_WATCH_OPEN_EDITOR, } from "./Env";
import * as Errors from "./Errors";
import { HashMap } from "./HashMap";
import { bold, capitalize, dim, formatTime, join, printDurationMs, silentlyReadIntEnvValue, toError, toJsonError, } from "./Helpers";
import { isNonEmptyArray, mapNonEmptyArray, } from "./NonEmptyArray";
import { absoluteDirname, absolutePathFromString } from "./PathHelpers";
import { ELM_WATCH_NODE } from "./PostprocessShared";
import { getFlatOutputs, } from "./Project";
import { runTeaProgram } from "./TeaProgram";
import * as Theme from "./Theme";
import { equalsInputPath, } from "./Types";
import { WebSocketServer } from "./WebSocketServer";
// This uses something inspired by The Elm Architecture, since it’s all about
// keeping state (model) and reacting to events (messages).
export async function run(env, logger, getNow, restartReasons, postprocessWorkerPool, webSocketState, project, portChoice, hotKillManager) {
    const exitOnError = __ELM_WATCH_EXIT_ON_ERROR in env;
    const result = await runTeaProgram({
        initMutable: initMutable(env, logger, getNow, postprocessWorkerPool, webSocketState, project, portChoice, hotKillManager),
        init: init(getNow(), restartReasons, project.elmJsonsErrors),
        update: (msg, model) => {
            const [newModel, cmds] = update(logger.config, project, exitOnError, msg, model);
            const allCmds = [
                ...cmds,
                newModel.latestEvents.length > model.latestEvents.length
                    ? {
                        tag: "SleepBeforeNextAction",
                        sleepMs: getNextActionSleepMs(newModel.latestEvents),
                    }
                    : { tag: "NoCmd" },
            ];
            logger.debug(msg.tag, msg, newModel, allCmds);
            return [newModel, allCmds];
        },
        runCmd: runCmd(env, logger, getNow, exitOnError),
    });
    delete hotKillManager.kill;
    return result;
}
export async function watchElmWatchJsonOnce(getNow, elmWatchJsonPath) {
    return new Promise((resolve, reject) => {
        const watcher = chokidar.watch(elmWatchJsonPath.theElmWatchJsonPath.absolutePath, {
            ignoreInitial: true,
            disableGlobbing: true,
        });
        watcherOnAll(watcher, reject, (eventName, absolutePathString) => {
            const event = {
                tag: "WatcherEvent",
                date: getNow(),
                eventName,
                file: {
                    tag: "AbsolutePath",
                    absolutePath: absolutePathString,
                },
            };
            watcher
                .close()
                .then(() => {
                resolve(event);
            })
                .catch(reject);
        });
    });
}
const initMutable = (env, logger, getNow, postprocessWorkerPool, webSocketState, project, portChoice, hotKillManager) => (dispatch, resolvePromise, rejectPromise) => {
    // The more targets that are enabled by connecting WebSockets, the more
    // workers we might have. Terminate unnecessary idle workers as WebSockets
    // close. But wait a while first: We don’t want to terminate workers just
    // because the user refreshed the page (which results in a disconnect +
    // connect).
    const workerLimitTimeoutMs = silentlyReadIntEnvValue(env[__ELM_WATCH_WORKER_LIMIT_TIMEOUT_MS], 10000);
    const watcher = chokidar.watch(project.watchRoot.absolutePath, {
        ignoreInitial: true,
        // Note: Forward slashes must be used here even on Windows. (Using
        // backslashes on Windows never matches.) The trailing slash is important:
        // It makes it possible to get notifications of a removed elm-stuff
        // folder, while ignoring everything that happens _inside_ that folder.
        ignored: /\/(elm-stuff|node_modules)\//,
        disableGlobbing: true,
    });
    watcherOnAll(watcher, (error) => {
        closeAll(logger, mutable)
            .then(() => {
            resolvePromise({
                tag: "ExitOnHandledFatalError",
                errorTemplate: Errors.watcherError(error),
            });
        })
            .catch(rejectPromise);
    }, (eventName, absolutePathString) => {
        dispatch({
            tag: "GotWatcherEvent",
            date: getNow(),
            eventName,
            absolutePathString,
        });
    });
    const { webSocketServer = new WebSocketServer(portChoice), webSocketConnections = [], } = webSocketState ?? {};
    const mutable = {
        watcher,
        postprocessWorkerPool,
        webSocketServer,
        webSocketConnections,
        lastWebSocketCloseTimestamp: undefined,
        workerLimitTimeoutMs,
        workerLimitTimeoutId: undefined,
        project,
        lastInfoMessage: undefined,
        watcherTimeoutId: undefined,
        elmWatchStuffJsonWriteError: undefined,
        killInstallDependencies: undefined,
    };
    webSocketServer.setDispatch((msg) => {
        onWebSocketServerMsg(getNow(), logger, mutable, dispatch, resolvePromise, rejectPromise, msg);
    });
    postprocessWorkerPool.setCalculateMax(() => mutable.lastWebSocketCloseTimestamp !== undefined &&
        getNow().getTime() >=
            mutable.lastWebSocketCloseTimestamp + workerLimitTimeoutMs
        ? // Save one worker, so we always have one “warmed up” worker ready to go
            // when needed.
            Math.max(1, makePrioritizedOutputs(mutable.webSocketConnections).size)
        : Infinity);
    // The port isn’t finalized until a few moments later (when the persisted
    // port is not available).
    webSocketServer.listening
        .then(() => {
        writeElmWatchStuffJson(mutable);
    })
        .catch(rejectPromise);
    const kill = async () => {
        // istanbul ignore next
        try {
            if (mutable.killInstallDependencies !== undefined) {
                mutable.killInstallDependencies({ force: true });
            }
            await Promise.all(getFlatOutputs(project).map(({ outputState }) => "kill" in outputState.status
                ? outputState.status.kill({ force: true })
                : Promise.resolve()));
            await closeAll(logger, mutable);
        }
        catch (unknownError) {
            const error = toError(unknownError);
            rejectPromise(toError(error));
        }
        delete hotKillManager.kill;
    };
    hotKillManager.kill = async () => {
        dispatch({ tag: "ExitRequested", date: getNow() });
        await kill();
        resolvePromise({ tag: "ExitOnIdle", reason: "Other" });
    };
    logger.setRawMode(() => {
        kill()
            .then(() => {
            resolvePromise({
                tag: "ExitOnIdle",
                reason: "CtrlCPressedOrStdinEnd",
            });
        })
            .catch(rejectPromise);
    });
    return mutable;
};
function writeElmWatchStuffJson(mutable) {
    const json = {
        port: mutable.webSocketServer.port.thePort,
        targets: Object.fromEntries([
            ...mutable.project.elmJsonsErrors.map((error) => [
                error.outputPath.targetName,
                {
                    compilationMode: error.compilationMode,
                    browserUiPosition: error.browserUiPosition,
                    openErrorOverlay: error.openErrorOverlay,
                },
            ]),
            ...getFlatOutputs(mutable.project).map(({ outputPath, outputState }) => [
                outputPath.targetName,
                {
                    compilationMode: outputState.compilationMode,
                    browserUiPosition: outputState.browserUiPosition,
                    openErrorOverlay: outputState.openErrorOverlay,
                },
            ]),
        ]),
    };
    try {
        fs.mkdirSync(absoluteDirname(mutable.project.elmWatchStuffJsonPath.theElmWatchStuffJsonPath).absolutePath, { recursive: true });
        fs.writeFileSync(mutable.project.elmWatchStuffJsonPath.theElmWatchStuffJsonPath
            .absolutePath, `${JSON.stringify(json, null, 4)}\n`);
        mutable.elmWatchStuffJsonWriteError = undefined;
    }
    catch (unknownError) {
        const error = toError(unknownError);
        mutable.elmWatchStuffJsonWriteError = error;
    }
}
function watcherOnAll(watcher, onError, onSuccess) {
    // We generally only care about files – not directories – but adding and
    // removing directories can cause/fix errors, if they are named
    // `elm-watch.json`, `elm.json` or `*.elm`.
    watcher.on("all", (chokidarEventName, absolutePathString) => {
        switch (chokidarEventName) {
            case "add":
            case "addDir":
                onSuccess("added", absolutePathString);
                return;
            case "unlink":
            case "unlinkDir":
                onSuccess("removed", absolutePathString);
                return;
            case "change":
                onSuccess("changed", absolutePathString);
                return;
        }
    });
    // The only way I’ve managed to make this emit an error, is when I made an
    // infinite symlink loop (ELOOP). That basically makes the watcher unusable:
    // it will always choke on that cycle and emit an error here.
    watcher.on("error", onError);
}
const init = (now, restartReasons, elmJsonsErrors) => [
    {
        nextAction: { tag: "NoAction" },
        hotState: {
            tag: "Dependencies",
            start: now,
        },
        latestEvents: restartReasons,
    },
    [
        { tag: "ClearScreen" },
        { tag: "InstallDependencies" },
        ...elmJsonsErrors.map((elmJsonError) => ({
            tag: "WebSocketSendToOutput",
            outputPath: elmJsonError.outputPath,
            message: {
                tag: "StatusChanged",
                status: {
                    tag: "ElmJsonError",
                    error: Errors.toPlainString(Compile.renderElmJsonError(elmJsonError)),
                },
            },
        })),
    ],
];
function update(loggerConfig, project, exitOnError, msg, model) {
    switch (msg.tag) {
        case "GotWatcherEvent": {
            const result = onWatcherEvent(msg.date, project, msg.eventName, msg.absolutePathString, model.nextAction);
            if (result === undefined) {
                return [model, []];
            }
            const [updatedNextAction, latestEvent, cmds] = result;
            return [
                {
                    ...model,
                    nextAction: updatedNextAction,
                    latestEvents: [...model.latestEvents, latestEvent],
                },
                cmds,
            ];
        }
        case "ExitRequested":
            // istanbul ignore if
            if (model.hotState.tag !== "Idle") {
                return [
                    model,
                    [
                        {
                            tag: "Throw",
                            error: new Error(`Got ExitRequested. Expected hotState to be Idle but it is: ${model.hotState.tag}`),
                        },
                    ],
                ];
            }
            switch (model.nextAction.tag) {
                // istanbul ignore next
                case "Restart":
                // istanbul ignore next
                case "Compile":
                    return [
                        model,
                        [
                            {
                                tag: "Throw",
                                error: new Error(`Got ExitRequested. Expected nextAction to be NoAction but it is: ${model.nextAction.tag}`),
                            },
                        ],
                    ];
                case "NoAction":
                    return runNextAction(msg.date, project, model);
            }
        case "SleepBeforeNextActionDone": {
            const [newModel, cmds] = runNextAction(msg.date, project, model);
            return [
                {
                    ...newModel,
                    nextAction: { tag: "NoAction" },
                },
                cmds,
            ];
        }
        case "CompilationPartDone": {
            const includeInterrupted = model.nextAction.tag !== "Compile";
            const outputActions = Compile.getOutputActions({
                project,
                runMode: "hot",
                includeInterrupted,
                prioritizedOutputs: msg.prioritizedOutputs,
            });
            switch (model.hotState.tag) {
                // istanbul ignore next
                case "Dependencies":
                // istanbul ignore next
                case "Idle":
                    return [
                        model,
                        [
                            {
                                tag: "Throw",
                                error: new Error(`HotState became ${model.hotState.tag} while compiling!`),
                            },
                        ],
                    ];
                case "Compiling": {
                    const duration = msg.date.getTime() - model.hotState.start.getTime();
                    const cmd = handleOutputActionResultToCmd(project.elmWatchJsonPath, msg.handleOutputActionResult);
                    if (isNonEmptyArray(outputActions.actions)) {
                        return [
                            model,
                            [
                                cmd,
                                {
                                    tag: "CompileAllOutputsAsNeeded",
                                    mode: "ContinueCompilation",
                                    includeInterrupted,
                                },
                            ],
                        ];
                    }
                    if (outputActions.numExecuting > 0 ||
                        outputActions.numInterrupted > 0) {
                        return [model, [cmd]];
                    }
                    const errors = Compile.extractErrors(project);
                    return [
                        { ...model, hotState: { tag: "Idle" }, latestEvents: [] },
                        [
                            cmd,
                            isNonEmptyArray(errors)
                                ? { tag: "PrintCompileErrors", errors }
                                : { tag: "NoCmd" },
                            { tag: "HandleElmWatchStuffJsonWriteError" },
                            {
                                tag: "LogInfoMessageWithTimeline",
                                message: compileFinishedMessage(loggerConfig, duration),
                                events: model.latestEvents,
                            },
                            isNonEmptyArray(errors) && exitOnError
                                ? { tag: "ExitOnIdle" }
                                : { tag: "NoCmd" },
                        ],
                    ];
                }
                case "Restarting":
                    return outputActions.numExecuting === 0
                        ? [model, [{ tag: "Restart", restartReasons: model.latestEvents }]]
                        : /* istanbul ignore next */ [model, []];
            }
        }
        case "InstallDependenciesDone":
            switch (model.hotState.tag) {
                case "Dependencies": {
                    switch (msg.installResult.tag) {
                        case "Error":
                            return [
                                { ...model, hotState: { tag: "Idle" } },
                                [
                                    exitOnError
                                        ? { tag: "ExitOnIdle" }
                                        : /* istanbul ignore next */ { tag: "NoCmd" },
                                ],
                            ];
                        // We only kill installing dependencies when a restart is needed.
                        // Wait for the restart to happen.
                        case "Killed":
                            return [{ ...model, hotState: { tag: "Idle" } }, []];
                        case "Success": {
                            return [
                                {
                                    ...model,
                                    hotState: {
                                        tag: "Compiling",
                                        start: model.hotState.start,
                                    },
                                },
                                [
                                    {
                                        tag: "CompileAllOutputsAsNeeded",
                                        mode: "AfterInstallDependencies",
                                        includeInterrupted: true,
                                    },
                                ],
                            ];
                        }
                    }
                }
                case "Restarting":
                    return [
                        model,
                        [{ tag: "Restart", restartReasons: model.latestEvents }],
                    ];
                // istanbul ignore next
                case "Idle":
                // istanbul ignore next
                case "Compiling":
                    return [
                        model,
                        [
                            {
                                tag: "Throw",
                                error: new Error(`HotState became ${model.hotState.tag} while installing dependencies!`),
                            },
                        ],
                    ];
            }
        case "WebSocketClosed":
            return [
                {
                    ...model,
                    latestEvents: [
                        ...model.latestEvents,
                        {
                            tag: "WebSocketClosed",
                            date: msg.date,
                            outputPath: msg.outputPath,
                        },
                    ],
                },
                [],
            ];
        case "WebSocketConnected": {
            const result = msg.parseWebSocketConnectRequestUrlResult;
            switch (result.tag) {
                case "Success": {
                    const [newModel, latestEvent, cmds] = onWebSocketConnected(msg.date, model, project.elmWatchJsonPath, result.elmJsonPath, result.outputPath, result.outputState, result.elmCompiledTimestamp);
                    return [
                        {
                            ...newModel,
                            latestEvents: [...newModel.latestEvents, latestEvent],
                        },
                        cmds,
                    ];
                }
                case "ElmJsonError": {
                    const elmJsonError = result.error;
                    const event = {
                        tag: "WebSocketConnectedNeedingNoAction",
                        date: msg.date,
                        outputPath: elmJsonError.outputPath,
                    };
                    return [
                        {
                            ...model,
                            latestEvents: [...model.latestEvents, event],
                        },
                        [
                            {
                                tag: "WebSocketSendToOutput",
                                outputPath: elmJsonError.outputPath,
                                message: {
                                    tag: "StatusChanged",
                                    status: {
                                        tag: "ElmJsonError",
                                        error: Errors.toPlainString(Compile.renderElmJsonError(elmJsonError)),
                                    },
                                },
                            },
                        ],
                    ];
                }
                default:
                    return [
                        {
                            ...model,
                            latestEvents: [
                                ...model.latestEvents,
                                {
                                    tag: "WebSocketConnectedWithErrors",
                                    date: msg.date,
                                },
                            ],
                        },
                        [
                            {
                                tag: "WebSocketSend",
                                webSocket: msg.webSocket,
                                message: {
                                    tag: "StatusChanged",
                                    status: {
                                        tag: "ClientError",
                                        message: webSocketConnectRequestUrlErrorToString(result),
                                    },
                                },
                            },
                        ],
                    ];
            }
        }
        case "WebSocketMessageReceived": {
            const result = parseWebSocketToServerMessage(msg.data);
            switch (result.tag) {
                case "Success":
                    return onWebSocketToServerMessage(project.elmWatchJsonPath, model, msg.date, msg.output, msg.webSocket, result.message);
                case "DecodeError":
                    return [
                        model,
                        [
                            {
                                tag: "WebSocketSend",
                                webSocket: msg.webSocket,
                                message: {
                                    tag: "StatusChanged",
                                    status: {
                                        tag: "ClientError",
                                        message: Errors.webSocketDecodeError(result.error),
                                    },
                                },
                            },
                        ],
                    ];
            }
        }
        case "WorkerLimitTimeoutPassed":
            return [model, [{ tag: "LimitWorkers" }]];
        case "WorkersLimited":
            return [
                {
                    ...model,
                    latestEvents: [
                        ...model.latestEvents,
                        {
                            tag: "WorkersLimitedAfterWebSocketClosed",
                            date: msg.date,
                            numTerminatedWorkers: msg.numTerminatedWorkers,
                        },
                    ],
                },
                [],
            ];
    }
}
function onWatcherEvent(now, project, eventName, absolutePathString, nextAction) {
    if (absolutePathString.endsWith(".elm")) {
        return onElmFileWatcherEvent(project, makeWatcherEvent(eventName, absolutePathString, now), nextAction);
    }
    const basename = path.basename(absolutePathString);
    switch (basename) {
        case "elm-watch.json":
            switch (eventName) {
                case "added":
                    return makeRestartNextAction(makeWatcherEvent(eventName, absolutePathString, now), project);
                case "changed":
                case "removed":
                    if (absolutePathString ===
                        project.elmWatchJsonPath.theElmWatchJsonPath.absolutePath) {
                        return makeRestartNextAction(makeWatcherEvent(eventName, absolutePathString, now), project);
                    }
                    return undefined;
            }
        case "elm.json":
            switch (eventName) {
                case "added":
                    return makeRestartNextAction(makeWatcherEvent(eventName, absolutePathString, now), project);
                case "changed":
                case "removed":
                    if (Array.from(project.elmJsons).some(([elmJsonPath]) => absolutePathString === elmJsonPath.theElmJsonPath.absolutePath) ||
                        isElmJsonFileRelatedToElmJsonsErrors(absolutePathString, project.elmJsonsErrors)) {
                        return makeRestartNextAction(makeWatcherEvent(eventName, absolutePathString, now), project);
                    }
                    return undefined;
            }
        // Some compiler error messages suggest removing elm-stuff to fix the error.
        // Restart when that happens. Note: This could be a totally unrelated
        // elm-stuff directory, but I don’t think it’s worth the trouble trying to
        // check if it affects the project, and possibly logging if it isn’t.
        case "elm-stuff":
            switch (eventName) {
                case "removed":
                    return makeRestartNextAction(makeWatcherEvent(eventName, absolutePathString, now), project);
                default:
                    return undefined;
            }
        default:
            switch (project.postprocess.tag) {
                case "Postprocess": {
                    const [commandName, scriptPathString] = project.postprocess.postprocessArray;
                    if (commandName === ELM_WATCH_NODE &&
                        scriptPathString !== undefined) {
                        const scriptPath = absolutePathFromString(absoluteDirname(project.elmWatchJsonPath.theElmWatchJsonPath), scriptPathString);
                        if (absolutePathString === scriptPath.absolutePath) {
                            return [
                                compileNextAction(nextAction),
                                {
                                    ...makeWatcherEvent(eventName, absolutePathString, now),
                                    affectsAnyTarget: true,
                                },
                                [
                                    {
                                        tag: "MarkAsDirty",
                                        outputs: getFlatOutputs(project),
                                        killInstallDependencies: false,
                                    },
                                    { tag: "RestartWorkers" },
                                ],
                            ];
                        }
                    }
                    return undefined;
                }
                case "NoPostprocess":
                    // Ignore other types of files.
                    return undefined;
            }
    }
}
function onElmFileWatcherEvent(project, event, nextAction) {
    const elmFile = event.file;
    if (isElmFileRelatedToElmJsonsErrors(elmFile, project.elmJsonsErrors)) {
        return makeRestartNextAction(event, project);
    }
    const dirtyOutputs = [];
    for (const [elmJsonPath, outputs] of project.elmJsons) {
        for (const [outputPath, outputState] of outputs) {
            if (event.eventName === "removed") {
                for (const inputPath of outputState.inputs) {
                    if (equalsInputPath(elmFile, inputPath)) {
                        return makeRestartNextAction(event, project);
                    }
                }
            }
            Compile.ensureAllRelatedElmFilePaths(elmJsonPath, outputState);
            if (outputState.allRelatedElmFilePaths.has(elmFile.absolutePath)) {
                dirtyOutputs.push({ outputPath, outputState });
            }
        }
    }
    return isNonEmptyArray(dirtyOutputs)
        ? [
            compileNextAction(nextAction),
            { ...event, affectsAnyTarget: true },
            [
                {
                    tag: "MarkAsDirty",
                    outputs: dirtyOutputs,
                    killInstallDependencies: false,
                },
            ],
        ]
        : [nextAction, { ...event, affectsAnyTarget: false }, []];
}
function runNextAction(start, project, model) {
    switch (model.nextAction.tag) {
        case "Restart":
            switch (model.hotState.tag) {
                case "Idle":
                    return [
                        { ...model, hotState: { tag: "Restarting" } },
                        [
                            { tag: "ClearScreen" },
                            { tag: "Restart", restartReasons: model.latestEvents },
                        ],
                    ];
                case "Dependencies":
                case "Compiling": {
                    // The actual restart is triggered once the current compilation is over.
                    return [{ ...model, hotState: { tag: "Restarting" } }, []];
                }
                // istanbul ignore next
                case "Restarting":
                    return [model, []];
            }
        case "Compile":
            switch (model.hotState.tag) {
                case "Idle": {
                    return [
                        {
                            ...model,
                            hotState: { tag: "Compiling", start },
                        },
                        [
                            {
                                tag: "CompileAllOutputsAsNeeded",
                                mode: "AfterIdle",
                                includeInterrupted: true,
                            },
                        ],
                    ];
                }
                case "Compiling":
                    return [
                        model,
                        [
                            {
                                tag: "CompileAllOutputsAsNeeded",
                                mode: "ContinueCompilation",
                                includeInterrupted: true,
                            },
                        ],
                    ];
                // istanbul ignore next
                case "Dependencies":
                // istanbul ignore next
                case "Restarting":
                    return [model, []];
            }
        case "NoAction":
            switch (model.hotState.tag) {
                case "Idle":
                    return isNonEmptyArray(model.latestEvents)
                        ? [
                            { ...model, latestEvents: [] },
                            [
                                {
                                    tag: "LogInfoMessageWithTimeline",
                                    message: printEventsMessage(model.latestEvents, project.disabledOutputs),
                                    events: model.latestEvents,
                                },
                            ],
                        ]
                        : [model, []];
                case "Compiling":
                case "Dependencies":
                case "Restarting":
                    return [model, []];
            }
    }
}
const runCmd = (env, logger, getNow, exitOnError) => (cmd, mutable, dispatch, resolvePromise, rejectPromise) => {
    switch (cmd.tag) {
        case "ChangeBrowserUiPosition":
            cmd.outputState.browserUiPosition = cmd.browserUiPosition;
            writeElmWatchStuffJson(mutable);
            return;
        case "ChangeCompilationMode":
            cmd.outputState.compilationMode = cmd.compilationMode;
            writeElmWatchStuffJson(mutable);
            return;
        case "ChangeOpenErrorOverlay":
            cmd.outputState.openErrorOverlay = cmd.openErrorOverlay;
            writeElmWatchStuffJson(mutable);
            return;
        case "ClearScreen":
            logger.clearScreen();
            mutable.lastInfoMessage = undefined;
            return;
        case "CompileAllOutputsAsNeeded": {
            const outputActions = Compile.getOutputActions({
                project: mutable.project,
                runMode: "hot",
                includeInterrupted: cmd.includeInterrupted,
                prioritizedOutputs: makePrioritizedOutputs(mutable.webSocketConnections),
            });
            switch (cmd.mode) {
                case "AfterInstallDependencies":
                    Compile.printStatusLinesForElmJsonsErrors(logger, mutable.project);
                    Compile.printSpaceForOutputs(logger, "hot", outputActions);
                    break;
                case "AfterIdle":
                    logger.clearScreen();
                    mutable.lastInfoMessage = undefined;
                    Compile.printStatusLinesForElmJsonsErrors(logger, mutable.project);
                    Compile.printSpaceForOutputs(logger, "hot", outputActions);
                    break;
                case "ContinueCompilation":
                    break;
            }
            if (isNonEmptyArray(outputActions.actions)) {
                for (const action of outputActions.actions) {
                    Compile.handleOutputAction({
                        env,
                        logger,
                        getNow,
                        runMode: {
                            tag: "hot",
                            webSocketPort: mutable.webSocketServer.port,
                        },
                        elmWatchJsonPath: mutable.project.elmWatchJsonPath,
                        total: outputActions.total,
                        action,
                        postprocess: mutable.project.postprocess,
                        postprocessWorkerPool: mutable.postprocessWorkerPool,
                    })
                        .then((handleOutputActionResult) => {
                        dispatch({
                            tag: "CompilationPartDone",
                            date: getNow(),
                            prioritizedOutputs: makePrioritizedOutputs(mutable.webSocketConnections),
                            handleOutputActionResult,
                        });
                    })
                        .catch(rejectPromise);
                }
            }
            else if (outputActions.numExecuting === 0) {
                dispatch({
                    tag: "CompilationPartDone",
                    date: getNow(),
                    prioritizedOutputs: makePrioritizedOutputs(mutable.webSocketConnections),
                    handleOutputActionResult: { tag: "Nothing" },
                });
            }
            return;
        }
        case "HandleElmWatchStuffJsonWriteError":
            if (mutable.elmWatchStuffJsonWriteError !== undefined) {
                // Retry writing it.
                writeElmWatchStuffJson(mutable);
                // If still an error, print it.
                // istanbul ignore else
                if (mutable.elmWatchStuffJsonWriteError !== undefined) {
                    logger.write("");
                    logger.errorTemplate(Errors.elmWatchStuffJsonWriteError(mutable.project.elmWatchStuffJsonPath, mutable.elmWatchStuffJsonWriteError));
                    // istanbul ignore else
                    if (exitOnError) {
                        closeAll(logger, mutable)
                            .then(() => {
                            resolvePromise({ tag: "ExitOnIdle", reason: "Other" });
                        })
                            .catch(rejectPromise);
                    }
                }
            }
            return;
        case "InstallDependencies": {
            // If the web socket server fails to boot, don’t even bother with anything else.
            mutable.webSocketServer.listening
                .then(() => {
                const { promise, kill } = Compile.installDependencies(env, logger, getNow, mutable.project);
                mutable.killInstallDependencies = ({ force }) => {
                    kill({ force });
                    mutable.killInstallDependencies = undefined;
                };
                return promise;
            })
                .finally(() => {
                mutable.killInstallDependencies = undefined;
            })
                .then((installResult) => {
                dispatch({
                    tag: "InstallDependenciesDone",
                    date: getNow(),
                    installResult,
                });
            })
                .catch(rejectPromise);
            return;
        }
        case "LimitWorkers":
            mutable.postprocessWorkerPool
                .limit()
                .then((numTerminatedWorkers) => {
                if (numTerminatedWorkers > 0) {
                    dispatch({
                        tag: "WorkersLimited",
                        date: getNow(),
                        numTerminatedWorkers,
                    });
                }
            })
                .catch(rejectPromise);
            return;
        case "LogInfoMessageWithTimeline": {
            if (mutable.lastInfoMessage !== undefined) {
                logger.moveCursor(0, -mutable.lastInfoMessage.split("\n").length);
                logger.clearScreenDown();
            }
            const fullMessage = infoMessageWithTimeline({
                loggerConfig: logger.config,
                date: getNow(),
                mutable,
                message: cmd.message,
                events: filterLatestEvents(cmd.events),
                hasErrors: isNonEmptyArray(Compile.extractErrors(mutable.project)),
            });
            logger.write(fullMessage);
            // For the `run-pty` tool: Let it know that it’s safe to render the
            // keyboard shortcuts below the cursor text again.
            logger.clearScreenDown();
            mutable.lastInfoMessage = fullMessage;
            if (__ELM_WATCH_EXIT_ON_WORKER_LIMIT in env &&
                cmd.events.some((event) => event.tag === "WorkersLimitedAfterWebSocketClosed")) {
                closeAll(logger, mutable)
                    .then(() => {
                    resolvePromise({ tag: "ExitOnIdle", reason: "Other" });
                })
                    .catch(rejectPromise);
            }
            return;
        }
        case "MarkAsDirty":
            if (cmd.killInstallDependencies &&
                mutable.killInstallDependencies !== undefined) {
                mutable.killInstallDependencies({ force: false });
            }
            for (const { outputPath, outputState } of cmd.outputs) {
                outputState.dirty = true;
                if ("kill" in outputState.status) {
                    Promise.resolve(outputState.status.kill({ force: false })).catch(rejectPromise);
                }
                webSocketSendToOutput(outputPath, {
                    tag: "StatusChanged",
                    status: {
                        tag: "Busy",
                        compilationMode: outputState.compilationMode,
                        browserUiPosition: outputState.browserUiPosition,
                    },
                }, mutable.webSocketConnections);
            }
            return;
        case "NoCmd":
            return;
        case "OpenEditor": {
            const command = env[ELM_WATCH_OPEN_EDITOR];
            const cwd = absoluteDirname(mutable.project.elmWatchJsonPath.theElmWatchJsonPath);
            const timeout = silentlyReadIntEnvValue(env[__ELM_WATCH_OPEN_EDITOR_TIMEOUT_MS], 5000);
            const extraEnv = {
                file: cmd.file.absolutePath,
                line: cmd.line.toString(),
                column: cmd.column.toString(),
            };
            if (command === undefined) {
                webSocketSend(cmd.webSocket, {
                    tag: "OpenEditorFailed",
                    error: { tag: "EnvNotSet" },
                });
            }
            else {
                childProcess.exec(command, {
                    cwd: cwd.absolutePath,
                    env: { ...env, ...extraEnv },
                    encoding: "utf8",
                    timeout,
                }, (error, stdout, stderr) => {
                    if (error !== null) {
                        webSocketSend(cmd.webSocket, {
                            tag: "OpenEditorFailed",
                            error: {
                                tag: "CommandFailed",
                                message: Errors.openEditorCommandFailed({
                                    error,
                                    command,
                                    cwd,
                                    timeout,
                                    env: extraEnv,
                                    stdout,
                                    stderr,
                                }),
                            },
                        });
                    }
                });
            }
            return;
        }
        case "PrintCompileErrors":
            Compile.printErrors(logger, cmd.errors);
            return;
        case "Restart": {
            // Outputs and port may have changed if elm-watch.json changes.
            const elmWatchJsonChanged = cmd.restartReasons.some((event) => {
                switch (event.tag) {
                    case "WatcherEvent":
                        return (path.basename(event.file.absolutePath) === "elm-watch.json");
                    // istanbul ignore next
                    default:
                        return false;
                }
            });
            closeAll(logger, mutable, {
                killWebSocketServer: elmWatchJsonChanged,
                killPostprocessWorkerPool: elmWatchJsonChanged,
            })
                .then(() => {
                resolvePromise({
                    tag: "Restart",
                    restartReasons: cmd.restartReasons,
                    postprocessWorkerPool: mutable.postprocessWorkerPool,
                    webSocketState: elmWatchJsonChanged
                        ? undefined
                        : {
                            webSocketServer: mutable.webSocketServer,
                            webSocketConnections: mutable.webSocketConnections,
                        },
                });
            })
                .catch(rejectPromise);
            return;
        }
        case "RestartWorkers":
            mutable.postprocessWorkerPool
                .terminate()
                .then(() => {
                mutable.postprocessWorkerPool.getOrCreateAvailableWorker();
            })
                .catch(rejectPromise);
            return;
        case "ExitOnIdle":
            closeAll(logger, mutable)
                .then(() => {
                resolvePromise({ tag: "ExitOnIdle", reason: "Other" });
            })
                .catch(rejectPromise);
            return;
        case "SleepBeforeNextAction":
            if (mutable.watcherTimeoutId !== undefined) {
                clearTimeout(mutable.watcherTimeoutId);
            }
            mutable.watcherTimeoutId = setTimeout(() => {
                mutable.watcherTimeoutId = undefined;
                dispatch({ tag: "SleepBeforeNextActionDone", date: getNow() });
            }, cmd.sleepMs);
            return;
        // istanbul ignore next
        case "Throw":
            rejectPromise(cmd.error);
            return;
        case "WebSocketSend":
            webSocketSend(cmd.webSocket, cmd.message);
            return;
        case "WebSocketSendCompileErrorToOutput":
            Theme.getThemeFromTerminal(logger)
                .then((theme) => {
                const message = {
                    tag: "StatusChanged",
                    status: {
                        tag: "CompileError",
                        compilationMode: cmd.compilationMode,
                        browserUiPosition: cmd.browserUiPosition,
                        openErrorOverlay: cmd.openErrorOverlay,
                        errors: cmd.errors.map((errorTemplate) => Errors.toHtml(errorTemplate, theme, logger.config.noColor)),
                        foregroundColor: theme.foreground,
                        backgroundColor: theme.background,
                    },
                };
                webSocketSendToOutput(cmd.outputPath, message, mutable.webSocketConnections);
            })
                .catch(rejectPromise);
            return;
        case "WebSocketSendToOutput":
            webSocketSendToOutput(cmd.outputPath, cmd.message, mutable.webSocketConnections);
            return;
        case "WebSocketUpdatePriority":
            for (const webSocketConnection of mutable.webSocketConnections) {
                if (webSocketConnection.webSocket === cmd.webSocket) {
                    webSocketConnection.priority = getNow().getTime();
                }
            }
            return;
    }
};
function onWebSocketServerMsg(now, logger, mutable, dispatch, resolvePromise, rejectPromise, msg) {
    switch (msg.tag) {
        case "WebSocketConnected": {
            const result = parseWebSocketConnectRequestUrl(mutable.project, msg.urlString);
            const webSocketConnection = {
                webSocket: msg.webSocket,
                outputPath: webSocketConnectRequestUrlResultToOutputPath(result),
                priority: now.getTime(),
            };
            mutable.webSocketConnections.push(webSocketConnection);
            dispatch({
                tag: "WebSocketConnected",
                date: now,
                parseWebSocketConnectRequestUrlResult: result,
                webSocket: msg.webSocket,
            });
            return;
        }
        case "WebSocketClosed": {
            const removedConnection = mutable.webSocketConnections.find((connection) => connection.webSocket === msg.webSocket);
            mutable.webSocketConnections = mutable.webSocketConnections.filter((connection) => connection.webSocket !== msg.webSocket);
            mutable.lastWebSocketCloseTimestamp = now.getTime();
            if (mutable.workerLimitTimeoutId !== undefined) {
                clearTimeout(mutable.workerLimitTimeoutId);
            }
            mutable.workerLimitTimeoutId = setTimeout(() => {
                mutable.workerLimitTimeoutId = undefined;
                dispatch({ tag: "WorkerLimitTimeoutPassed" });
            }, mutable.workerLimitTimeoutMs);
            dispatch({
                tag: "WebSocketClosed",
                date: now,
                outputPath: removedConnection === undefined
                    ? /* istanbul ignore next */ { tag: "OutputPathError" }
                    : removedConnection.outputPath,
            });
            return;
        }
        case "WebSocketMessageReceived": {
            const webSocketConnection = mutable.webSocketConnections.find(({ webSocket }) => webSocket === msg.webSocket);
            // istanbul ignore if
            if (webSocketConnection === undefined) {
                rejectPromise(new Error(`No web socket connection found for web socket message ${JSON.stringify(msg.tag)}`));
                return;
            }
            const flatOutputs = getFlatOutputs(mutable.project);
            const output = flatOutputs.find(({ outputPath }) => webSocketConnectionIsForOutputPath(webSocketConnection, outputPath));
            dispatch({
                tag: "WebSocketMessageReceived",
                date: now,
                output: output === undefined
                    ? { tag: "OutputPathError" }
                    : { tag: "Output", ...output },
                webSocket: msg.webSocket,
                data: msg.data,
            });
            return;
        }
        case "WebSocketServerError":
            switch (msg.error.tag) {
                case "PortConflict": {
                    const { portChoice } = msg.error;
                    closeAll(logger, mutable)
                        .then(() => {
                        resolvePromise({
                            tag: "ExitOnHandledFatalError",
                            errorTemplate: portChoiceError(mutable.project, portChoice, msg.error.error),
                        });
                    })
                        .catch(rejectPromise);
                    return;
                }
                // istanbul ignore next
                case "OtherError":
                    rejectPromise(msg.error.error);
                    return;
            }
    }
}
function portChoiceError(project, portChoice, error) {
    switch (portChoice.tag) {
        // istanbul ignore next
        case "NoPort":
            return Errors.portConflictForNoPort(error);
        case "PersistedPort":
            return Errors.portConflictForPersistedPort(project.elmWatchStuffJsonPath, portChoice.port);
        case "PortFromConfig":
            return Errors.portConflictForPortFromConfig(project.elmWatchJsonPath, portChoice.port);
    }
}
function handleOutputActionResultToCmd(elmWatchJsonPath, handleOutputActionResult) {
    switch (handleOutputActionResult.tag) {
        case "CompileError":
            return {
                tag: "WebSocketSendCompileErrorToOutput",
                outputPath: handleOutputActionResult.outputPath,
                compilationMode: handleOutputActionResult.outputState.compilationMode,
                browserUiPosition: handleOutputActionResult.outputState.browserUiPosition,
                openErrorOverlay: handleOutputActionResult.outputState.openErrorOverlay,
                errors: Compile.renderOutputErrors(elmWatchJsonPath, handleOutputActionResult.elmJsonPath, handleOutputActionResult.outputPath, handleOutputActionResult.outputState.status),
            };
        case "FullyCompiledJS":
            return {
                tag: "WebSocketSendToOutput",
                outputPath: handleOutputActionResult.outputPath,
                message: {
                    tag: "SuccessfullyCompiled",
                    code: handleOutputActionResult.code.toString("utf8"),
                    elmCompiledTimestamp: handleOutputActionResult.elmCompiledTimestamp,
                    compilationMode: handleOutputActionResult.outputState.compilationMode,
                    browserUiPosition: handleOutputActionResult.outputState.browserUiPosition,
                },
            };
        case "FullyCompiledJSButRecordFieldsChanged":
            return {
                tag: "WebSocketSendToOutput",
                outputPath: handleOutputActionResult.outputPath,
                message: { tag: "SuccessfullyCompiledButRecordFieldsChanged" },
            };
        case "Nothing":
            return { tag: "NoCmd" };
    }
}
async function closeAll(logger, mutable, { killWebSocketServer = true, killPostprocessWorkerPool = true } = {}) {
    logger.reset();
    // istanbul ignore if
    if (mutable.workerLimitTimeoutId !== undefined) {
        clearTimeout(mutable.workerLimitTimeoutId);
    }
    // istanbul ignore if
    if (mutable.watcherTimeoutId !== undefined) {
        clearTimeout(mutable.watcherTimeoutId);
    }
    mutable.webSocketServer.unsetDispatch();
    await Promise.all([
        mutable.watcher.close(),
        killWebSocketServer ? mutable.webSocketServer.close() : undefined,
        killPostprocessWorkerPool
            ? mutable.postprocessWorkerPool.terminate()
            : undefined,
    ]);
}
function makePrioritizedOutputs(webSocketConnections) {
    const map = new HashMap();
    for (const { outputPath, priority } of webSocketConnections) {
        if (outputPath.tag !== "OutputPathError") {
            // istanbul ignore next
            const previous = map.get(outputPath) ?? 0;
            map.set(outputPath, Math.max(priority, previous));
        }
    }
    return map;
}
function makeWatcherEvent(eventName, absolutePathString, date) {
    return {
        tag: "WatcherEvent",
        date,
        eventName,
        file: {
            tag: "AbsolutePath",
            absolutePath: absolutePathString,
        },
    };
}
function makeRestartNextAction(event, project) {
    return [
        { tag: "Restart" },
        { ...event, affectsAnyTarget: true },
        [
            {
                // Interrupt all compilation.
                tag: "MarkAsDirty",
                outputs: getFlatOutputs(project),
                killInstallDependencies: true,
            },
        ],
    ];
}
function isElmFileRelatedToElmJsonsErrors(elmFile, elmJsonsErrors) {
    return elmJsonsErrors.some(({ error }) => {
        switch (error.tag) {
            case "DuplicateInputs":
                return error.duplicates.some(({ inputs, resolved }) => resolved.absolutePath === elmFile.absolutePath ||
                    inputs.some((inputPath) => equalsInputPath(elmFile, inputPath)));
            // Note: Restarting because an .elm file changed here won’t change the
            // fact that elm.json is missing. But it might feel clearer if the watcher
            // still reacts to the inputs rather than saying that they don’t affect
            // anything.
            case "ElmJsonNotFound":
                return (error.elmJsonNotFound.some((inputPath) => equalsInputPath(elmFile, inputPath)) ||
                    error.foundElmJsonPaths.some(({ inputPath }) => equalsInputPath(elmFile, inputPath)));
            // The only way I’ve found to trigger this is by a symlink loop.
            // However, that causes the watcher to error out and we have to exit so
            // this is never hit.
            // istanbul ignore next
            case "InputsFailedToResolve":
                return error.inputsFailedToResolve.some(({ inputPath }) => inputPath.theUncheckedInputPath.absolutePath ===
                    elmFile.absolutePath);
            case "InputsNotFound":
                return error.inputsNotFound.some((inputPath) => inputPath.theUncheckedInputPath.absolutePath ===
                    elmFile.absolutePath);
            // Changes to the .elm files don’t make the elm.json:s more unique, but
            // see  "ElmJsonNotFound" above for why we restart anyway.
            case "NonUniqueElmJsonPaths":
                return error.nonUniqueElmJsonPaths.some(({ inputPath }) => equalsInputPath(elmFile, inputPath));
        }
    });
}
function isElmJsonFileRelatedToElmJsonsErrors(absoluteElmJsonFilePath, elmJsonsErrors) {
    return elmJsonsErrors.some(({ error }) => {
        switch (error.tag) {
            case "DuplicateInputs":
            case "InputsFailedToResolve":
            case "InputsNotFound":
                return false;
            case "ElmJsonNotFound":
                return error.foundElmJsonPaths.some(({ elmJsonPath }) => elmJsonPath.theElmJsonPath.absolutePath === absoluteElmJsonFilePath);
            case "NonUniqueElmJsonPaths":
                return error.nonUniqueElmJsonPaths.some(({ elmJsonPath }) => elmJsonPath.theElmJsonPath.absolutePath === absoluteElmJsonFilePath);
        }
    });
}
function webSocketConnectionIsForOutputPath(webSocketConnection, outputPath) {
    switch (webSocketConnection.outputPath.tag) {
        case "OutputPathError":
            return false;
        case "OutputPath":
            return (webSocketConnection.outputPath.theOutputPath.absolutePath ===
                outputPath.theOutputPath.absolutePath);
    }
}
const WebSocketConnectedParams = Decode.fieldsAuto({
    elmWatchVersion: Decode.string,
    targetName: Decode.string,
    elmCompiledTimestamp: Decode.chain(Decode.string, (string) => {
        const number = Number(string);
        if (Number.isFinite(number)) {
            return number;
        }
        throw new Decode.DecoderError({
            message: "Expected a number",
            value: string,
        });
    }),
}, { exact: "throw" });
// We used to require `/?`. Putting “elm-watch” in the path is useful for people
// running elm-watch behind a proxy: They can use the same port for both the web
// site and elm-watch, and direct traffic by path matching.
const WEBSOCKET_URL_EXPECTED_START = "/elm-watch?";
function parseWebSocketConnectRequestUrl(project, urlString) {
    if (!urlString.startsWith(WEBSOCKET_URL_EXPECTED_START)) {
        return {
            tag: "BadUrl",
            expectedStart: WEBSOCKET_URL_EXPECTED_START,
            actualUrlString: urlString,
        };
    }
    // This never throws as far as I can tell.
    const params = new URLSearchParams(urlString.slice(WEBSOCKET_URL_EXPECTED_START.length));
    let webSocketConnectedParams;
    try {
        webSocketConnectedParams = WebSocketConnectedParams(Object.fromEntries(params));
    }
    catch (unknownError) {
        const error = toJsonError(unknownError);
        return {
            tag: "ParamsDecodeError",
            error,
            actualUrlString: urlString,
        };
    }
    if (webSocketConnectedParams.elmWatchVersion !== "%VERSION%") {
        return {
            tag: "WrongVersion",
            expectedVersion: "%VERSION%",
            actualVersion: webSocketConnectedParams.elmWatchVersion,
        };
    }
    const flatOutputs = getFlatOutputs(project);
    const { targetName } = webSocketConnectedParams;
    const matchElmJsonError = project.elmJsonsErrors.find(({ outputPath }) => outputPath.targetName === targetName);
    const matchOutput = flatOutputs.find(({ outputPath }) => outputPath.targetName === targetName);
    if (matchElmJsonError !== undefined) {
        return {
            tag: "ElmJsonError",
            error: matchElmJsonError,
        };
    }
    else if (matchOutput !== undefined) {
        return {
            tag: "Success",
            elmJsonPath: matchOutput.elmJsonPath,
            outputPath: matchOutput.outputPath,
            outputState: matchOutput.outputState,
            elmCompiledTimestamp: webSocketConnectedParams.elmCompiledTimestamp,
        };
    }
    else {
        const enabledOutputs = [
            ...project.elmJsonsErrors.map(({ outputPath }) => outputPath),
            ...flatOutputs.map(({ outputPath }) => outputPath),
        ];
        const disabledOutputs = Array.from(project.disabledOutputs);
        const disabledMatch = disabledOutputs.find((outputPath) => outputPath.targetName === targetName);
        return disabledMatch === undefined
            ? {
                tag: "TargetNotFound",
                targetName,
                enabledOutputs,
                disabledOutputs,
            }
            : {
                tag: "TargetDisabled",
                targetName,
                enabledOutputs,
                disabledOutputs,
            };
    }
}
function webSocketConnectRequestUrlResultToOutputPath(result) {
    switch (result.tag) {
        case "Success":
            return result.outputPath;
        case "ElmJsonError":
            return result.error.outputPath;
        default: {
            // Make sure only error results are left.
            const _ = result;
            void _;
            return { tag: "OutputPathError" };
        }
    }
}
function webSocketConnectRequestUrlErrorToString(error) {
    switch (error.tag) {
        case "BadUrl":
            return Errors.webSocketBadUrl(error.expectedStart, error.actualUrlString);
        case "ParamsDecodeError":
            return Errors.webSocketParamsDecodeError(error.error, error.actualUrlString);
        case "WrongVersion":
            return Errors.webSocketWrongVersion(error.expectedVersion, error.actualVersion);
        case "TargetNotFound":
            return Errors.webSocketTargetNotFound(error.targetName, error.enabledOutputs, error.disabledOutputs);
        case "TargetDisabled":
            return Errors.webSocketTargetDisabled(error.targetName, error.enabledOutputs, error.disabledOutputs);
    }
}
function parseWebSocketToServerMessage(data) {
    // istanbul ignore next
    const stringData = typeof data === "string"
        ? data
        : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : data instanceof ArrayBuffer
                ? new TextDecoder("utf8").decode(data)
                : data.toString("utf8");
    try {
        return {
            tag: "Success",
            message: WebSocketToServerMessage(JSON.parse(stringData)),
        };
    }
    catch (unknownError) {
        const error = toJsonError(unknownError);
        return { tag: "DecodeError", error };
    }
}
function onWebSocketConnected(date, model, elmWatchJsonPath, elmJsonPath, outputPath, outputState, elmCompiledTimestamp) {
    const event = {
        tag: "WebSocketConnectedNeedingCompilation",
        date,
        outputPath,
    };
    const recompileNeeded = () => {
        const [newModel, cmds] = onWebSocketRecompileNeeded(model, outputPath, outputState);
        return [newModel, event, cmds];
    };
    switch (model.hotState.tag) {
        // istanbul ignore next
        case "Restarting":
        // istanbul ignore next
        case "Dependencies":
            return [model, event, []];
        case "Idle":
        case "Compiling":
            switch (outputState.status.tag) {
                case "Success":
                    return outputState.status.elmCompiledTimestamp ===
                        elmCompiledTimestamp
                        ? [
                            model,
                            {
                                tag: "WebSocketConnectedNeedingNoAction",
                                date,
                                outputPath,
                            },
                            [
                                {
                                    tag: "WebSocketSendToOutput",
                                    outputPath,
                                    message: {
                                        tag: "StatusChanged",
                                        status: {
                                            tag: "AlreadyUpToDate",
                                            compilationMode: outputState.compilationMode,
                                            browserUiPosition: outputState.browserUiPosition,
                                        },
                                    },
                                },
                            ],
                        ]
                        : recompileNeeded();
                case "NotWrittenToDisk":
                case "ElmMakeTypecheckOnly":
                    return recompileNeeded();
                // istanbul ignore next
                case "ElmMake":
                case "Postprocess":
                case "Interrupted":
                case "QueuedForElmMake":
                case "QueuedForPostprocess":
                    switch (model.hotState.tag) {
                        // istanbul ignore next
                        case "Idle":
                            return recompileNeeded();
                        case "Compiling":
                            return [model, event, []];
                    }
                default: {
                    // Make sure only error statuses are left.
                    const _ = outputState.status;
                    void _;
                    return [
                        model,
                        event,
                        [
                            {
                                tag: "WebSocketSendCompileErrorToOutput",
                                outputPath,
                                compilationMode: outputState.compilationMode,
                                browserUiPosition: outputState.browserUiPosition,
                                openErrorOverlay: outputState.openErrorOverlay,
                                errors: Compile.renderOutputErrors(elmWatchJsonPath, elmJsonPath, outputPath, outputState.status),
                            },
                        ],
                    ];
                }
            }
    }
}
function onChangedCompilationModeOrBrowserUiPosition(model, outputPath, outputState) {
    switch (model.hotState.tag) {
        // istanbul ignore next
        case "Restarting":
        // istanbul ignore next
        case "Dependencies":
            return [model, []];
        case "Idle":
        case "Compiling":
            return onWebSocketRecompileNeeded(model, outputPath, outputState);
    }
}
function onWebSocketRecompileNeeded(model, outputPath, outputState) {
    switch (model.nextAction.tag) {
        // istanbul ignore next
        case "Restart":
            return [model, []];
        case "Compile":
        case "NoAction":
            return [
                {
                    ...model,
                    nextAction: { tag: "Compile" },
                },
                [
                    {
                        tag: "MarkAsDirty",
                        outputs: [{ outputPath, outputState }],
                        killInstallDependencies: false,
                    },
                ],
            ];
    }
}
function compileNextAction(nextAction) {
    switch (nextAction.tag) {
        // istanbul ignore next
        case "Restart":
        case "Compile":
            return nextAction;
        case "NoAction":
            return { tag: "Compile" };
    }
}
function onWebSocketToServerMessage(elmWatchJsonPath, model, date, output, webSocket, message) {
    switch (message.tag) {
        case "ChangedCompilationMode":
            switch (output.tag) {
                case "OutputPathError":
                    return [model, []];
                case "Output": {
                    const [newModel, cmds] = onChangedCompilationModeOrBrowserUiPosition(model, output.outputPath, output.outputState);
                    return [
                        {
                            ...newModel,
                            latestEvents: [
                                ...newModel.latestEvents,
                                {
                                    tag: "WebSocketChangedCompilationMode",
                                    date,
                                    outputPath: output.outputPath,
                                    compilationMode: message.compilationMode,
                                },
                            ],
                        },
                        [
                            {
                                tag: "ChangeCompilationMode",
                                outputState: output.outputState,
                                compilationMode: message.compilationMode,
                            },
                            ...cmds,
                        ],
                    ];
                }
            }
        case "ChangedBrowserUiPosition":
            switch (output.tag) {
                case "OutputPathError":
                    return [model, []];
                case "Output": {
                    const [newModel, cmds] = onChangedCompilationModeOrBrowserUiPosition(model, output.outputPath, output.outputState);
                    return [
                        {
                            ...newModel,
                            latestEvents: [
                                ...newModel.latestEvents,
                                {
                                    tag: "WebSocketChangedBrowserUiPosition",
                                    date,
                                    outputPath: output.outputPath,
                                    browserUiPosition: message.browserUiPosition,
                                },
                            ],
                        },
                        [
                            {
                                tag: "ChangeBrowserUiPosition",
                                outputState: output.outputState,
                                browserUiPosition: message.browserUiPosition,
                            },
                            ...cmds,
                        ],
                    ];
                }
            }
        case "ChangedOpenErrorOverlay":
            switch (output.tag) {
                case "OutputPathError":
                    return [model, []];
                case "Output": {
                    const errors = Compile.renderOutputErrors(elmWatchJsonPath, output.elmJsonPath, output.outputPath, output.outputState.status);
                    return [
                        model,
                        [
                            {
                                tag: "ChangeOpenErrorOverlay",
                                outputState: output.outputState,
                                openErrorOverlay: message.openErrorOverlay,
                            },
                            isNonEmptyArray(errors)
                                ? {
                                    tag: "WebSocketSendCompileErrorToOutput",
                                    outputPath: output.outputPath,
                                    compilationMode: output.outputState.compilationMode,
                                    browserUiPosition: output.outputState.browserUiPosition,
                                    openErrorOverlay: message.openErrorOverlay,
                                    errors,
                                }
                                : // istanbul ignore next
                                    { tag: "NoCmd" },
                        ],
                    ];
                }
            }
        case "FocusedTab":
            return [
                model,
                [
                    { tag: "WebSocketUpdatePriority", webSocket },
                    {
                        tag: "WebSocketSend",
                        webSocket,
                        message: { tag: "FocusedTabAcknowledged" },
                    },
                ],
            ];
        case "PressedOpenEditor":
            return [
                model,
                [
                    {
                        tag: "OpenEditor",
                        file: message.file,
                        line: message.line,
                        column: message.column,
                        webSocket,
                    },
                ],
            ];
    }
}
function webSocketSend(webSocket, message) {
    webSocket.send(encodeWebSocketToClientMessage(message));
}
function webSocketSendToOutput(outputPath, message, webSocketConnections) {
    for (const webSocketConnection of webSocketConnections) {
        if (webSocketConnectionIsForOutputPath(webSocketConnection, outputPath)) {
            webSocketSend(webSocketConnection.webSocket, message);
        }
    }
}
function getNextActionSleepMs(events) {
    return Math.max(0, ...events.map(getLatestEventSleepMs));
}
function getLatestEventSleepMs(event) {
    switch (event.tag) {
        // Sleep for a little bit to avoid unnecessary recompilation when using
        // “save all” in an editor, or when running `git switch some-branch` or `git
        // restore .`. These operations results in many files being
        // added/changed/deleted, usually with 0-1 ms between each event.
        case "WatcherEvent":
            return 10;
        // Also sleep for a little bit when web sockets connect and disconnect.
        // That’s useful when there are burst connections because of multiple
        // scripts on the same page, or many tabs with elm-watch. This is slower
        // than file system events.
        case "WebSocketClosed":
        case "WebSocketConnectedNeedingCompilation":
        case "WebSocketConnectedNeedingNoAction":
        case "WebSocketConnectedWithErrors":
        case "WorkersLimitedAfterWebSocketClosed":
            return 100;
        // When switching compilation mode or browser UI position, sleep a short
        // amount of time so that the change feels more immediate.
        case "WebSocketChangedBrowserUiPosition":
        case "WebSocketChangedCompilationMode":
            return 10;
    }
}
function filterLatestEvents(events) {
    // Changes to .elm files that don’t affect anything are only
    // interesting/non-confusing if they happen on their own.
    const filtered = events.filter((event) => !(event.tag === "WatcherEvent" && !event.affectsAnyTarget));
    return isNonEmptyArray(filtered) ? filtered : events;
}
function infoMessageWithTimeline({ loggerConfig, date, mutable, message, events, hasErrors, }) {
    return join([
        "",
        printStats(loggerConfig, mutable),
        "",
        printTimeline(loggerConfig, events),
        printMessageWithTimeAndEmoji({
            loggerConfig,
            emojiName: hasErrors ? "Error" : "Success",
            date,
            dateHighlight: bold,
            message,
        }),
    ].flatMap((part) => part ?? []), "\n");
}
function printMessageWithTimeAndEmoji({ loggerConfig, emojiName, date, dateHighlight: highlightTime, message, }) {
    const newDate = loggerConfig.mockedTimings
        ? new Date("2022-02-05T13:10:05Z")
        : date;
    return Compile.printStatusLine({
        maxWidth: Infinity,
        fancy: loggerConfig.fancy,
        isTTY: loggerConfig.isTTY,
        emojiName,
        string: `${highlightTime(formatTime(newDate))} ${message}`,
    });
}
function printStats(loggerConfig, mutable) {
    const numWorkers = mutable.postprocessWorkerPool.getSize();
    return join([
        numWorkers > 0
            ? `${dim(`${ELM_WATCH_NODE} workers:`)} ${numWorkers}`
            : undefined,
        `${dim("web socket connections:")} ${mutable.webSocketConnections.length} ${dim(`(ws://0.0.0.0:${mutable.webSocketServer.port.thePort})`)}`,
    ].flatMap((part) => part === undefined
        ? []
        : Compile.printStatusLine({
            maxWidth: Infinity,
            fancy: loggerConfig.fancy,
            isTTY: loggerConfig.isTTY,
            emojiName: "Stats",
            string: part,
        })), "\n");
}
export function printTimeline(loggerConfig, events) {
    if (!isNonEmptyArray(events)) {
        return undefined;
    }
    const base = 2;
    if (events.length <= 2 * base + 1) {
        return dim(join(mapNonEmptyArray(events, (event) => printEvent(loggerConfig, event)), "\n"));
    }
    const start = events.slice(0, base);
    const end = events.slice(-base);
    const numMoreEvents = events.length - 2 * base;
    return dim(join([
        ...start.map((event) => printEvent(loggerConfig, event)),
        `${loggerConfig.fancy ? "   " : ""}(${numMoreEvents} more events)`,
        ...end.map((event) => printEvent(loggerConfig, event)),
    ], "\n"));
}
function printEvent(loggerConfig, event) {
    return printMessageWithTimeAndEmoji({
        loggerConfig,
        emojiName: "Information",
        date: event.date,
        dateHighlight: (string) => string,
        message: printEventMessage(event),
    });
}
function printEventMessage(event) {
    switch (event.tag) {
        case "WatcherEvent":
            return `${capitalize(event.eventName)} ${event.file.absolutePath}`;
        case "WebSocketClosed":
            return `Web socket disconnected for: ${event.outputPath.tag === "OutputPath"
                ? event.outputPath.targetName
                : "(no matching target)"}`;
        case "WebSocketConnectedNeedingCompilation":
            return `Web socket connected needing compilation of: ${event.outputPath.targetName}`;
        case "WebSocketConnectedNeedingNoAction":
            return `Web socket connected for: ${event.outputPath.targetName}`;
        case "WebSocketConnectedWithErrors":
            return `Web socket connected with errors (see the browser for details)`;
        case "WebSocketChangedBrowserUiPosition":
            return `Changed browser UI position to ${JSON.stringify(event.browserUiPosition)} of: ${event.outputPath.targetName}`;
        case "WebSocketChangedCompilationMode":
            return `Changed compilation mode to ${JSON.stringify(event.compilationMode)} of: ${event.outputPath.targetName}`;
        case "WorkersLimitedAfterWebSocketClosed":
            return `Terminated ${event.numTerminatedWorkers} superfluous ${event.numTerminatedWorkers === 1
                ? "worker"
                : /* istanbul ignore next */ "workers"}`;
    }
}
function compileFinishedMessage(loggerConfig, duration) {
    return `Compilation finished in ${bold(printDurationMs(loggerConfig.mockedTimings ? 123 : /* istanbul ignore next */ duration).trim())}.`;
}
function printEventsMessage(events, disabledOutputs) {
    const what1 = events.length === 1 ? "file is" : "files are";
    const what2 = disabledOutputs.size > 0 ? "any of the enabled targets" : "any target";
    return events.every((event) => event.tag === "WatcherEvent" && !event.affectsAnyTarget)
        ? `FYI: The above Elm ${what1} not imported by ${what2}. Nothing to do!`
        : "Everything up to date.";
}
