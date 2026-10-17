import { Column, Entity, PrimaryColumn } from '@n8n/typeorm';

@Entity({ name: 'flow_desk_ingest_cursor' })
export class FlowDeskCursorEntity {
	@PrimaryColumn()
	id: number;

	@Column({ type: 'bigint', default: 0 })
	lastEventId: string;
}
