import type {MigrationContext,ReversibleMigration} from '../migration-types';
export class CreateFlowDeskProjectRecords1792500000000 implements ReversibleMigration {
 async up({schemaBuilder:{createTable,column}}:MigrationContext){
  await createTable('flow_desk_project_records').withColumns(column('id').varchar(255).primary.notNull,column('payload').text.notNull,column('revision').int.notNull.default(1));
 }
 async down({schemaBuilder:{dropTable}}:MigrationContext){await dropTable('flow_desk_project_records');}
}
