export type {DemandDraft,UatResult as UatRun,TaskSummary} from '../../../../shared/workbench';
export { json } from './http';

export interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  type: string;
  tags: string[];
  deprecated?: boolean;
}
