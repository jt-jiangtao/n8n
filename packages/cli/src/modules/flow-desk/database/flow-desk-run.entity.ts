import { WithTimestampsAndStringId } from '@n8n/db';
import { Column, Entity, Index } from '@n8n/typeorm';

@Entity({ name: 'flow_desk_runs' })
export class FlowDeskRunEntity extends WithTimestampsAndStringId {
	@Index({ unique: true })
	@Column()
	parentIssueId: string;

	@Column()
	flowType: string;

	@Column({ nullable: true })
	executionId: string | null;

	@Column({ default: 'running' })
	status: string;

	@Column({ type: 'json', nullable: true })
	snapshot: Record<string, unknown> | null;
}
