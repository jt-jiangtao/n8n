import { WithTimestampsAndStringId } from '@n8n/db';
import { Column, Entity, Index } from '@n8n/typeorm';

@Entity({ name: 'flow_desk_commits' })
export class FlowDeskCommitEntity extends WithTimestampsAndStringId {
	@Index({ unique: true })
	@Column()
	sha: string;

	@Column()
	workItem: string;

	@Column()
	flowRunId: string;

	@Column()
	area: string;

	@Column()
	branch: string;

	@Column({ type: 'text', nullable: true })
	message: string | null;
}
