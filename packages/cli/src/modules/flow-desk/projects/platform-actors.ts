import type { ProjectRecords } from '../database/project-record.repository';
export async function platformActors(records: ProjectRecords, refs: string[]) {
	if (!refs.includes('me')) return refs;
	const owner = await records.read<{ actor: string }>('platform:desktop-owner');
	return [...new Set(refs.flatMap((id) => (id === 'me' ? (owner ? [owner.actor] : []) : [id])))];
}
