import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';
@Entity({ name: 'flow_desk_project_records' })
export class ProjectRecordEntity extends BaseEntity {
	@PrimaryColumn({ type: 'varchar', length: 255 }) id: string;
	@Column({ type: 'text' }) payload: string;
	@Column({ type: 'int', default: 1 }) revision: number;
}
