import { WithTimestampsAndStringId } from '@n8n/db';
import { Column, Entity, Index } from '@n8n/typeorm';

@Entity({ name: 'flow_desk_steps' })
@Index(['executionId', 'nodeId'], { unique: true })
export class FlowDeskStepEntity extends WithTimestampsAndStringId {
	@Column()
	executionId: string;

	@Column()
	nodeId: string;

	@Column()
	nodeType: string;

	@Column({ nullable: true })
	childIssueId: string | null;

	@Column({ default: 1 })
	attempt: number;

	@Column({ default: 'waiting' })
	status: string;

	@Column({ nullable: true })
	taskId: string | null;
}
