import { it, expect, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Request, Response } from 'express';
import { ProjectController } from '../project.controller';
import type { ProjectRuntimeService } from '../project-runtime.service';
vi.mock('../project-runtime.service', () => ({ ProjectRuntimeService: class {} }));
it('derives the decision actor from the human session and ignores a forged body actor', async () => {
	const decide = vi.fn(async () => ({ status: 'passed' }));
	const controller = new ProjectController({
		runtime: { decide },
	} as unknown as ProjectRuntimeService);
	const res = mock<Response>();
	res.json.mockReturnValue(res);
	const req = {
		user: { id: 'human', disabled: false },
		body: { actor: 'owner', digest: 'hash', decision: 'approve' },
	} as unknown as Request;
	await controller.decide(req, res, 'run', 'node');
	expect(decide).toHaveBeenCalledWith('run', 'node', {
		actor: 'human',
		digest: 'hash',
		decision: 'approve',
	});
	await expect(
		controller.decide({ body: { actor: 'owner' } } as Request, res, 'run', 'node'),
	).rejects.toThrow('Authenticated human');
});
