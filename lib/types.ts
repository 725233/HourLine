export type Role = 'manager' | 'worker';
export type TaskStatus =
  | 'needs_estimate' | 'estimate_submitted' | 'todo' | 'in_progress' | 'blocked'
  | 'submitted' | 'changes_requested' | 'completed' | 'cancelled';
export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export type EntryStatus = 'pending' | 'approved' | 'rejected';

export interface Profile { id: string; email: string; full_name: string; title: string; role: Role; active: boolean; created_at: string }
export interface Settings { org_name: string; timezone: string; long_session_hours: number; max_entry_hours: number; warn_ratio: number; max_file_bytes: number }
export interface Project { id: string; name: string; kind: string; archived: boolean }
export interface Task {
  id: number; project_id: string; title: string; description: string; deliverable: string; criteria: string[];
  assignee_id: string; priority: Priority; deadline: string | null; est_hours: number; max_hours: number;
  status: TaskStatus; blocker_text: string | null; blocker_by: string | null; blocker_at: string | null;
  created_at: string; updated_at: string;
}
export interface Hours { task_id: number; logged: number; approved: number; pending: number; running: number; running_since: string | null; running_worker: string | null }
export interface Entry {
  id: number; task_id: number; worker_id: string; started_at: string; ended_at: string; summary: string;
  kind: 'timer' | 'manual' | 'correction'; reason: string; status: EntryStatus; rate: number; currency: string;
  flagged: boolean; flag_reason: string; auto_stopped: boolean; needs_summary: boolean; corrects_id: number | null;
  superseded_by: number | null; payment_id: number | null; decided_by: string | null; decided_at: string | null;
  decision_note: string; created_at: string;
}
export interface Estimate { id: number; task_id: number; worker_id: string; hours: number; notes: string; status: 'submitted' | 'approved' | 'revise'; approved_hours: number | null; decided_by: string | null; decided_at: string | null; note: string; created_at: string }
export interface HourRequest { id: number; task_id: number; worker_id: string; hours: number; reason: string; status: 'pending' | 'approved' | 'rejected'; decided_by: string | null; decided_at: string | null; note: string; created_at: string }
export interface Submission { id: number; task_id: number; worker_id: string; summary: string; links: { label: string; url: string }[]; criteria: { text: string; checked: boolean }[]; decision: 'approved' | 'changes' | null; decided_by: string | null; decided_at: string | null; comment: string; created_at: string }
export interface Comment { id: number; task_id: number; author_id: string; parent_id: number | null; kind: 'comment' | 'question' | 'note'; body: string; q_status: 'open' | 'resolved' | null; resolved_by: string | null; resolved_at: string | null; created_at: string }
export interface Attachment { id: number; task_id: number; comment_id: number | null; submission_id: number | null; kind: 'file' | 'link'; name: string; size_bytes: number | null; mime: string | null; storage_path: string | null; url: string | null; uploaded_by: string; created_at: string }
export interface Payment { id: number; worker_id: string; currency: string; period_start: string; period_end: string; hours: number; amount: number; status: 'paid' | 'unpaid'; paid_at: string | null; paid_by: string | null; created_at: string }
export interface Rate { id: number; worker_id: string; rate: number; currency: string; effective_from: string }
export interface Notice { id: number; user_id: string; body: string; task_id: number | null; read: boolean; created_at: string }
export interface Activity { id: number; actor_id: string | null; task_id: number | null; body: string; created_at: string }
export interface Timer { worker_id: string; task_id: number; started_at: string }
