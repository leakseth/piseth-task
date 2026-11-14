import cron from 'node-cron';
import { Markup } from 'telegraf';
import {
  getPendingReminders,
  markTaskAsNotified,
  getAllPendingTasksGroupedByChat,
  resetRecurringTasksForNewDay,
  getAllTodaySchedulesGroupedByChat,
  getClassesByDayAndTime,
  getUpcomingDeadlinesAcrossUsers,
} from './db.js';
import { getPhnomPenhWeather } from './weather.js';

// Resolve timezone from .env or default to Asia/Phnom_Penh
export const TIMEZONE = process.env.TIMEZONE || 'Asia/Phnom_Penh';

// Helper: convert 24h HH:mm to friendly 12h format (e.g. 17:30 -> 5:30 PM)
export function formatTo12Hour(time24) {
  const [h, m] = time24.split(':').map((v) => parseInt(v, 10));
  const period = h >= 12 ? 'PM' : 'AM';
  const hours12 = h % 12 || 12;
  return `${hours12}:${String(m).padStart(2, '0')} ${period}`;
}

// Helper: Get time offset by N minutes in 24h HH:mm format (e.g. for +15m class alerts or snooze)
export function getTimePlusMinutes(minutesToAdd = 15, tz = TIMEZONE) {
  try {
    const now = new Date();
    const future = new Date(now.getTime() + minutesToAdd * 60 * 1000);
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return formatter.format(future);
  } catch (err) {
    const now = new Date();
    const future = new Date(now.getTime() + minutesToAdd * 60 * 1000);
    const h = String(future.getHours()).padStart(2, '0');
    const m = String(future.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }
}

// In-memory set to prevent duplicate 15-minute class alerts on the same day
const notifiedClassAlerts = new Set();

// Helper: Get current time formatted as 24h HH:mm in the target timezone
export function getCurrentTimeString(tz = TIMEZONE) {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return formatter.format(new Date());
  } catch (error) {
    console.warn(`⚠️ Warning: Invalid timezone "${tz}", falling back to system/UTC.`);
    const fallbackFormatter = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return fallbackFormatter.format(new Date());
  }
}

// Helper: Get today's 3-letter day abbreviation (e.g. MON, TUE, WED, THU, FRI)
export function getCurrentDayOfWeek(tz = TIMEZONE) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
    });
    return formatter.format(new Date()).toUpperCase();
  } catch {
    const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    return days[new Date().getDay()];
  }
}

// Helper: Get localized day name
export function getDayName(dayKey) {
  const map = {
    MON: 'Monday (ច័ន្ទ)',
    TUE: 'Tuesday (អង្គារ)',
    WED: 'Wednesday (ពុធ)',
    THU: 'Thursday (ព្រហស្បតិ៍)',
    FRI: 'Friday (សុក្រ)',
    SAT: 'Saturday (សៅរ៍)',
    SUN: 'Sunday (អាទិត្យ)',
  };
  return map[dayKey] || dayKey;
}

// Helper: Resilient retry wrapper for network operations
async function sendWithRetry(operation, maxRetries = 3, delayMs = 1500) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const isTransientNetworkError =
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNREFUSED' ||
        (error.message && error.message.includes('ECONNRESET')) ||
        (error.type === 'system');

      if (isTransientNetworkError && attempt < maxRetries) {
        console.warn(`⚠️ Network hiccup (${error.code || error.message}). Retrying in ${delayMs / 1000}s (Attempt ${attempt}/${maxRetries})...`);
        await new Promise((res) => setTimeout(res, delayMs));
      } else {
        throw error;
      }
    }
  }
  throw lastError;
}

/**
 * Initializes and starts all background cron workers:
 * 1. Minute-by-minute reminder check (* * * * *)
 * 2. Daily morning briefings & class schedule alerts at 7:00 AM (0 7 * * *)
 * 3. Daily recurring tasks reset at midnight (0 0 * * *)
 * 
 * @param {import('telegraf').Telegraf} bot - The Telegraf bot instance.
 */
export function startScheduler(bot) {
  console.log(`⏰ Reminder cron worker started (every minute). Timezone: "${TIMEZONE}".`);
  console.log(`🌅 Morning briefing & Class schedule alerts started (daily at 07:00 AM). Timezone: "${TIMEZONE}".`);
  console.log(`🔄 Daily recurring reset worker started (daily at 00:00 Midnight). Timezone: "${TIMEZONE}".`);

  // Job 1: Minute-by-Minute Task Reminder Worker
  const reminderJob = cron.schedule('* * * * *', async () => {
    const currentTime = getCurrentTimeString(TIMEZONE);

    try {
      const pendingTasks = await getPendingReminders(currentTime);

      if (pendingTasks.length > 0) {
        console.log(`[${currentTime}] 🔔 Found ${pendingTasks.length} pending reminder(s) to dispatch!`);

        for (const task of pendingTasks) {
          try {
            const recurringBadge = task.is_recurring ? `🔄 <b>Schedule:</b> Daily Recurring\n` : '';
            const recurringFooter = task.is_recurring 
              ? `\n<i>(This reminder will automatically trigger again tomorrow at ${task.reminder_time})</i>` 
              : `\n<i>Have you completed this task? Stay productive!</i> 💪`;

            const reminderMessage = 
`⏰ <b>REMINDER ALERT!</b>

📌 <b>Task:</b> ${task.task_name}
⏱ <b>Scheduled Time:</b> <code>${task.reminder_time}</code>
${recurringBadge}🆔 <b>Task ID:</b> <code>#${task.id}</code>
${recurringFooter}`;

            // Inline Buttons: "✅ Mark as Done", "⏰ Snooze 10m", "⏰ Snooze 30m"
            const inlineKeyboard = Markup.inlineKeyboard([
              [Markup.button.callback('✅ Mark as Done', `done:${task.id}`)],
              [
                Markup.button.callback('⏰ Snooze 10m', `snooze:${task.id}:10`),
                Markup.button.callback('⏰ Snooze 30m', `snooze:${task.id}:30`),
              ],
            ]);

            // Dispatch message with auto-retry
            await sendWithRetry(async () => {
              return await bot.telegram.sendMessage(task.chat_id, reminderMessage, {
                parse_mode: 'HTML',
                ...inlineKeyboard,
              });
            });

            // Mark task as notified in the database (records today's date for recurring tasks)
            await markTaskAsNotified(task.id);
            console.log(`✅ Reminder sent for Task #${task.id} (Recurring: ${task.is_recurring}) to Chat ID: ${task.chat_id}`);
          } catch (sendError) {
            console.error(`❌ Failed to send reminder for Task #${task.id}:`, sendError.message);
          }
        }
      }

      // Feature 1: Smart 15-Minute Pre-Class Alert
      try {
        const targetClassTime = getTimePlusMinutes(15, TIMEZONE);
        const todayDay = getCurrentDayOfWeek(TIMEZONE);
        const upcomingClasses = await getClassesByDayAndTime(todayDay, targetClassTime);

        if (upcomingClasses.length > 0) {
          for (const c of upcomingClasses) {
            const alertKey = `${todayDay}_${c.id}_${targetClassTime}`;
            if (!notifiedClassAlerts.has(alertKey)) {
              notifiedClassAlerts.add(alertKey);

              const time12 = formatTo12Hour(c.time);
              const alertMsg = 
`🔔 <b>CLASS ALERT: Starting in 15 Minutes!</b>

📚 <b>Subject:</b> ${c.subject}
⏰ <b>Class Time:</b> <code>${c.time}</code> (${time12})
📍 <b>Room:</b> <code>${c.room || 'N/A'}</code>

<i>Pack your bag, get your study notes ready, and don't be late! 🎓🚀</i>`;

              try {
                await sendWithRetry(async () => {
                  return await bot.telegram.sendMessage(c.chat_id, alertMsg, {
                    parse_mode: 'HTML',
                  });
                });
                console.log(`[${currentTime}] 🔔 Sent 15m pre-class alert to Chat ID ${c.chat_id} for: ${c.subject}`);
              } catch (err) {
                console.error(`❌ Failed to send 15m class alert to ${c.chat_id}:`, err.message);
              }
            }
          }
        }
      } catch (classAlertErr) {
        console.error('❌ Error checking 15m pre-class alerts:', classAlertErr.message);
      }
    } catch (dbError) {
      console.error('❌ Database error querying pending reminders:', dbError.message);
    }
  });

  // Job 2: Daily Morning Briefing & Class Schedule Alerts at 07:00 AM
  const briefingJob = cron.schedule(
    '0 7 * * *',
    async () => {
      console.log(`[07:00 AM] 🌅 Running Daily Morning Briefing, Weather & Schedule alerts in timezone: "${TIMEZONE}"...`);

      // Fetch Phnom Penh weather forecast
      const weather = await getPhnomPenhWeather();

      // Part A: Daily Tasks Briefing with Weather
      try {
        const groupedTasks = await getAllPendingTasksGroupedByChat();
        const chatIds = Object.keys(groupedTasks);

        for (const chatId of chatIds) {
          const userTasks = groupedTasks[chatId];
          const taskListText = userTasks
            .map((t, idx) => {
              const recurringLabel = t.is_recurring ? ' [🔄 Daily]' : '';
              return `${idx + 1}. ⏰ <code>[${t.reminder_time}]</code> — ${t.task_name}${recurringLabel} (<code>#${t.id}</code>)`;
            })
            .join('\n');

          const briefingMessage = 
`🌅 <b>Good Morning! Here is your Daily Task Briefing:</b>

🌤️ <b>Today's Weather (${weather.city}):</b>
${weather.summaryText}

📋 You have <b>${userTasks.length}</b> task(s) on your agenda:
${taskListText}

<i>Stay focused and have a great, productive day!</i> 🚀`;

          try {
            await sendWithRetry(async () => {
              return await bot.telegram.sendMessage(chatId, briefingMessage, {
                parse_mode: 'HTML',
              });
            });
            console.log(`✅ Morning task briefing delivered to Chat ID: ${chatId} (${userTasks.length} tasks).`);
          } catch (err) {
            console.error(`❌ Failed to deliver morning briefing to Chat ID: ${chatId}:`, err.message);
          }
        }
      } catch (err) {
        console.error('❌ Error executing morning tasks briefing:', err.message);
      }

      // Part B: Daily Class Schedule Alert for Today
      try {
        const todayDay = getCurrentDayOfWeek(TIMEZONE);
        const todaySchedules = await getAllTodaySchedulesGroupedByChat(todayDay);
        const scheduleChatIds = Object.keys(todaySchedules);

        if (scheduleChatIds.length > 0) {
          console.log(`[07:00 AM] 📚 Found class schedules for today (${todayDay}) across ${scheduleChatIds.length} users.`);

          for (const chatId of scheduleChatIds) {
            const classes = todaySchedules[chatId];
            const classListText = classes
              .map((c, idx) => {
                const time12 = formatTo12Hour(c.time);
                return `${idx + 1}. ⏰ <code>[${c.time} / ${time12}]</code> — <b>${c.subject}</b>\n   📍 Room: <code>${c.room || 'N/A'}</code>`;
              })
              .join('\n\n');

            const classAlertMessage = 
`📚 <b>Good Morning! Today's Class Schedule (${getDayName(todayDay)}):</b>

You have <b>${classes.length}</b> class(es) scheduled for today:

${classListText}

<i>Prepare your materials and have a great, successful class!</i> 🎓`;

            try {
              await sendWithRetry(async () => {
                return await bot.telegram.sendMessage(chatId, classAlertMessage, {
                  parse_mode: 'HTML',
                });
              });
              console.log(`✅ Morning class schedule sent to Chat ID: ${chatId} (${classes.length} classes).`);
            } catch (err) {
              console.error(`❌ Failed to send class schedule to Chat ID: ${chatId}:`, err.message);
            }
          }
        }
      } catch (err) {
        console.error('❌ Error executing morning class schedule alert:', err.message);
      }

      // Part C: 1-Day Before Deadline Alerts
      try {
        const tomorrowDeadlines = await getUpcomingDeadlinesAcrossUsers(1);
        if (tomorrowDeadlines.length > 0) {
          for (const d of tomorrowDeadlines) {
            const deadlineNotice = 
`⚠️ <b>DEADLINE REMINDER: Due Tomorrow!</b> ⏳

🎯 <b>Title:</b> <b>${d.title}</b>
📅 <b>Deadline Date:</b> <code>${d.deadline_date instanceof Date ? d.deadline_date.toISOString().split('T')[0] : d.deadline_date}</code>

<i>Make sure your final submissions, exam reviews, or project deliverables are complete! You got this! 🔥</i>`;

            try {
              await sendWithRetry(async () => {
                return await bot.telegram.sendMessage(d.chat_id, deadlineNotice, {
                  parse_mode: 'HTML',
                });
              });
              console.log(`✅ Sent 1-day deadline alert for "${d.title}" to Chat ID: ${d.chat_id}`);
            } catch (dErr) {
              console.error(`❌ Failed to send deadline alert to ${d.chat_id}:`, dErr.message);
            }
          }
        }
      } catch (err) {
        console.error('❌ Error executing morning deadline alerts:', err.message);
      }
    },
    {
      timezone: TIMEZONE,
    }
  );

  // Job 3: Daily Recurring Tasks Reset at 00:00 Midnight
  const midnightResetJob = cron.schedule(
    '0 0 * * *',
    async () => {
      console.log(`[00:00 Midnight] 🔄 Resetting daily recurring tasks for the new day...`);
      try {
        const resetTasks = await resetRecurringTasksForNewDay();
        notifiedClassAlerts.clear();
        console.log(`✅ Successfully reset ${resetTasks.length} recurring task(s) and cleared daily class alert cache.`);
      } catch (err) {
        console.error('❌ Failed to reset recurring tasks at midnight:', err.message);
      }
    },
    {
      timezone: TIMEZONE,
    }
  );

  return {
    reminderJob,
    briefingJob,
    midnightResetJob,
    stop() {
      reminderJob.stop();
      briefingJob.stop();
      midnightResetJob.stop();
    },
  };
}
