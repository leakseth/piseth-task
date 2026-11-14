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

// Handle idle client errors on serverless PostgreSQL (e.g. Neon drops idle sockets)
pool.on('error', (err) => {
  console.warn('⚠️ PostgreSQL pool idle client warning (handled):', err.message);
});

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

    -- 3. Expenses & Budget Tracker Table
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      amount NUMERIC(12, 2) NOT NULL,
      currency VARCHAR(5) NOT NULL DEFAULT 'USD',
      amount_usd NUMERIC(12, 2) NOT NULL,
      category VARCHAR(50) NOT NULL DEFAULT 'General',
      note TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_expenses_chat_created ON expenses(chat_id, created_at);

    -- 4. Exam & Project Deadlines Countdown Table
    CREATE TABLE IF NOT EXISTS deadlines (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      title TEXT NOT NULL,
      deadline_date DATE NOT NULL,
      is_notified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_deadlines_chat_date ON deadlines(chat_id, deadline_date);
    CREATE INDEX IF NOT EXISTS idx_deadlines_alert ON deadlines(deadline_date, is_notified);

    -- 5. Quick Notes & Code Snippets Vault Table
    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_notes_chat_id ON notes(chat_id);
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

// 6. Fetch classes matching a specific day and exact time (e.g. for 15-minute pre-class alerts)
export async function getClassesByDayAndTime(dayOfWeek, time) {
  const query = `
    SELECT id, chat_id, day_of_week, time, subject, room, created_at
    FROM schedules
    WHERE day_of_week = $1 AND time = $2
    ORDER BY chat_id, id ASC;
  `;
  const { rows } = await pool.query(query, [dayOfWeek, time]);
  return rows;
}

// 7. Snooze a task to a new reminder time
export async function snoozeTask(taskId, chatId, newReminderTime) {
  const query = `
    UPDATE tasks
    SET reminder_time = $1, is_notified = FALSE, status = 'PENDING'
    WHERE id = $2 AND chat_id = $3
    RETURNING id, chat_id, task_name, reminder_time, status, is_completed, is_notified, is_recurring;
  `;
  const { rows } = await pool.query(query, [newReminderTime, taskId, chatId]);
  return rows[0];
}

// 8. Fetch comprehensive productivity & study statistics for a user
export async function getUserStats(chatId) {
  const taskQuery = `
    SELECT 
      COUNT(*) AS total_tasks,
      COUNT(*) FILTER (WHERE is_completed = TRUE OR status = 'COMPLETED') AS completed_tasks,
      COUNT(*) FILTER (WHERE is_completed = FALSE AND status = 'PENDING') AS pending_tasks,
      COUNT(*) FILTER (WHERE is_recurring = TRUE) AS recurring_tasks,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS tasks_last_7_days,
      COUNT(*) FILTER (WHERE (is_completed = TRUE OR status = 'COMPLETED') AND created_at >= NOW() - INTERVAL '7 days') AS completed_last_7_days
    FROM tasks
    WHERE chat_id = $1;
  `;

  const scheduleQuery = `
    SELECT COUNT(*) AS total_classes
    FROM schedules
    WHERE chat_id = $1;
  `;

  const [taskRes, scheduleRes] = await Promise.all([
    pool.query(taskQuery, [chatId]),
    pool.query(scheduleQuery, [chatId]),
  ]);

  const t = taskRes.rows[0] || {};
  return {
    total_tasks: parseInt(t.total_tasks || '0', 10),
    completed_tasks: parseInt(t.completed_tasks || '0', 10),
    pending_tasks: parseInt(t.pending_tasks || '0', 10),
    recurring_tasks: parseInt(t.recurring_tasks || '0', 10),
    tasks_last_7_days: parseInt(t.tasks_last_7_days || '0', 10),
    completed_last_7_days: parseInt(t.completed_last_7_days || '0', 10),
    total_classes: parseInt(scheduleRes.rows[0]?.total_classes || '0', 10),
  };
}

// -------------------------------------------------------------
// Expenses & Budget Tracker Database Operations
// -------------------------------------------------------------

// 1. Log a new expense
export async function createExpense(chatId, amount, currency, amountUsd, category, note) {
  const query = `
    INSERT INTO expenses (chat_id, amount, currency, amount_usd, category, note)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, chat_id, amount, currency, amount_usd, category, note, created_at;
  `;
  const values = [chatId, amount, currency, amountUsd, category, note];
  const { rows } = await pool.query(query, values);
  return rows[0];
}

// 2. Fetch financial summary (Today, This Month, and Category breakdown)
export async function getExpensesSummary(chatId) {
  const query = `
    SELECT 
      COALESCE(SUM(amount_usd) FILTER (WHERE created_at >= CURRENT_DATE), 0) AS today_spent_usd,
      COALESCE(SUM(amount_usd) FILTER (WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE)), 0) AS month_spent_usd,
      COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS today_count,
      COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE)) AS month_count
    FROM expenses
    WHERE chat_id = $1;
  `;

  const categoryQuery = `
    SELECT category, COALESCE(SUM(amount_usd), 0) AS total_usd, COUNT(*) AS count
    FROM expenses
    WHERE chat_id = $1 AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
    GROUP BY category
    ORDER BY total_usd DESC
    LIMIT 5;
  `;

  const [summaryRes, categoryRes] = await Promise.all([
    pool.query(query, [chatId]),
    pool.query(categoryQuery, [chatId]),
  ]);

  const s = summaryRes.rows[0] || {};
  return {
    today_spent_usd: parseFloat(s.today_spent_usd || 0),
    month_spent_usd: parseFloat(s.month_spent_usd || 0),
    today_count: parseInt(s.today_count || 0, 10),
    month_count: parseInt(s.month_count || 0, 10),
    categories: categoryRes.rows.map((r) => ({
      category: r.category,
      total_usd: parseFloat(r.total_usd),
      count: parseInt(r.count, 10),
    })),
  };
}

// 3. Get recent expenses list
export async function getRecentExpenses(chatId, limit = 8) {
  const query = `
    SELECT id, amount, currency, amount_usd, category, note, created_at
    FROM expenses
    WHERE chat_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT $2;
  `;
  const { rows } = await pool.query(query, [chatId, limit]);
  return rows;
}

// 4. Delete an expense by ID
export async function deleteExpense(expenseId, chatId) {
  const query = `
    DELETE FROM expenses
    WHERE id = $1 AND chat_id = $2
    RETURNING id, amount, currency, note;
  `;
  const { rows } = await pool.query(query, [expenseId, chatId]);
  return rows[0];
}

// -------------------------------------------------------------
// Exam & Project Deadlines Countdown Database Operations
// -------------------------------------------------------------

// 1. Create a new deadline
export async function createDeadline(chatId, title, deadlineDate) {
  const query = `
    INSERT INTO deadlines (chat_id, title, deadline_date)
    VALUES ($1, $2, $3)
    RETURNING id, chat_id, title, deadline_date, created_at;
  `;
  const { rows } = await pool.query(query, [chatId, title, deadlineDate]);
  return rows[0];
}

// 2. Fetch all upcoming deadlines for a user, sorted nearest to furthest
export async function getActiveDeadlines(chatId) {
  const query = `
    SELECT 
      id, chat_id, title, deadline_date,
      (deadline_date - CURRENT_DATE) AS days_remaining
    FROM deadlines
    WHERE chat_id = $1 AND deadline_date >= CURRENT_DATE
    ORDER BY deadline_date ASC, id ASC;
  `;
  const { rows } = await pool.query(query, [chatId]);
  return rows;
}

// 3. Fetch deadlines due in exactly N days across all users (e.g. 1 day notice)
export async function getUpcomingDeadlinesAcrossUsers(daysNotice = 1) {
  const query = `
    SELECT id, chat_id, title, deadline_date
    FROM deadlines
    WHERE (deadline_date - CURRENT_DATE) = $1;
  `;
  const { rows } = await pool.query(query, [daysNotice]);
  return rows;
}

// 4. Delete a deadline by ID
export async function deleteDeadline(deadlineId, chatId) {
  const query = `
    DELETE FROM deadlines
    WHERE id = $1 AND chat_id = $2
    RETURNING id, title, deadline_date;
  `;
  const { rows } = await pool.query(query, [deadlineId, chatId]);
  return rows[0];
}

// -------------------------------------------------------------
// Quick Notes & Code Snippets Vault Database Operations
// -------------------------------------------------------------

// 1. Create a new note
export async function createNote(chatId, title, content) {
  const query = `
    INSERT INTO notes (chat_id, title, content)
    VALUES ($1, $2, $3)
    RETURNING id, chat_id, title, content, created_at;
  `;
  const { rows } = await pool.query(query, [chatId, title, content]);
  return rows[0];
}

// 2. Fetch all notes for a user
export async function getNotesByChatId(chatId, limit = 20) {
  const query = `
    SELECT id, title, content, created_at
    FROM notes
    WHERE chat_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT $2;
  `;
  const { rows } = await pool.query(query, [chatId, limit]);
  return rows;
}

// 3. Search notes by title or content keyword
export async function searchNotes(chatId, keyword) {
  const query = `
    SELECT id, title, content, created_at
    FROM notes
    WHERE chat_id = $1 AND (title ILIKE $2 OR content ILIKE $2)
    ORDER BY created_at DESC
    LIMIT 10;
  `;
  const { rows } = await pool.query(query, [chatId, `%${keyword}%`]);
  return rows;
}

// 4. Delete a note by ID
export async function deleteNote(noteId, chatId) {
  const query = `
    DELETE FROM notes
    WHERE id = $1 AND chat_id = $2
    RETURNING id, title;
  `;
  const { rows } = await pool.query(query, [noteId, chatId]);
  return rows[0];
}
