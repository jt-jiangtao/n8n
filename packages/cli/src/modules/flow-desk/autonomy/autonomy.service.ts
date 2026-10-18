import type { FlowDeskConfigService } from '../config/config.service';

const NON_SKIPPABLE = new Set([
	'bug-standard',
	'bug-hotfix',
	'feature-small',
	'feature-large',
	'chore-refactor',
	'ui-audit',
	'code-quality',
	'meta-retro',
	'platform-upgrade',
]);

export type WorkRecord = {
	id: string;
	flowType: string;
	area: string;
	ended: boolean;
	confirmPass: boolean;
	escapes: number;
	returns: number;
};

export type AutonomyDeps = {
	config: FlowDeskConfigService;
	plane: {
		createIssue: (input: {
			title: string;
			description?: string;
			labels: string[];
			project?: string;
			state?: string;
			assignees?: string[];
		}) => Promise<{ id: string }>;
		createRelation: (from: string, to: string, type: string) => Promise<unknown>;
		comment: (id: string, body: string) => Promise<unknown>;
		updateIssueState: (id: string, state: string) => Promise<unknown>;
	};
	writeConfig: (patch: {
		area: string;
		flowType: string;
		level: number;
		reason: string;
	}) => Promise<void>;
	getGroup: (name: string) => string[];
};

export class FlowDeskAutonomyService {
	constructor(private readonly deps: AutonomyDeps) {}

	canGrantLevel2(flowType: string) {
		return !NON_SKIPPABLE.has(flowType);
	}

	getLevel(area: string, flowType: string): number {
		const a = this.deps.config.getArea(area) as { autonomy?: Record<string, number> } | undefined;
		const level = a?.autonomy?.[flowType];
		return typeof level === 'number' ? level : 1;
	}

	validateAutonomy(areas: Record<string, Record<string, number>>): { ok: boolean; reason?: string } {
		for (const [area, flows] of Object.entries(areas)) {
			for (const [flow, level] of Object.entries(flows)) {
				if (level === 2 && !this.canGrantLevel2(flow)) {
					return { ok: false, reason: `${area}/${flow} cannot be level 2` };
				}
			}
		}
		return { ok: true };
	}

	async evaluateDaily(records: WorkRecord[]): Promise<boolean> {
		const policy = this.deps.config.getAutonomyPolicy();
		const window = policy.window;
		const minPassRate = policy.minPassRate;
		const maxEscapes = policy.maxEscapes;
		const maxReturns = policy.maxReturns;

		const byKey = new Map<string, WorkRecord[]>();
		for (const r of records.filter((x) => x.ended)) {
			const k = `${r.area}:${r.flowType}`;
			const list = byKey.get(k) ?? [];
			list.push(r);
			byKey.set(k, list);
		}

		let built = false;
		for (const [key, list] of byKey) {
			if (list.length < window) continue;
			const recent = list.slice(-window);
			const passRate = recent.filter((r) => r.confirmPass).length / recent.length;
			const escapes = recent.reduce((s, r) => s + r.escapes, 0);
			const returns = recent.reduce((s, r) => s + r.returns, 0);
			if (passRate < minPassRate || escapes > maxEscapes || returns > maxReturns) continue;
			const [area, flowType] = key.split(':');
			if (!this.canGrantLevel2(flowType)) continue;
			if (this.getLevel(area, flowType) >= 2) continue;
			await this.deps.plane.createIssue({
				title: `放权升级：${area}/${flowType} → 2`,
				description: `passRate=${passRate} escapes=${escapes} returns=${returns}`,
				labels: ['autonomy:upgrade', `area:${area}`],
				state: '收件箱',
				assignees: this.deps.getGroup('platform.owner'),
			});
			built = true;
		}
		return built;
	}

	async confirmUpgrade(input: {
		actor: string;
		area: string;
		flowType: string;
		toLevel: number;
	}) {
		const owners = this.deps.getGroup('platform.owner');
		if (!owners.includes(input.actor)) {
			const err = new Error('not platform owner') as Error & { code: string };
			err.code = 'NOT_PLATFORM_OWNER';
			throw err;
		}
		await this.setLevel(input.area, input.flowType, input.toLevel, `upgrade by ${input.actor}`);
	}

	async applyEscape(input: {
		area: string;
		flowType: string;
		issueId: string;
		escapeIssueId: string;
	}) {
		const level = this.getLevel(input.area, input.flowType);
		if (level !== 2) return;
		await this.setLevel(input.area, input.flowType, 1, 'escape demote 2→1');
		const body = `逃逸：${input.area}/${input.flowType} 从 2 级降为 1 级`;
		await this.deps.plane.comment(input.issueId, body);
		await this.deps.plane.comment(input.escapeIssueId, body);
	}

	async maybeAutoPass(input: {
		area: string;
		flowType: string;
		parentIssueId: string;
		skipAtLevel: number;
		touchedPaths: string[];
		depsMajorOrSecurity?: boolean;
	}): Promise<{ autoPassed: boolean; decision?: 'autonomy' }> {
		const level = this.getLevel(input.area, input.flowType);
		if (level < input.skipAtLevel) return { autoPassed: false };
		if (input.depsMajorOrSecurity) return { autoPassed: false };
		const protectedPaths = this.deps.config.getGuards().protectedPaths ?? [];
		if (input.touchedPaths.some((p) => protectedPaths.some((g) => matchGlob(g, p)))) {
			return { autoPassed: false };
		}
		const sample = await this.deps.plane.createIssue({
			title: `抽查：${input.parentIssueId}`,
			labels: [`area:${input.area}`],
			state: '收件箱',
			assignees: (
				(this.deps.config.getArea(input.area) as { roles?: { mergeApprover?: string[] } })?.roles
					?.mergeApprover ?? []
			),
		});
		await this.deps.plane.createRelation(sample.id, input.parentIssueId, '跟进');
		return { autoPassed: true, decision: 'autonomy' };
	}

	async handleLevel0Writes(input: {
		parentIssueId: string;
		childIssueId: string;
		suggestion: string;
	}) {
		await this.deps.plane.comment(input.childIssueId, `建议：${input.suggestion}`);
		await this.deps.plane.comment(input.parentIssueId, '0 级：只给出建议');
		await this.deps.plane.updateIssueState(input.parentIssueId, '完成');
		return { endRun: true, skipRemaining: true };
	}

	isAutonomyDecisionActor(actor: string) {
		return actor === 'module';
	}

	private async setLevel(area: string, flowType: string, level: number, reason: string) {
		const a = this.deps.config.getArea(area) as { autonomy?: Record<string, number> };
		if (!a.autonomy) a.autonomy = {};
		a.autonomy[flowType] = level;
		await this.deps.writeConfig({ area, flowType, level, reason });
	}
}

function matchGlob(pattern: string, file: string): boolean {
	// minimal ** / * support for tests
	const re = new RegExp(
		'^' +
			pattern
				.replace(/[.+^${}()|[\]\\]/g, '\\$&')
				.replace(/\*\*/g, '.*')
				.replace(/\*/g, '[^/]*') +
			'$',
	);
	return re.test(file);
}
