import { Service } from '@n8n/di';

export type SecretsDeps = {
	readRunnerToken: () => Promise<string>;
	forwardCursorKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
	isAdmin: (actor: string) => boolean;
	serviceToken: string;
	shellToken: string;
};

@Service()
export class FlowDeskSecretsService {
	constructor(private readonly deps: SecretsDeps) {}

	async readRunnerToken(): Promise<string> {
		return this.deps.readRunnerToken();
	}

	async saveCursorKey(opts: {
		key: string;
		actor: string;
		serviceToken: string;
	}): Promise<{ status: number; error?: string }> {
		if (opts.serviceToken !== this.deps.serviceToken) return { status: 401, error: 'unauthorized' };
		if (!this.deps.isAdmin(opts.actor)) return { status: 403, error: 'forbidden' };
		const result = await this.deps.forwardCursorKey(opts.key);
		if (!result.ok) return { status: 503, error: result.error ?? 'runner unavailable' };
		return { status: 200 };
	}

	isAdmin(actor: string) {
		return this.deps.isAdmin(actor);
	}

	get serviceToken() {
		return this.deps.serviceToken;
	}

	get shellToken() {
		return this.deps.shellToken;
	}
}
