import { contentDigest } from './project-config';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const relations = new Set([
	'duplicate',
	'relates_to',
	'blocked_by',
	'start_before',
	'finish_before',
	'implemented_by',
	'originated_from',
	'follow_up',
	'discovered_in',
]);
export function workItemOperations(
	project: string,
	runId: string,
	nodeId: string,
	params: Record<string, unknown>,
	items: unknown,
) {
	if (!Array.isArray(items)) throw new Error('Work item operations require a list');
	return items.map((item) => {
		if (!item || typeof item !== 'object' || Array.isArray(item))
			throw new Error('Invalid work item operation');
		const value = item as Record<string, unknown>,
			operation = String(params.operation);
		if (typeof value.id !== 'string' || !uuid.test(value.id))
			throw new Error('A work item identity is required');
		const allowed =
			operation === 'update'
				? ['id', 'title', 'stateGroup', 'labels', 'description']
				: ['id', 'targetId'];
		if (Object.keys(value).some((key) => !allowed.includes(key)))
			throw new Error('Unknown work item operation fields');
		const { id, ...fields } = value;
		if (operation === 'update') {
			if (!Object.keys(fields).length) throw new Error('No update fields');
			if (
				fields.title !== undefined &&
				(typeof fields.title !== 'string' || !fields.title.trim() || fields.title.length > 255)
			)
				throw new Error('Invalid work item title');
			if (
				fields.stateGroup !== undefined &&
				!['backlog', 'unstarted', 'started', 'completed', 'cancelled'].includes(
					String(fields.stateGroup),
				)
			)
				throw new Error('Invalid work item state');
			if (
				fields.description !== undefined &&
				(typeof fields.description !== 'string' || fields.description.length > 100000)
			)
				throw new Error('Invalid work item description');
			if (
				fields.labels !== undefined &&
				(!Array.isArray(fields.labels) ||
					fields.labels.length > 100 ||
					fields.labels.some(
						(label) => typeof label !== 'string' || !label.trim() || label.length > 80,
					))
			)
				throw new Error('Invalid work item labels');
		} else if (operation === 'link') {
			if (
				typeof fields.targetId !== 'string' ||
				!uuid.test(fields.targetId) ||
				fields.targetId === id
			)
				throw new Error('Invalid related work item');
			const relation = String(params.relation ?? '').replaceAll('-', '_');
			if (!relations.has(relation)) throw new Error('Invalid work item relation');
			fields.relation = relation;
		} else throw new Error('Unknown work item operation');
		return {
			route: `/issues/${id}/`,
			body: {
				...fields,
				operation,
				project,
				sourceKey: `${runId}:${nodeId}:${id}:${contentDigest({ operation, fields })}`,
			},
		};
	});
}
