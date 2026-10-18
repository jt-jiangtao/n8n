/** M76, M147 — settings + cursor credentials */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowDeskConfigService } from '../config/config.service';
import { FlowDeskSettingsService } from '../settings/settings.service';

describe('flow-desk settings (M76, M147)', () => {
	let config: FlowDeskConfigService;
	let writeConfigFile: ReturnType<typeof vi.fn>;
	let requestCommit: ReturnType<typeof vi.fn>;
	let forwardCursorKey: ReturnType<typeof vi.fn>;
	let hasCursorKey: ReturnType<typeof vi.fn>;
	let settings: FlowDeskSettingsService;

	beforeEach(() => {
		config = new FlowDeskConfigService({
			areas: {
				web: {
					plane: { project: 'WEB' },
					repo: '/tmp/web',
					baseRef: 'main',
					suites: { targeted: 'pnpm test' },
					roles: { owner: ['alice'] },
					mergeMethod: 'squash',
					agent: { adapter: 'fake' },
				},
			},
			groups: { admins: ['admin-1'] },
			guards: { protectedPaths: [] },
			provenance: { escapeWindowDays: 30 },
			desktop: { stopPlaneOnQuit: false, launchAtLogin: true, hostAddress: 'h' },
		});
		writeConfigFile = vi.fn(async () => undefined);
		requestCommit = vi.fn(async () => undefined);
		forwardCursorKey = vi.fn(async () => ({ ok: true }));
		hasCursorKey = vi.fn(async () => true);
		settings = new FlowDeskSettingsService({
			config,
			isAdmin: (a) => a === 'admin-1',
			writeConfigFile,
			requestCommit,
			forwardCursorKey,
			hasCursorKey,
		});
	});

	it('M76: valid settings write+reload+commit; invalid returns position', async () => {
		const ok = await settings.putSettings({
			actor: 'admin-1',
			raw: JSON.stringify({
				areas: {
					web: {
						plane: { project: 'WEB' },
						repo: '/tmp/web',
						baseRef: 'main',
						suites: {},
						roles: {},
						mergeMethod: 'squash',
						agent: { adapter: 'fake' },
					},
				},
				groups: {},
				guards: { protectedPaths: [] },
				provenance: { escapeWindowDays: 30 },
				desktop: { stopPlaneOnQuit: false, launchAtLogin: true, hostAddress: 'h' },
			}),
		});
		expect(ok).toEqual({ ok: true });
		expect(writeConfigFile).toHaveBeenCalled();
		expect(requestCommit).toHaveBeenCalled();

		const bad = await settings.putSettings({ actor: 'admin-1', raw: 'areas: []' });
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.position).toBeTruthy();
		expect(writeConfigFile).toHaveBeenCalledTimes(1);
	});

	it('M147: cursor key forwarded only; get returns set; runner down fails', async () => {
		const put = await settings.putCursorKey({ actor: 'admin-1', key: 'sk-secret' });
		expect(put).toEqual({ ok: true });
		expect(forwardCursorKey).toHaveBeenCalledWith('sk-secret');
		expect(settings.getDebugLogs().join(' ')).not.toContain('sk-secret');

		const got = await settings.getCursorKey({ actor: 'admin-1' });
		expect(got).toEqual({ ok: true, set: true });

		forwardCursorKey.mockResolvedValueOnce({ ok: false, error: 'runner down' });
		const fail = await settings.putCursorKey({ actor: 'admin-1', key: 'sk-2' });
		expect(fail.ok).toBe(false);
		if (!fail.ok) expect(fail.status).toBe(503);
	});
});
