export interface User {
  id: number;
  username: string;
  nickname?: string;
  avatar_url?: string;
  password_hash?: string;
  role: 'user' | 'admin';
  status: 'pending' | 'approved' | 'rejected';
  token_secret: string;
  created_at: string;
  updated_at: string;
}

export interface WorkSlot {
  start: string; // "09:00"
  end: string;   // "12:00"
}

export interface UserSettings {
  user_id: number;
  llm_endpoint: string;
  llm_api_key: string;
  llm_model: string;
  clawbot_webhook_token: string;
  clawbot_outbound_url: string;
  clawbot_outbound_key: string;
  clawbot_to_wxid: string;
  work_slots: string; // JSON array of WorkSlot
  task_buffer_minutes: number;
  reminder_before_start_minutes: number;
  reminder_before_end_minutes: number;
  calendar_sync_interval_minutes: number;
  advance_deadline_days?: number;
  weixin_connected?: number;
  weixin_bot_token?: string;
  weixin_bot_id?: string;
  weixin_user_id?: string;
  weixin_base_url?: string;
  weixin_sync_buf?: string;
  weixin_nickname?: string;
  weixin_context_token?: string;
  weixin_activated?: number;
  weixin_last_active_at?: string | null;
  updated_at: string;
}

export interface CalendarSubscription {
  id: number;
  user_id: number;
  name: string;
  url: string;
  last_sync_at: string | null;
  sync_status: 'ok' | 'error';
  error_message: string | null;
  created_at: string;
}

export interface ExternalEvent {
  id: number;
  user_id: number;
  subscription_id?: number | null;
  uid?: string | null;
  title: string;
  start_time: string; // ISO
  end_time: string;   // ISO
  is_all_day: number;
  created_at: string;
}

export interface Task {
  id: number;
  user_id: number;
  title: string;
  duration_minutes: number;
  original_duration_minutes?: number;
  urgency: number;    // 1 - 5
  importance: number; // 1 - 5
  deadline: string | null; // ISO
  scheduled_start: string | null; // ISO
  scheduled_end: string | null;   // ISO
  schedule_blocks?: string | null; // JSON array of scheduled focus blocks
  is_fixed?: number;        // 1 = 固定任务，不参与自动重排
  is_concurrent?: number;   // 1 = 双线程任务，可与其他任务或日程重叠
  status: 'pending_slot' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'delayed';
  notes?: string | null;
  start_reminder_sent: number;
  end_reminder_sent: number;
  created_at: string;
  updated_at: string;
}

export interface ConversationState {
  id: number;
  user_id: number;
  current_intent: string | null;
  pending_task_json: string | null;
  missing_fields: string | null;
  updated_at: string;
}

export interface LLMExtractionResult {
  intent: 'create_task' | 'status_update' | 'query_schedule' | 'delete_item' | 'modify_item' | 'other';
  title?: string | null;
  description?: string | null;
  duration_minutes?: number | null;
  urgency?: number | null; // 0.0 - 10.0
  importance?: number | null; // 0.0 - 10.0
  deadline?: string | null; // ISO 8601 string or YYYY-MM-DD
  dueDate?: string | null; // 对齐 oxoxox-oxox: YYYY-MM-DD
  estimatedMinutes?: number | null; // 对齐 oxoxox-oxox: 预计耗时分钟数
  tags?: string[] | null; // 标签列表
  is_fixed?: boolean | null; // 是否为指定时间的固定任务
  is_concurrent?: boolean | null; // 是否为双线程任务（允许重叠）
  fixed_start?: string | null; // 固定任务开始时间
  fixed_end?: string | null; // 固定任务结束时间
  allow_split?: boolean | null; // 是否允许拆分
  status_action?: 'complete' | 'complete_part' | 'extend' | 'reschedule' | 'cancel' | null;
  extend_minutes?: number | null;
  target_task_name?: string | null;
  completed_part_index?: number | null; // 完成的分段序号（如第1段）
  completed_minutes?: number | null; // 本次完成的耗时分钟数（如完成了2小时=120）
  delete_target?: {
    type?: 'task' | 'calendar_event' | 'auto';
    name?: string | null;
    date?: string | null;
  } | null;
  modify_target?: {
    type?: 'task' | 'calendar_event' | 'auto';
    name?: string | null;
    new_title?: string | null;
    new_duration_minutes?: number | null;
    new_deadline?: string | null;
    new_start?: string | null;
    new_end?: string | null;
    is_fixed?: boolean | null;
    is_concurrent?: boolean | null;
  } | null;
}

export interface ClawbotWebhookPayload {
  token?: string;
  fromUser?: string;
  toUser?: string;
  content: string;
  msgId?: string;
  msgType?: string;
  raw?: any;
}
