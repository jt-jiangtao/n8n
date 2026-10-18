import { Service } from '@n8n/di';

import type { FlowDeskConfigService } from '../config/config.service';
import type { FlowDeskSecretsService } from '../secrets/secrets.service';

function matchGlob(filePath: string, pattern: string): boolean {
	const normalized = filePath.replace(/\\/g, '/');
	const pat = pattern.replace(/\\/g, '/');
	let regex = '^';
	for (let i = 0; i < pat.length; i++) {
		const c = pat[i];
		if (c === '*' && pat[i + 1] === '*') {
			if (pat[i + 2] === '/') {
				regex += '(?:.*/)?';
				i += 2;
			} else {
				regex += '.*';
				i += 1;
			}
		} else if (c === '*') {
			regex += '[^/]*';
		} else if (c === '?') {
			regex += '[^/]';
		} else if ('+.^${}()|[]\\'.includes(c)) {
			regex += `\\${c}`;
		} else {
			regex += c;
		}
	}
	regex += '$';
	return new RegExp(regex).test(normalized);
}

export type RunnerClient = {
	dispatch: (payload: unknown) => Promise<unknown>;
	abort: (taskId: string) => Promise<void>;
	status?: () => Promise<number>;
};

export type PlaneClient = {
	comment: (issueId: string, body: string) => Promise<unknown>;
};

@Service()
export class FlowDeskGuardsService {
	constructor(
		private readonly config: FlowDeskConfigService,
		private readonly runner: RunnerClient,
		private readonly plane: PlaneClient,
		private readonly secrets?: FlowDeskSecretsService,
	) {}

	allowsHumanStep() {
		return true;
	}

	selectAdapter(opts: { nodeAdapter?: string; areaAdapter?: string }): string {
		const name = opts.nodeAdapter || opts.areaAdapter;
		if (!name || !['fake', 'codex', 'cursor'].includes(name)) {
			throw new Error(`unknown or missing adapter: ${String(name)}`);
		}
		return name;
	}

	checkPaths(files: string[]) {
		const { protectedPaths, baselinePaths } = this.config.getGuards();
		const protectedHits = files.filter((f) => protectedPaths.some((p) => matchGlob(f, p)));
		const baselineHits = files.filter((f) => baselinePaths.some((p) => matchGlob(f, p)));
		return {
			protected: protectedHits,
			baseline: baselineHits,
			allowed: baselineHits.length === 0,
		};
	}

	annotateResult(opts: { adapter: string; sandboxed?: boolean; files: string[] }): string {
		const parts: string[] = [];
		if (opts.adapter === 'cursor' || opts.sandboxed === false) {
			parts.push('未在沙箱中运行（unsandboxed）');
		}
		const paths = this.checkPaths(opts.files);
		if (paths.protected.length) {
			parts.push(`受保护路径: ${paths.protected.join(', ')}`);
		}
		if (paths.baseline.length) {
			parts.push(`底线代码路径不可修改: ${paths.baseline.join(', ')}`);
		}
		return parts.join('\n');
	}

	async onKillSwitchOpened(opts: { runningTaskIds: string[] }) {
		for (const id of opts.runningTaskIds) {
			await this.runner.abort(id);
		}
	}

	async setKillSwitch(opts: {
		on: boolean;
		actor: string;
		serviceToken?: string;
		shellToken?: string;
	}): Promise<{ status: number }> {
		if (opts.shellToken !== undefined) {
			const expected = this.secrets?.shellToken ?? 'shell';
			if (opts.shellToken !== expected) return { status: 401 };
			this.config.setKillSwitch(opts.on);
			return { status: 200 };
		}
		const svc = this.secrets?.serviceToken ?? 'svc';
		if (opts.serviceToken !== svc) return { status: 401 };
		const isAdmin = this.secrets?.isAdmin(opts.actor) ?? opts.actor === 'admin-1';
		if (!isAdmin) return { status: 403 };
		this.config.setKillSwitch(opts.on);
		return { status: 200 };
	}
}
