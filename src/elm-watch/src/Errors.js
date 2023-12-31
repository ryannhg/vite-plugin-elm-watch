import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { DecoderError } from "tiny-decoders";
import * as url from "url";
import { bold as boldTerminal, dim as dimTerminal, join as joinString, RESET_COLOR, toError, } from "./Helpers.js";
import { IS_WINDOWS } from "./IsWindows.js";
import { DEFAULT_COLUMNS } from "./Logger.js";
import { isNonEmptyArray, mapNonEmptyArray, } from "./NonEmptyArray.js";
import { absolutePathFromString } from "./PathHelpers.js";
import * as Theme from "./Theme.js";
function bold(string) {
    return { tag: "Bold", text: string };
}
function dim(string) {
    return { tag: "Dim", text: string };
}
function text(string) {
    return { tag: "Text", text: string.trim() };
}
function number(num) {
    return { tag: "Text", text: num.toString() };
}
function join(array, separator) {
    return text(joinString(array, separator));
}
function json(data, indent) {
    return {
        tag: "Text",
        text: indent === undefined
            ? JSON.stringify(data)
            : JSON.stringify(data, null, indent),
    };
}
function joinTemplate(array, separator) {
    return template(["", ...Array.from({ length: array.length - 1 }, () => separator), ""], ...array);
}
const elmJson = bold("elm.json");
const elmWatchJson = bold("elm-watch.json");
const elmWatchStuffJson = bold("elm-stuff/elm-watch/stuff.json");
export const fancyError = (title, location) => (strings, ...values) => (width, renderPiece) => ({
    title,
    location: fancyToPlainErrorLocation(location),
    content: template(strings, ...values)(width, renderPiece),
});
export const template = (strings, ...values) => (width, renderPiece) => joinString(strings.flatMap((string, index) => {
    const value = values[index] ?? text("");
    return [
        string,
        typeof value === "function"
            ? value(width, renderPiece)
            : renderPiece(value),
    ];
}), "").trim();
export function toTerminalString(errorTemplate, width, noColor) {
    const renderPiece = noColor
        ? (piece) => piece.text
        : renderPieceForTerminal;
    const { title, location, content } = errorTemplate(width, renderPiece);
    const prefix = `-- ${title} `;
    const line = "-".repeat(Math.max(0, width - prefix.length));
    const titleWithSeparator = renderPiece(bold(`${prefix}${line}`));
    return joinString([
        titleWithSeparator,
        ...(location === undefined
            ? []
            : [renderPiece(renderErrorLocation(location))]),
        "",
        content,
    ], "\n");
}
export function toPlainString(errorTemplate) {
    return toTerminalString(errorTemplate, DEFAULT_COLUMNS, true);
}
export function toHtml(errorTemplate, theme, noColor) {
    const renderPiece = (piece) => noColor ? piece.text : renderPieceToHtml(piece, theme);
    const { title, location, content } = errorTemplate(DEFAULT_COLUMNS, renderPiece);
    return { title, location, htmlContent: content };
}
function renderPieceForTerminal(piece) {
    switch (piece.tag) {
        case "Bold":
            return boldTerminal(piece.text);
        case "Dim":
            return dimTerminal(piece.text);
        case "ElmStyle":
            return ((piece.bold ? /* istanbul ignore next */ "\x1B[1m" : "") +
                (piece.underline ? "\x1B[4m" : "") +
                (piece.color === undefined
                    ? ""
                    : Theme.COLOR_TO_TERMINAL_ESCAPE[piece.color]) +
                piece.text +
                RESET_COLOR);
        case "Text":
            return piece.text;
    }
}
function renderPieceToHtml(piece, theme) {
    switch (piece.tag) {
        case "Bold":
            return `<b>${escapeHtml(piece.text)}</b>`;
        case "Dim":
            return `<span style="opacity: 0.6">${escapeHtml(piece.text)}</span>`;
        case "ElmStyle":
            return ((piece.bold ? /* istanbul ignore next */ "<b>" : "") +
                (piece.underline ? "<u>" : "") +
                (piece.color === undefined
                    ? ""
                    : `<span style="color: ${theme.palette[piece.color]}">`) +
                escapeHtml(piece.text) +
                (piece.color === undefined ? "" : "</span>") +
                (piece.underline ? "</u>" : "") +
                (piece.bold ? /* istanbul ignore next */ "</b>" : ""));
        case "Text":
            return escapeHtml(piece.text);
    }
}
function escapeHtml(string) {
    return string.replace(/[&<>"']/g, (match) => {
        switch (match) {
            case "&":
                return "&amp;";
            case "<":
                return "&lt;";
            case ">":
                return "&gt;";
            case '"':
                return "&quot;";
            case "'":
                return "&apos;";
            // istanbul ignore next
            default:
                return match;
        }
    });
}
function fancyToPlainErrorLocation(location) {
    switch (location.tag) {
        case "ElmJsonPath":
            return { tag: "FileOnly", file: location.theElmJsonPath };
        case "ElmWatchJsonPath":
            return { tag: "FileOnly", file: location.theElmWatchJsonPath };
        case "ElmWatchStuffJsonPath":
            return { tag: "FileOnly", file: location.theElmWatchStuffJsonPath };
        case "OutputPath":
            return { tag: "Target", targetName: location.targetName };
        case "ElmWatchNodeScriptPath":
            return {
                tag: "FileOnly",
                file: {
                    tag: "AbsolutePath",
                    absolutePath: url.fileURLToPath(location.theElmWatchNodeScriptFileUrl),
                },
            };
        case "FileWithLineAndColumn":
            return location;
        case "NoLocation":
            return undefined;
    }
}
function renderErrorLocation(location) {
    switch (location.tag) {
        case "FileOnly":
            return text(location.file.absolutePath);
        case "FileWithLineAndColumn":
            return text(`${location.file.absolutePath}:${location.line}:${location.column}`);
        case "Target":
            return dim(`Target: ${location.targetName}`);
    }
}
export function readElmWatchJsonAsJson(elmWatchJsonPath, error) {
    return fancyError("TROUBLE READING elm-watch.json", elmWatchJsonPath)`
I read inputs, outputs and options from ${elmWatchJson}.

${bold("I had trouble reading it as JSON:")}

${text(error.message)}
`;
}
export function decodeElmWatchJson(elmWatchJsonPath, error) {
    return fancyError("INVALID elm-watch.json FORMAT", elmWatchJsonPath)`
I read inputs, outputs and options from ${elmWatchJson}.

${bold("I had trouble with the JSON inside:")}

${printJsonError(error)}
`;
}

export function debugOptimizeForHot() {
    const make = bold("elm-watch make");
    const hot = bold("elm-watch hot");
    return fancyError("REDUNDANT FLAGS", { tag: "NoLocation" })`
${bold("--debug")} and ${bold("--optimize")} only make sense for ${make}.
When using ${hot}, you can switch mode in the browser.
`;
}
export function debugOptimizeClash() {
    return fancyError("CLASHING FLAGS", { tag: "NoLocation" })`
${bold("--debug")} and ${bold("--optimize")} cannot be used at the same time.
`;
}

export function unknownTargetsSubstrings(elmWatchJsonPath, knownTargets, theUnknownTargetsSubstrings) {
    return fancyError("UNKNOWN TARGETS SUBSTRINGS", elmWatchJsonPath)`
I read inputs, outputs and options from ${elmWatchJson}.

It contains these targets:

${join(knownTargets, "\n")}

${bold("But none of those match these substrings you gave me:")}

${join(theUnknownTargetsSubstrings, "\n")}

Is something misspelled?
Or do you need to add some more targets?
`;
}
export function noCommonRoot(paths) {
    return fancyError("NO COMMON ROOT", { tag: "NoLocation" })`
I could not find a common ancestor for these paths:

${join(mapNonEmptyArray(paths, (thePath) => thePath.absolutePath), "\n")}

${bold("Compiling files on different drives is not supported.")}
`;
}
export function elmJsonNotFound(outputPath, inputs, foundElmJsonPaths) {
    const extra = isNonEmptyArray(foundElmJsonPaths)
        ? template`
Note that I did find an ${elmJson} for some inputs:

${join(mapNonEmptyArray(foundElmJsonPaths, ({ inputPath, elmJsonPath }) => `${inputPath.originalString}\n-> ${elmJsonPath.theElmJsonPath.absolutePath}`), "\n\n")}

Make sure that one single ${elmJson} covers all the inputs together!
      `
        : text("");
    return fancyError("elm.json NOT FOUND", outputPath)`
I could not find an ${elmJson} for these inputs:

${join(mapNonEmptyArray(inputs, (inputPath) => inputPath.originalString), "\n")}

Has it gone missing? Maybe run ${bold("elm init")} to create one?

${extra}
`;
}
export function nonUniqueElmJsonPaths(outputPath, theNonUniqueElmJsonPaths) {
    return fancyError("NO UNIQUE elm.json", outputPath)`
I went looking for an ${elmJson} for your inputs, but I found more than one!

${join(mapNonEmptyArray(theNonUniqueElmJsonPaths, ({ inputPath, elmJsonPath }) => `${inputPath.originalString}\n-> ${elmJsonPath.theElmJsonPath.absolutePath}`), "\n\n")}

It doesn't make sense to compile Elm files from different projects into one output.

Either split this target, or move the inputs to the same project with the same
${elmJson}.
`;
}
export function inputsNotFound(outputPath, inputs) {
    return fancyError("INPUTS NOT FOUND", outputPath)`
You asked me to compile these inputs:

${joinTemplate(mapNonEmptyArray(inputs, (inputPath) => template`${text(inputPath.originalString)} ${dim(`(${inputPath.theUncheckedInputPath.absolutePath})`)}`), "\n")}

${bold("But they don't exist!")}

Is something misspelled? Or do you need to create them?
`;
}
export function inputsFailedToResolve(outputPath, inputs) {
    return fancyError("INPUTS FAILED TO RESOLVE", outputPath)`
I start by checking if the inputs you give me exist,
but doing so resulted in errors!

${join(mapNonEmptyArray(inputs, ({ inputPath, error }) => `${inputPath.originalString}:\n${error.message}`), "\n\n")}

${bold("That's all I know, unfortunately!")}
`;
}
export function duplicateInputs(outputPath, duplicates) {
    const isSymlink = (inputPath) => inputPath.theInputPath.absolutePath !== inputPath.realpath.absolutePath;
    const hasSymlink = duplicates.some(({ inputs }) => inputs.some(isSymlink));
    const symlinkText = hasSymlink
        ? "Note that at least one of the inputs seems to be a symlink. They can be tricky!"
        : "";
    return fancyError("DUPLICATE INPUTS", outputPath)`
Some of your inputs seem to be duplicates!

${joinTemplate(mapNonEmptyArray(duplicates, ({ inputs, resolved }) => joinTemplate([
        ...mapNonEmptyArray(inputs, (inputPath) => isSymlink(inputPath)
            ? template`${text(inputPath.originalString)} ${dim("(symlink)")}`
            : text(inputPath.originalString)),
        text(`-> ${resolved.absolutePath}`),
    ], "\n")), "\n\n")}

Make sure every input is listed just once!

${text(symlinkText)}
`;
}
export function duplicateOutputs(elmWatchJsonPath, duplicates) {
    return fancyError("DUPLICATE OUTPUTS", elmWatchJsonPath)`
Some of your outputs seem to be duplicates!

${joinTemplate(mapNonEmptyArray(duplicates, ({ originalOutputPathStrings, absolutePath }) => join([...originalOutputPathStrings, `-> ${absolutePath.absolutePath}`], "\n")), "\n\n")}

Make sure every output is listed just once!
`;
}
export function elmNotFoundError(location, command) {
    return fancyError("ELM NOT FOUND", location)`
I tried to execute ${bold(command.command)}, but it does not appear to exist!

${printPATH(command.options.env, IS_WINDOWS)}

Is Elm installed?

Note: If you have installed Elm locally (for example using npm or elm-tooling),
execute elm-watch using npx to make elm-watch automatically pick up that local
installation: ${bold("npx elm-watch")}
`;
}
export function commandNotFoundError(outputPath, command) {
    return fancyError("COMMAND NOT FOUND", outputPath)`
I tried to execute ${bold(command.command)}, but it does not appear to exist!

${printPATH(command.options.env, IS_WINDOWS)}

Is ${bold(command.command)} installed?
`;
}
export function otherSpawnError(location, error, command) {
    return fancyError("TROUBLE SPAWNING COMMAND", location)`
I tried to execute ${bold(command.command)}, but I ran into an error!

${text(error.message)}

This happened when trying to run the following commands:

${printCommand(command)}
`;
}
export function unexpectedElmMakeOutput(outputPath, exitReason, stdout, stderr, command) {
    return fancyError("UNEXPECTED ELM OUTPUT", outputPath)`
I ran the following commands:

${printCommand(command)}

I expected it to either exit 0 with no output (success),
or exit 1 with JSON on stderr (compile errors).

${bold("But it exited like this:")}

${printExitReason(exitReason)}
${printStdio(stdout, stderr)}
`;
}
export function unexpectedElmInstallOutput(elmJsonPath, exitReason, stdout, stderr, command) {
    return fancyError("UNEXPECTED ELM OUTPUT", elmJsonPath)`
I tried to make sure all packages are installed by running the following commands:

${printCommand(command)}

I expected it to either exit 0 with no output (success),
or exit 1 with an error I can recognize (using regex) on stderr.

${bold("But it exited like this:")}

${printExitReason(exitReason)}
${printStdio(stdout, stderr)}
`;
}
export function postprocessStdinWriteError(location, error, command) {
    return fancyError("POSTPROCESS STDIN TROUBLE", location)`
I tried to run your postprocess command:

${printCommand(command)}

Trying to write to its ${bold("stdin")}, I got an error!
${bold("Did you forget to read stdin, maybe?")}

Note: If you don't need stdin in some case, you can pipe it to stdout!

This is the error message I got:

${text(error.message)}
`;
}
export function postprocessNonZeroExit(outputPath, exitReason, stdout, stderr, command) {
    return fancyError("POSTPROCESS ERROR", outputPath)`
I ran your postprocess command:

${printCommand(command)}

${bold("It exited with an error:")}

${printExitReason(exitReason)}
${printStdio(stdout, stderr)}
`;
}
export function elmWatchNodeImportError(scriptPath, error, stdout, stderr) {
    return fancyError("POSTPROCESS IMPORT ERROR", scriptPath)`
I tried to import your postprocess file:

${printElmWatchNodeImportCommand(scriptPath)}

But that resulted in this error:

${printUnknownValueAsString(error)}

${printElmWatchNodeStdio(stdout, stderr)}
`;
}
export function elmWatchNodeDefaultExportNotFunction(scriptPath, imported, typeofDefault, stdout, stderr) {
    // This is in a variable to avoid a regex in scripts/Build.ts removing the line.
    const moduleExports = text("module.exports");
    return fancyError("MISSING POSTPROCESS DEFAULT EXPORT", scriptPath)`
I imported your postprocess file:

${printElmWatchNodeImportCommand(scriptPath)}

I expected ${bold("imported.default")} to be a function, but it isn't!

typeof imported.default === ${json(typeofDefault)}

${bold("imported")} is:

${printUnknownValueAsString(imported)}

Here is a sample function to get you started:

// CJS
${moduleExports} = async function postprocess({ code, targetName, compilationMode }) {
  return code;
};

// MJS
export default async function postprocess({ code, targetName, compilationMode }) {
  return code;
};

${printElmWatchNodeStdio(stdout, stderr)}
`;
}
export function elmWatchNodeRunError(scriptPath, args, error, stdout, stderr) {
    return fancyError("POSTPROCESS RUN ERROR", scriptPath)`
I tried to run your postprocess command:

${printElmWatchNodeImportCommand(scriptPath)}
${printElmWatchNodeRunCommand(args)}

But that resulted in this error:

${printUnknownValueAsString(error)}

${printElmWatchNodeStdio(stdout, stderr)}
`;
}
export function elmWatchNodeBadReturnValue(scriptPath, args, returnValue, stdout, stderr) {
    return fancyError("INVALID POSTPROCESS RESULT", scriptPath)`
I ran your postprocess command:

${printElmWatchNodeImportCommand(scriptPath)}
${printElmWatchNodeRunCommand(args)}

I expected ${bold("result")} to be a string, but it is:

${printUnknownValueAsString(returnValue)}

${printElmWatchNodeStdio(stdout, stderr)}
`;
}
function printElmMakeCrashBeforeError(beforeError) {
    switch (beforeError.tag) {
        case "Json":
            return template`I got back ${number(beforeError.length)} characters of JSON, but then Elm crashed with this error:`;
        case "Text":
            return beforeError.text === ""
                ? template`Elm crashed with this error:`
                : template`Elm printed this text:

${text(beforeError.text)}

Then it crashed with this error:`;
    }
}
export function elmMakeCrashError(outputPath, beforeError, error, command) {
    return fancyError("ELM CRASHED", outputPath)`
I ran the following commands:

${printCommand(command)}

${printElmMakeCrashBeforeError(beforeError)}

${text(error)}
`;
}
export function elmMakeJsonParseError(outputPath, error, errorFilePath, command) {
    return fancyError("TROUBLE WITH JSON REPORT", outputPath)`
I ran the following commands:

${printCommand(command)}

I seem to have gotten some JSON back as expected,
but I ran into an error when decoding it:

${printJsonError(error)}

${printErrorFilePath(errorFilePath)}
`;
}
export function elmMakeGeneralError(outputPath, elmJsonPath, error, extraError) {
    return fancyError(error.title, generalErrorPath(outputPath, elmJsonPath, error.path))`
${text(extraError ?? "")}

${joinTemplate(error.message.map(renderMessageChunk), "")}
`;
}
function generalErrorPath(outputPath, elmJsonPath, errorPath) {
    switch (errorPath.tag) {
        case "NoPath":
            return outputPath;
        case "elm.json":
            return elmJsonPath;
    }
}
export function elmMakeProblem(filePath, problem, extraError) {
    return fancyError(problem.title, {
        tag: "FileWithLineAndColumn",
        file: filePath,
        line: problem.region.start.line,
        column: problem.region.start.column,
    })`
${text(extraError ?? "")}

${joinTemplate(problem.message.map(renderMessageChunk), "")}
`;
}
function renderMessageChunk(chunk) {
    switch (chunk.tag) {
        case "UnstyledText":
            // This does not use `text()` since that function trims whitespace.
            return { tag: "Text", text: chunk.string };
        case "StyledText":
            return {
                tag: "ElmStyle",
                text: chunk.string,
                bold: chunk.bold,
                underline: chunk.underline,
                color: chunk.color,
            };
    }
}
export function stuckInProgressState(outputPath, state) {
    return fancyError("STUCK IN PROGRESS", outputPath)`
I thought that all outputs had finished compiling, but my inner state says
this target is still in the ${bold(state)} phase.

${bold("This is not supposed to ever happen.")}
`;
}
export function creatingDummyFailed(elmJsonPath, error) {
    return fancyError("FILE SYSTEM TROUBLE", elmJsonPath)`
I tried to make sure that all packages are installed. To do that, I need to
create a temporary dummy .elm file but that failed:

${text(error.message)}
`;
}
export function elmInstallError(elmJsonPath, title, message) {
    return fancyError(title, elmJsonPath)`
${text(message)}
`;
}
export function readElmJsonAsJson(elmJsonPath, error) {
    return fancyError("TROUBLE READING elm.json", elmJsonPath)`
I read "source-directories" from ${elmJson} when figuring out all Elm files that
your inputs depend on.

${bold("I had trouble reading it as JSON:")}

${text(error.message)}

(I still managed to compile your code, but the watcher will not work properly
and "postprocess" was not run.)
`;
}
export function decodeElmJson(elmJsonPath, error) {
    return fancyError("INVALID elm.json FORMAT", elmJsonPath)`
I read "source-directories" from ${elmJson} when figuring out all Elm files that
your inputs depend on.

${bold("I had trouble with the JSON inside:")}

${printJsonError(error)}

(I still managed to compile your code, but the watcher will not work properly
and "postprocess" was not run.)
`;
}
export function readElmWatchStuffJsonAsJson(elmWatchStuffJsonPath, error) {
    return fancyError("TROUBLE READING elm-stuff/elm-watch/stuff.json", elmWatchStuffJsonPath)`
I read stuff from ${elmWatchStuffJson} to remember some things between runs.

${bold("I had trouble reading it as JSON:")}

${text(error.message)}

This file is created by elm-watch, so reading it should never fail really.
You could try removing that file (it contains nothing essential).
`;
}
export function decodeElmWatchStuffJson(elmWatchStuffJsonPath, error) {
    return fancyError("INVALID elm-stuff/elm-watch/stuff.json FORMAT", elmWatchStuffJsonPath)`
I read stuff from ${elmWatchStuffJson} to remember some things between runs.

${bold("I had trouble with the JSON inside:")}

${printJsonError(error)}

This file is created by elm-watch, so reading it should never fail really.
You could try removing that file (it contains nothing essential).
`;
}
export function elmWatchStuffJsonWriteError(elmWatchStuffJsonPath, error) {
    return fancyError("TROUBLE WRITING elm-stuff/elm-watch/stuff.json", elmWatchStuffJsonPath)`
I write stuff to ${elmWatchStuffJson} to remember some things between runs.

${bold("I had trouble writing that file:")}

${text(error.message)}

The file contains nothing essential, but something weird is going on.
`;
}
export function importWalkerFileSystemError(outputPath, error) {
    return fancyError("TROUBLE READING ELM FILES", outputPath)`
When figuring out all Elm files that your inputs depend on I read a lot of Elm files.
Doing so I encountered this error:

${text(error.message)}

(I still managed to compile your code, but the watcher will not work properly
and "postprocess" was not run.)
`;
}
export function needsToWriteProxyFileReadError(outputPath, error, triedPath) {
    return fancyError("TROUBLE CHECKING OUTPUT", outputPath)`
I managed to typecheck your code. Then I tried to read part of the previous output,
to see if I need to write a dummy output file there:

${text(triedPath.absolutePath)}

Doing so I encountered this error:

${text(error.message)}
`;
}
export function readOutputError(outputPath, error, triedPath) {
    return fancyError("TROUBLE READING OUTPUT", outputPath)`
I managed to compile your code. Then I tried to read the output:

${text(triedPath.absolutePath)}

Doing so I encountered this error:

${text(error.message)}
`;
}
export function writeOutputError(outputPath, error, reasonForWriting) {
    return fancyError("TROUBLE WRITING OUTPUT", outputPath)`
I managed to compile your code and read the generated file:

${text(outputPath.temporaryOutputPath.absolutePath)}

${printWriteOutputErrorReasonForWriting(reasonForWriting)}

${text(outputPath.theOutputPath.absolutePath)}

But I encountered this error:

${text(error.message)}
`;
}
function printWriteOutputErrorReasonForWriting(reasonForWriting) {
    switch (reasonForWriting) {
        case "InjectWebSocketClient":
            return text("I injected code for hot reloading, and then tried to write that to the output path:");
        case "Postprocess":
            return text("After running your postprocess command, I tried to write the result of that to the output path:");
    }
}
export function writeProxyOutputError(outputPath, error) {
    return fancyError("TROUBLE WRITING DUMMY OUTPUT", outputPath)`
There are no WebSocket connections for this target, so I only typecheck the
code. That went well. Then I tried to write a dummy output file here:

${text(outputPath.theOutputPath.absolutePath)}

Doing so I encountered this error:

${text(error.message)}
`;
}
export function portConflictForNoPort(error) {
    return fancyError("PORT CONFLICT", { tag: "NoLocation" })`
I ask the operating system for an arbitrary available port for the
web socket server.

The operating system is supposed to always be able to find an available port,
but it looks like that wasn't the case this time!

This is the error message I got:

${text(error.message)}
  `;
}
export function portConflictForPersistedPort(elmWatchStuffJsonPath, port) {
    return fancyError("PORT CONFLICT", elmWatchStuffJsonPath)`
I ask the operating system for an arbitrary available port for the
web socket server.

I then save the port I got to ${elmWatchStuffJson}. Otherwise I would
get a new port number on each restart, which means that if you had tabs
open in the browser they would try to connect to the old port number.

I tried to use such a saved port number from a previous run (or from previous
configuration). But now that port (${number(port.thePort)}) wasn't available!

Most likely you already have elm-watch running somewhere else! If so,
find it and use that, or kill it.

If not, something else could have started using port ${number(port.thePort)}
(though it's not very likely.) Then you can either try to find what that is,
or remove ${elmWatchStuffJson} here:

${text(elmWatchStuffJsonPath.theElmWatchStuffJsonPath.absolutePath)}

Then I will ask the operating system for a new arbitrary available port.
  `;
}
export function portConflictForPortFromConfig(elmWatchJsonPath, port) {
    return fancyError("PORT CONFLICT", elmWatchJsonPath)`
In your ${elmWatchJson} you have this:

"port": ${json(port.thePort)}

But something else seems to already be running on that port!
You might already have elm-watch running somewhere, or it could be a completely
different program.

You need to either find and stop that other thing, switch to another port or
remove "port" from ${elmWatchJson} (which will use an arbitrary available port.)
  `;
}
export function watcherError(error) {
    return fancyError("WATCHER ERROR", { tag: "NoLocation" })`
The file watcher encountered an error, which means that it cannot continue.
elm-watch is powered by its file watcher, so I have to exit at this point.

See if this is something you can solve by maybe removing some problematic files
or something!

This is the error message I got:

${text(error.message)}
  `;
}
export function webSocketBadUrl(expectedStart, actualUrlString) {
    return `
I expected the web socket connection URL to start with:

${expectedStart}

But it looks like this:

${actualUrlString}

The web socket code I generate is supposed to always connect using a correct URL, so something is up here.
  `.trim();
}
export function webSocketParamsDecodeError(error, actualUrlString) {
    return `
I ran into trouble parsing the web socket connection URL parameters:

${printJsonError(error).text}

The URL looks like this:

${actualUrlString}

The web socket code I generate is supposed to always connect using a correct URL, so something is up here. Maybe the JavaScript code running in the browser was compiled with an older version of elm-watch? If so, try reloading the page.
  `;
}
export function webSocketWrongVersion(expectedVersion, actualVersion) {
    return `
The compiled JavaScript code running in the browser says it was compiled with:

elm-watch ${actualVersion}

But the server is:

elm-watch ${expectedVersion}

Maybe the JavaScript code running in the browser was compiled with an older version of elm-watch? If so, try reloading the page.
  `.trim();
}
export function webSocketTargetNotFound(targetName, enabledOutputs, disabledOutputs) {
    const extra = isNonEmptyArray(disabledOutputs)
        ? `

These targets are also available in elm-watch.json, but are not enabled (because of the CLI arguments passed):

${joinString(mapNonEmptyArray(disabledOutputs, (outputPath) => outputPath.targetName), "\n")}
  `.trimEnd()
        : "";
    return `
The compiled JavaScript code running in the browser says it is for this target:

${targetName}

But I can't find that target in elm-watch.json!

These targets are available in elm-watch.json:

${joinString(enabledOutputs.map((outputPath) => outputPath.targetName), "\n")}${extra}

Maybe this target used to exist in elm-watch.json, but you removed or changed it?
If so, try reloading the page.
  `.trim();
}
export function webSocketTargetDisabled(targetName, enabledOutputs, disabledOutputs) {
    return `
The compiled JavaScript code running in the browser says it is for this target:

${targetName}

That target does exist in elm-watch.json, but isn't enabled.

These targets are enabled via CLI arguments:

${joinString(enabledOutputs.map((outputPath) => outputPath.targetName), "\n")}

These targets exist in elm-watch.json but aren't enabled:

${joinString(disabledOutputs.map((outputPath) => outputPath.targetName), "\n")}

If you want to have this target compiled, restart elm-watch either with more CLI arguments or no CLI arguments at all!
  `.trim();
}
export function webSocketDecodeError(error) {
    return `
The compiled JavaScript code running in the browser seems to have sent a message that the web socket server cannot recognize!

${printJsonError(error).text}

The web socket code I generate is supposed to always send correct messages, so something is up here.
  `.trim();
}
export function printPATH(env, isWindows) {
    if (isWindows) {
        return printPATHWindows(env);
    }
    const { PATH } = env;
    if (PATH === undefined) {
        return template`I can't find any program, because process.env.PATH is undefined!`;
    }
    const pathList = PATH.split(path.delimiter);
    return template`
This is what the PATH environment variable looks like:

${join(pathList, "\n")}
  `;
}
function printPATHWindows(env) {
    const pathEntries = Object.entries(env).flatMap(([key, value]) => key.toUpperCase() === "PATH" && value !== undefined
        ? [[key, value]]
        : []);
    if (!isNonEmptyArray(pathEntries)) {
        return template`I can't find any program, because I can't find any PATH-like environment variables!`;
    }
    if (pathEntries.length === 1) {
        const [key, value] = pathEntries[0];
        return template`
This is what the ${text(key)} environment variable looks like:

${join(value.split(path.delimiter), "\n")}
    `;
    }
    const pathEntriesString = join(pathEntries.map(([key, value]) => joinString([`${key}:`, ...value.split(path.delimiter)], "\n")), "\n\n");
    return template`
You seem to have several PATH-like environment variables set. The last one
should be the one that is actually used, but it's better to have a single one!

${pathEntriesString}
  `;
}
function printCommand(command) {
    const stdin = command.stdin === undefined
        ? ""
        : `${commandToPresentationName([
            "printf",
            truncate(command.stdin.toString("utf8")),
        ])} | `;
    return text(`
${commandToPresentationName(["cd", command.options.cwd.absolutePath])}
${stdin}${commandToPresentationName([command.command, ...command.args])}
`);
}
function commandToPresentationName(command) {
    return joinString(command.map((part) => part === ""
        ? "''"
        : joinString(part
            .split(/(')/)
            .map((subPart) => subPart === ""
                ? ""
                : subPart === "'"
                    ? "\\'"
                    : /^[\w.,:/=@%+-]+$/.test(subPart)
                        ? subPart
                        : `'${subPart}'`), "")), " ");
}
function printExitReason(exitReason) {
    switch (exitReason.tag) {
        case "ExitCode":
            return text(`exit ${exitReason.exitCode}`);
        case "Signal":
            return text(`signal ${exitReason.signal}`);
        case "Unknown":
            return text("unknown exit reason");
    }
}
export function printStdio(stdout, stderr) {
    return stdout !== "" && stderr === ""
        ? limitStdio(stdout)
        : stdout === "" && stderr !== ""
            ? limitStdio(stderr)
            : stdout === "" && stderr === ""
                ? template`${dim("(no output)")}`
                : template`
STDOUT:
${limitStdio(stdout)}

STDERR:
${limitStdio(stderr)}
`;
}
function printElmWatchNodeStdio(stdout, stderr) {
    return stdout === "" && stderr === ""
        ? template``
        : template`
STDOUT:
${limitStdio(stdout)}

STDERR:
${limitStdio(stderr)}
`;
}
// Limit `string` to take at most 100 lines of terminal (roughly).
// It doesn’t need to be precise. As long as we don’t print megabytes of
// JavaScript that completely destroys the error message we’re good.
const limitStdio = (string) => (width, renderPiece) => {
    const max = 100;
    const lines = string.trimEnd().split("\n");
    const result = [];
    let usedLines = 0;
    for (const line of lines) {
        const count = Math.ceil(line.length / width);
        const available = max - usedLines;
        if (available <= 0) {
            break;
        }
        else if (count > available) {
            const take = available * width;
            const left = line.length - take;
            result.push(`${line.slice(0, take)} ${renderPiece(dim(left === 1 ? "1 more character" : `${left} more characters`))}`);
            usedLines += available;
            break;
        }
        else {
            result.push(line);
            usedLines += count;
        }
    }
    const joined = joinString(result, "\n");
    const left = lines.length - result.length;
    return left > 0
        ? `${joined}\n${renderPiece(dim(left === 1 ? "1 more line" : `${left} more lines`))}`
        : joined;
};
function printErrorFilePath(errorFilePath) {
    switch (errorFilePath.tag) {
        case "AbsolutePath":
            return template`
I wrote that to this file so you can inspect it:

${text(errorFilePath.absolutePath)}
      `;
        case "WritingErrorFileFailed":
            return template`
I tried to write that to this file:

${text(errorFilePath.attemptedPath.absolutePath)}

${bold("But that failed too:")}

${text(errorFilePath.error.message)}
      `;
        case "ErrorFileBadContent":
            return template`
I wrote this error to a file so you can inspect and possibly report it more easily.

This is the data that caused the error:

${text(errorFilePath.content)}
      `;
    }
}
function printUnknownValueAsString(value) {
    switch (value.tag) {
        case "UnknownValueAsString":
            return text(value.value);
    }
}
function printElmWatchNodeImportCommand(scriptPath) {
    return template`const imported = await import(${json(scriptPath.theElmWatchNodeScriptFileUrl)})`;
}
function printElmWatchNodeRunCommand(args) {
    const truncated = {
        ...args,
        code: truncate(args.code),
    };
    return template`const result = await imported.default(${json(truncated, 2)})`;
}
function truncate(string) {
    const roughLimit = 20;
    const half = Math.floor(roughLimit / 2);
    return string.length <= roughLimit
        ? // istanbul ignore next
        string
        : `${string.slice(0, half)}...${string.slice(-half)}`;
}
function printJsonError(error) {
    return text(error instanceof DecoderError ? error.format() : error.message);
}
export function tryWriteErrorFile({ cwd, name, content, hash, }) {
    // The SHA256 is only based on the `hash` string, not the entire error message
    // `content`. This makes the tests easier to update when tweaking the error message.
    const jsonPath = absolutePathFromString(cwd, `elm-watch-${name}-${sha256(hash)}.txt`);
    try {
        fs.writeFileSync(jsonPath.absolutePath, content);
        return jsonPath;
    }
    catch (unknownError) {
        const error = toError(unknownError);
        return {
            tag: "WritingErrorFileFailed",
            error,
            attemptedPath: jsonPath,
        };
    }
}
function sha256(string) {
    return crypto.createHash("sha256").update(string).digest("hex");
}
