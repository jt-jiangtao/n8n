import { Service } from '@n8n/di';

import { FlowDeskConfigService } from '../config/config.service';

export type SettingsDeps = {
	config: FlowDeskConfigService;
	isAdmin: (actor: string) => boolean;
	writeConfigFile: (raw: string) => Promise<void>;
	requestCommit: (message: string) => Promise<void>;
	forwardCursorKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
	hasCursorKey: () => Promise<boolean>;
	log?: (msg: string) => void;
};

@Service()
export class FlowDeskSettingsService {
	private readonly logs: string[] = [];

	constructor(private readonly deps: SettingsDeps) {}

	async putSettings(opts: { raw: string; actor: string }): Promise<
		{ ok: true } | { ok: false; status: number; position?: string; error?: string }
	> {
		if (!this.deps.isAdmin(opts.actor)) return { ok: false, status: 403, error: 'forbidden' };
		const loaded = FlowDeskConfigService.tryLoad(opts.raw);
		if (!loaded.ok) {
			return { ok: false, status: 400, position: loaded.error?.position ?? 'parse' };
		}
		await this.deps.writeConfigFile(opts.raw);
		this.deps.config.reload(opts.raw);
		await this.deps.requestCommit(`settings update by ${opts.actor}`);
		return { ok: true };
	}

	async putCursorKey(opts: { key: string; actor: string }): Promise<
		{ ok: true } | { ok: false; status: number; error?: string }
	> {
		if (!this.deps.isAdmin(opts.actor)) return { ok: false, status: 403, error: 'forbidden' };
		// Never log the raw key.
		this.deps.log?.('cursor key update requested');
		this.logs.push('cursor key update requested');
		const result = await this.deps.forwardCursorKey(opts.key);
		if (!result.ok) return { ok: false, status: 503, error: result.error ?? 'runner unavailable' };
		return { ok: true };
	}

	async getCursorKey(opts: { actor: string }): Promise<
		{ ok: true; set: boolean } | { ok: false; status: number }
	> {
		if (!this.deps.isAdmin(opts.actor)) return { ok: false, status: 403 };
		return { ok: true, set: await this.deps.hasCursorKey() };
	}

	getDebugLogs() {
		return [...this.logs];
	}
}
