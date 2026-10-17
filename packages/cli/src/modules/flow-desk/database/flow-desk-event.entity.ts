import { WithTimestampsAndStringId } from '@n8n/db';
import { Column, Entity, Index } from '@n8n/typeorm';

@Entity({ name: 'flow_desk_events' })
export class FlowDeskEventEntity extends WithTimestampsAndStringId {
	@Index({ unique: true })
	@Column()
	dedupeKey: string;

	@Column({ type: 'bigint' })
	eventId: string;

	@Column()
	kind: string;

	@Column()
	issueId: string;

	@Column({ type: 'json' })
	payload: Record<string, unknown>;
}
