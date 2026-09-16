import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Check the CLI contract without starting TTS, downloading models, or playing audio. */
export function resolveAgentSayBin(
	env: NodeJS.ProcessEnv = process.env,
	homeDir: string = homedir(),
): string | null {
	const path = env.AGENT_SAY_BIN ?? join(homeDir, ".local", "bin", "agent-say");
	try {
		if (!statSync(path).isFile()) return null;
		accessSync(path, constants.X_OK);
		return path;
	} catch {
		return null;
	}
}
