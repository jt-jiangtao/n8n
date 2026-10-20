import { Service } from '@n8n/di';
import { DataSource, Repository, Like } from '@n8n/typeorm';
import { ProjectRecordEntity } from './project-record.entity';
export interface ProjectRecords {
	read<T>(key: string): Promise<T | null>;
	write(key: string, value: unknown): Promise<void>;
}
@Service()
export class ProjectRecordRepository
	extends Repository<ProjectRecordEntity>
	implements ProjectRecords
{
	constructor(dataSource: DataSource) {
		super(ProjectRecordEntity, dataSource.manager);
	}
	async read<T>(key: string): Promise<T | null> {
		const row = await this.findOneBy({ id: key });
		return row ? (JSON.parse(row.payload) as T) : null;
	}
	async write(key: string, value: unknown): Promise<void> {
		for (let i = 0; i < 8; i++) {
			const row = await this.findOneBy({ id: key });
			if (row) {
				const result = await this.update(
					{ id: key, revision: row.revision },
					{ payload: JSON.stringify(value), revision: row.revision + 1 },
				);
				if (result.affected) return;
			} else {
				try {
					await this.insert({ id: key, payload: JSON.stringify(value), revision: 1 });
					return;
				} catch (error) {
					if (!(await this.findOneBy({ id: key }))) throw error;
				}
			}
		}
		throw new Error('Concurrent project record update');
	}
	async list<T>(prefix: string): Promise<T[]> {
		const rows = await this.findBy({ id: Like(prefix + '%') });
		return rows.map((row) => JSON.parse(row.payload) as T);
	}

	async claim(key: string, value: unknown): Promise<boolean> {
		try {
			await this.insert({ id: key, payload: JSON.stringify(value), revision: 1 });
			return true;
		} catch (error) {
			if (await this.findOneBy({ id: key })) return false;
			throw error;
		}
	}
}
