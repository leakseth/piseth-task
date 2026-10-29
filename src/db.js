import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Configure PostgreSQL connection (seamless support for Neon, Supabase, local, etc.)
const isSslRequired =
  process.env.DB_SSL === 'true' ||
  Boolean(process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('sslmode=require') || process.env.DATABASE_URL.includes('neon.tech')));

const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: isSslRequired ? { rejectUnauthorized: false } : false,
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'personal_tasks',
    };

export const pool = new Pool(poolConfig);

// Initialize database schema (runs on startup)
export async function initDb() {
  const createTableQuery = `
    -- 1. Tasks Table
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      task_name TEXT NOT NULL,
      reminder_time VARCHAR(5) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      is_completed BOOLEAN NOT NULL DEFAULT FALSE,
      is_notified BOOLEAN NOT NULL DEFAULT FALSE,
      is_recurring BOOLEAN NOT NULL DEFAULT FALSE,
      last_notified_date DATE DEFAULT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    -- Schema migrations for tasks table
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'PENDING';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_notified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_completed BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_notified_date DATE DEFAULT NULL;

    UPDATE tasks SET status = 'COMPLETED' WHERE is_completed = TRUE AND status = 'PENDING';

    CREATE INDEX IF NOT EXISTS idx_tasks_chat_id ON tasks(chat_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_reminder_time ON tasks(reminder_time);
    CREATE INDEX IF NOT EXISTS idx_tasks_pending ON tasks(reminder_time, is_notified, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_recurring ON tasks(is_recurring, last_notified_date);

    -- 2. Weekly Class Schedules Table
    CREATE TABLE IF NOT EXISTS schedules (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      day_of_week VARCHAR(10) NOT NULL,
      time VARCHAR(5) NOT NULL,
      subject TEXT NOT NULL,
      room TEXT DEFAULT 'N/A',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_chat_day ON schedules(chat_id, day_of_week);
    CREATE INDEX IF NOT EXISTS idx_schedules_day ON schedules(day_of_week);
  `;

  try {
    const client = await pool.connect();
    try {
      await client.query(createTableQuery);
      console.log('✅ PostgreSQL connected and all database schemas (tasks & schedules) verified successfully.');
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('❌ Failed to connect to PostgreSQL or initialize database schema:', error.message);
    throw error;
  }
}

// -------------------------------------------------------------
// Tasks Database Operations
// -------------------------------------------------------------

// Create a new task (with optional recurring daily support)
export async function createTask(chatId, taskName, reminderTime, isRecurring = false) {
  const query = `
    INSERT INTO tasks (chat_id, task_name, reminder_time, status, is_recurring)
    VALUES ($1, $2, $3, 'PENDING', $4)
    RETURNING id, chat_id, task_name, reminder_time, status, is_notified, is_recurring, created_at;
  `;
  const values = [chatId, taskName, reminderTime, isRecurring];
  const { rows } = await pool.query(query, values);
  return rows[0];
}

// Fetch all tasks for a specific user chat
export async function getTasksByChatId(chatId) {
  const query = `
    SELECT id, chat_id, task_name, reminder_time, status, is_notified, is_recurring, created_at
    FROM tasks
    WHERE chat_id = $1
    ORDER BY CASE WHEN status = 'PENDING' THEN 1 ELSE 2 END, reminder_time ASC, id ASC;
  `;
  const { rows } = await pool.query(query, [chatId]);
  return rows;
}

// Fetch due reminders (handles one-time vs recurring daily tasks)
export async function getPendingReminders(currentTime) {
  const query = `
    SELECT id, chat_id, task_name, reminder_time, status, is_recurring
    FROM tasks
    WHERE reminder_time <= $1 
      AND (
        (is_recurring = FALSE AND is_notified = FALSE AND status = 'PENDING')
        OR
        (is_recurring = TRUE AND (last_notified_date IS NULL OR last_notified_date < CURRENT_DATE))
      )
    ORDER BY reminder_time ASC;
  `;
  const { rows } = await pool.query(query, [currentTime]);
  return rows;
}

// Mark a task as notified (records today's date for recurring tasks)
export async function markTaskAsNotified(taskId) {
  const query = `
    UPDATE tasks
    SET is_notified = TRUE,
        last_notified_date = CURRENT_DATE
    WHERE id = $1
    RETURNING id, chat_id, task_name, reminder_time, status, is_notified, is_recurring, last_notified_date;
  `;
  const { rows } = await pool.query(query, [taskId]);
  return rows[0];
}

// Mark a task as completed (updates status to 'COMPLETED')
export async function markTaskAsCompleted(taskId, chatId) {
  const query = `
    UPDATE tasks
    SET status = 'COMPLETED', is_completed = TRUE
    WHERE id = $1 AND ($2::BIGINT IS NULL OR chat_id = $2::BIGINT)
    RETURNING id, chat_id, task_name, reminder_time, status, is_recurring;
  `;
  const { rows } = await pool.query(query, [taskId, chatId || null]);
  return rows[0];
}

// Delete a specific task by its ID and chatId
export async function deleteTask(taskId, chatId) {
  const query = `
    DELETE FROM tasks
    WHERE id = $1 AND chat_id = $2
    RETURNING id, task_name;
  `;
  const { rows } = await pool.query(query, [taskId, chatId]);
  return rows[0];
}

// Reset recurring tasks at midnight
export async function resetRecurringTasksForNewDay() {
  const query = `
    UPDATE tasks
    SET is_notified = FALSE,
        status = 'PENDING',
        is_completed = FALSE
    WHERE is_recurring = TRUE
    RETURNING id, task_name;
  `;
  const { rows } = await pool.query(query);
  return rows;
}

// Get all pending tasks grouped for Morning Briefing
export async function getAllPendingTasksGroupedByChat() {
  const query = `
    SELECT chat_id, id, task_name, reminder_time, is_recurring
    FROM tasks
    WHERE status = 'PENDING'
    ORDER BY chat_id, reminder_time ASC, id ASC;
  `;
  const { rows } = await pool.query(query);

  const grouped = {};
  for (const task of rows) {
    if (!grouped[task.chat_id]) {
      grouped[task.chat_id] = [];
    }
    grouped[task.chat_id].push(task);
  }
  return grouped;
}

// -------------------------------------------------------------
// Weekly Class Schedules Database Operations
// -------------------------------------------------------------

// 1. Insert a new class into the weekly schedule
export async function createSchedule(chatId, dayOfWeek, time, subject, room = 'N/A') {
  const query = `
    INSERT INTO schedules (chat_id, day_of_week, time, subject, room)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, chat_id, day_of_week, time, subject, room, created_at;
  `;
  const values = [chatId, dayOfWeek, time, subject, room];
  const { rows } = await pool.query(query, values);
  return rows[0];
}

// 2. Fetch full weekly schedule for a specific user, sorted Monday through Sunday and by time
export async function getSchedulesByChatId(chatId) {
  const query = `
    SELECT id, chat_id, day_of_week, time, subject, room, created_at
    FROM schedules
    WHERE chat_id = $1
    ORDER BY 
      CASE day_of_week
        WHEN 'MON' THEN 1
        WHEN 'TUE' THEN 2
        WHEN 'WED' THEN 3
        WHEN 'THU' THEN 4
        WHEN 'FRI' THEN 5
        WHEN 'SAT' THEN 6
        WHEN 'SUN' THEN 7
        ELSE 8
      END,
      time ASC,
      id ASC;
  `;
  const { rows } = await pool.query(query, [chatId]);
  return rows;
}

// 3. Delete a class schedule by ID and chatId
export async function deleteSchedule(scheduleId, chatId) {
  const query = `
    DELETE FROM schedules
    WHERE id = $1 AND chat_id = $2
    RETURNING id, subject, day_of_week, time;
  `;
  const { rows } = await pool.query(query, [scheduleId, chatId]);
  return rows[0];
}

// 4. Fetch all classes for today across all users for morning schedule alerts
export async function getAllTodaySchedulesGroupedByChat(dayOfWeek) {
  const query = `
    SELECT chat_id, id, day_of_week, time, subject, room
    FROM schedules
    WHERE day_of_week = $1
    ORDER BY chat_id, time ASC, id ASC;
  `;
  const { rows } = await pool.query(query, [dayOfWeek]);

  const grouped = {};
  for (const item of rows) {
    if (!grouped[item.chat_id]) {
      grouped[item.chat_id] = [];
    }
    grouped[item.chat_id].push(item);
  }
  return grouped;
}

// 5. Fetch classes for a specific user on a specific day of the week (e.g. for /today)
export async function getTodaySchedulesByChatId(chatId, dayOfWeek) {
  const query = `
    SELECT id, chat_id, day_of_week, time, subject, room, created_at
    FROM schedules
    WHERE chat_id = $1 AND day_of_week = $2
    ORDER BY time ASC, id ASC;
  `;
  const { rows } = await pool.query(query, [chatId, dayOfWeek]);
  return rows;
}
