/**
 * SSH Remote Execution Example
 *
 * Demonstrates delegating tool operations to a remote machine via SSH.
 * When --ssh is provided, read/write/edit/bash run on the remote.
 *
 * Usage:
 *   pi -e ./ssh.ts --ssh user@host
 *   pi -e ./ssh.ts --ssh user@host:/remote/path
 *
 * Requirements:
 *   - SSH key-based auth (no password prompts)
 *   - bash on remote
 */

import { spawn } from "node:child_process";
import { posix, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { shellQuote } from "./shared/shell.ts";

function sshExec(remote: string, command: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [remote, command], { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (data) => chunks.push(data));
		child.stderr.on("data", (data) => errChunks.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

function createPathMapper(localCwd: string, remoteCwd: string): (path: string) => string {
	const localRoot = resolve(localCwd);
	const normalizedRemoteCwd = remoteCwd.replace(/\/+$/, "") || "/";
	return (path: string) => {
		const absolute = resolve(localRoot, path);
		const rel = relative(localRoot, absolute);
		if (rel === "") return normalizedRemoteCwd;
		if (rel.startsWith("..") || rel === ".." || posix.isAbsolute(rel)) {
			throw new Error(`SSH path is outside the mapped working directory: ${path}`);
		}
		return posix.join(normalizedRemoteCwd, ...rel.split(/[\\/]+/));
	};
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
	const toRemote = createPathMapper(localCwd, remoteCwd);
	return {
		readFile: (p) => sshExec(remote, `cat ${shellQuote(toRemote(p))}`),
		access: (p) => sshExec(remote, `test -r ${shellQuote(toRemote(p))}`).then(() => {}),
		detectImageMimeType: async (p) => {
			try {
				const r = await sshExec(remote, `file --mime-type -b ${shellQuote(toRemote(p))}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string): WriteOperations {
	const toRemote = createPathMapper(localCwd, remoteCwd);
	return {
		writeFile: async (p, content) => {
			const b64 = Buffer.from(content).toString("base64");
			await sshExec(remote, `printf %s ${shellQuote(b64)} | base64 -d > ${shellQuote(toRemote(p))}`);
		},
		mkdir: (dir) => sshExec(remote, `mkdir -p ${shellQuote(toRemote(dir))}`).then(() => {}),
	};
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
	const r = createRemoteReadOps(remote, remoteCwd, localCwd);
	const w = createRemoteWriteOps(remote, remoteCwd, localCwd);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
	const toRemote = createPathMapper(localCwd, remoteCwd);
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				const cmd = `cd ${shellQuote(toRemote(cwd))} && ${command}`;
				const child = spawn("ssh", [remote, cmd], { stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, timeout * 1000)
					: undefined;
				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.on("error", (e) => {
					if (timer) clearTimeout(timer);
					reject(e);
				});
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

	// Resolved lazily on session_start (CLI flags not available during factory)
	let resolvedSsh: { remote: string; remoteCwd: string } | null = null;

	const getSsh = () => resolvedSsh;

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createReadTool(localCwd, {
					operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localRead.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createWriteTool(localCwd, {
					operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localWrite.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createEditTool(localCwd, {
					operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localEdit.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createBashTool(localCwd, {
					operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Resolve SSH config now that CLI flags are available
		const arg = pi.getFlag("ssh") as string | undefined;
		if (arg) {
			const pathSeparator = arg.indexOf(":");
			if (pathSeparator >= 0) {
				const remote = arg.slice(0, pathSeparator);
				const path = arg.slice(pathSeparator + 1);
				resolvedSsh = { remote, remoteCwd: path };
			} else {
				// No path given, evaluate pwd on remote
				const remote = arg;
				const pwd = (await sshExec(remote, "pwd")).toString().trim();
				resolvedSsh = { remote, remoteCwd: pwd };
			}
			if (ctx.hasUI) {
				ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
				ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
			}
		}
	});

	// Handle user ! commands via SSH
	pi.on("user_bash", (_event) => {
		const ssh = getSsh();
		if (!ssh) return; // No SSH, use local execution
		return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd) };
	});

	// Replace local cwd with remote cwd in system prompt
	pi.on("before_agent_start", async (event) => {
		const ssh = getSsh();
		if (ssh) {
			const modified = event.systemPrompt.replace(
				`Current working directory: ${localCwd}`,
				`Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
			);
			return { systemPrompt: modified };
		}
	});
}
