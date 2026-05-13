export interface Env {
  DB: D1Database;
  TG_OWNER_ID: string;
  DEFAULT_TIMEZONE: string;
  GEMINI_MODEL: string;
  TELEGRAM_BOT_TOKEN: string;
  GEMINI_API_KEY: string;
  GROQ_API_KEY?: string;
  WORKER_BASE_URL: string;
}

export type SubStatus = 'owner' | 'granted' | 'trial' | 'active' | 'expired';

export interface UserRow {
  id: number;
  first_name: string | null;
  username: string | null;
  timezone: string;
  profile_json: string;
  created_at: number;
  updated_at: number;
  sub_status: SubStatus;
  sub_until: number | null;
  sub_started_at: number;
}

export interface Goal {
  id: number;
  user_id: number;
  title: string;
  description: string | null;
  horizon: 'year' | 'quarter' | 'month' | 'week';
  target_date: string | null;
  status: 'active' | 'done' | 'dropped' | 'paused';
  progress: number;
  created_at: number;
  updated_at: number;
}

export interface Habit {
  id: number;
  user_id: number;
  name: string;
  description: string | null;
  frequency: string;
  target_per_week: number;
  status: 'active' | 'archived';
  created_at: number;
}

export interface Reminder {
  id: number;
  user_id: number;
  text: string;
  fire_at: number;
  repeat_rule: string | null;
  fired_at: number | null;
  status: 'pending' | 'done' | 'cancelled';
  created_at: number;
}

export interface Task {
  id: number;
  user_id: number;
  title: string;
  scope: 'daily' | 'weekly' | 'someday';
  due_date: string | null;
  status: 'pending' | 'done' | 'cancelled';
  done_at: number | null;
  sort_order: number;
  created_at: number;
}

export interface Exercise {
  id: number;
  user_id: number;
  date: string;
  name: string;
  reps: number;
  step: number;
  sort_order: number;
  created_at: number;
}

export interface ActionReminder {
  id: number;
  user_id: number;
  trigger_text: string;
  message: string;
  status: 'active' | 'fired' | 'cancelled';
  fired_at: number | null;
  created_at: number;
}

export interface Memory {
  id: number;
  user_id: number;
  category: string;
  content: string;
  created_at: number;
}

export interface Message {
  id: number;
  user_id: number;
  role: 'user' | 'model' | 'system' | 'tool';
  content: string;
  created_at: number;
}
