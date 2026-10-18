import { Service } from '@n8n/di';

export type AreaConfigFile = {
	areas: Record<
		string,
		{
			plane: { project: string };
			repo: string;
			baseRef: string;
			suites: Record<string, string>;
			roles: Record<string, string[]>;
			mergeMethod: string;
			agent: { adapter: string };
			autonomy?: Record<string, number>;
		}
	>;
	groups: Record<string, string[]>;
	guards: {
		protectedPaths: string[];
		baselinePaths?: string[];
		killSwitch?: boolean;
	};
	provenance: { escapeWindowDays: number };
	desktop: { stopPlaneOnQuit?: boolean; launchAtLogin?: boolean; hostAddress: string };
	autonomyPolicy?: {
		window?: number;
		minPassRate?: number;
		maxEscapes?: number;
		maxReturns?: number;
	};
};

@Service()
export class FlowDeskConfigService {
	private data: AreaConfigFile;
	private lastError: { message: string; position?: string } | null = null;
	private statesEnsured = false;
	private killSwitch = false;

	constructor(initial: AreaConfigFile) {
		this.data = initial;
		this.killSwitch = Boolean(initial.guards?.killSwitch);
	}

	static tryLoad(raw: string): {
		ok: boolean;
		error?: { position: string };
		config?: FlowDeskConfigService;
	} {
		const hasAreas = raw.includes('areas:') || /"areas"\s*:/.test(raw);
		if (!hasAreas || raw.includes('areas: [')) {
			return { ok: false, error: { position: 'areas' } };
		}
		try {
			if (raw.trim().startsWith('{')) {
				const parsed = JSON.parse(raw) as AreaConfigFile;
				return { ok: true, config: new FlowDeskConfigService(parsed) };
			}
			return { ok: false, error: { position: 'parse' } };
		} catch (error) {
			return { ok: false, error: { position: String(error) } };
		}
	}

	getArea(area: string) {
		return this.data.areas[area];
	}

	getGuards() {
		return {
			protectedPaths: this.data.guards.protectedPaths ?? [],
			baselinePaths: this.data.guards.baselinePaths ?? [],
		};
	}

	getAutonomyPolicy() {
		return {
			window: this.data.autonomyPolicy?.window ?? 20,
			minPassRate: this.data.autonomyPolicy?.minPassRate ?? 0.9,
			maxEscapes: this.data.autonomyPolicy?.maxEscapes ?? 0,
			maxReturns: this.data.autonomyPolicy?.maxReturns ?? 2,
		};
	}

	getEscapeWindowDays() {
		return this.data.provenance.escapeWindowDays;
	}

	getGroups() {
		return this.data.groups;
	}

	getKillSwitch() {
		return this.killSwitch;
	}

	setKillSwitch(on: boolean) {
		this.killSwitch = on;
		this.data.guards.killSwitch = on;
	}

	resolveRole(role: string, area: string): string[] {
		if (role.startsWith('area.')) {
			const key = role.slice('area.'.length);
			return this.data.areas[area]?.roles?.[key] ?? [];
		}
		return this.data.groups[role] ?? [];
	}

	reload(raw: string) {
		const next = FlowDeskConfigService.tryLoad(raw);
		if (!next.ok || !next.config) {
			this.lastError = { message: 'invalid config', position: next.error?.position };
			return;
		}
		const areas = Object.values(next.config.data.areas);
		if (!areas.some((a) => a.repo)) {
			this.lastError = { message: 'invalid config', position: 'areas.*.repo' };
			return;
		}
		const prevKill = this.killSwitch;
		this.data = next.config.data;
		this.killSwitch = prevKill || Boolean(next.config.data.guards?.killSwitch);
		this.lastError = null;
	}

	status() {
		return { error: this.lastError, killSwitch: this.killSwitch };
	}

	async ensureAreaStates(plane: { ensureProjectStates: () => Promise<unknown> }) {
		if (this.statesEnsured) return;
		await plane.ensureProjectStates();
		this.statesEnsured = true;
	}
}
