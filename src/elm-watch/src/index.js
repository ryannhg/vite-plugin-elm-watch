import * as Help from "./Help";
import { unknownErrorToString } from "./Helpers";
import { init } from "./Init";
import { makeLogger } from "./Logger";
import { absolutePathFromString } from "./PathHelpers";
import { PostprocessWorkerPool } from "./Postprocess";
import { run } from "./Run";
export async function elmWatchCli(args, { cwd: cwdString, env, stdin, stdout, stderr, logDebug, hotKillManager = { kill: undefined }, }) {
    const getNow = () => new Date();
    const logger = makeLogger({
        env,
        getNow,
        stdin,
        stdout,
        stderr,
        logDebug,
    });
    const cwd = {
        tag: "Cwd",
        path: absolutePathFromString({ tag: "AbsolutePath", absolutePath: process.cwd() }, cwdString),
    };
    const isHelp = args.some((arg) => arg === "-h" || arg === "-help" || arg === "--help");
    if (isHelp) {
        logger.write(Help.render(logger.config));
        return 0;
    }
    const restArgs = args
        .slice(1)
        .map((arg) => ({ tag: "CliArg", theArg: arg }));
    switch (args[0]) {
        case undefined:
        case "help":
            logger.write(Help.render(logger.config));
            return 0;
        case "init":
            return init(cwd, logger, restArgs);
        case "make":
        case "hot": {
            const runMode = args[0];
            return new Promise((resolve, reject) => {
                const doIt = async () => {
                    let result;
                    do {
                        result = await run(cwd, env, logger, getNow, runMode, restArgs, result === undefined ? [] : result.restartReasons, result === undefined
                            ? new PostprocessWorkerPool(reject)
                            : result.postprocessWorkerPool, result === undefined ? undefined : result.webSocketState, hotKillManager);
                    } while (result.tag === "Restart");
                    switch (result.tag) {
                        case "Exit":
                            return result.exitCode;
                    }
                };
                doIt().then(resolve).catch(reject);
            });
        }
        default:
            logger.write(`Unknown command: ${args[0]}`);
            return 1;
    }
}
// istanbul ignore if
if (require.main === module) {
    process.title = "elm-watch";
    elmWatchCli(process.argv.slice(2), {
        cwd: process.cwd(),
        env: process.env,
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        logDebug: (message) => process.stderr.write(`${message}\n`),
    })
        .then((exitCode) => {
        // Let the process exit with this exit code when the event loop is empty.
        process.exitCode = exitCode;
        // Turn off raw mode so that ctrl+c automatically kills things left behind
        // accidentally on the event loop. That’s of course a bug, but if it
        // happens it should at least be possible to exit with a simple ctrl+c.
        // Note: `.setRawMode` is `undefined` when stdin is not a TTY, but this is
        // not reflected in the type definitions.
        if (process.stdin.setRawMode !== undefined) {
            process.stdin.setRawMode(false);
        }
        if (process.stdout.isTTY) {
            process.stdout.write("Exiting elm-watch. Press ctrl+c (again) to force.");
            process.once("exit", () => {
                process.stdout.cursorTo(0);
                process.stdout.clearLine(0);
            });
        }
    })
        .catch((error) => {
        process.stderr.write(`Unexpected error:\n${unknownErrorToString(error)}\n`);
        // Forcefully exit since the watcher might still be running.
        process.exit(1);
    });
}
